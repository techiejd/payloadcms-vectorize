import type { SanitizedConfig } from 'payload'
import { getPayload } from 'payload'
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, rmSync } from 'fs'
import { join, resolve } from 'path'
import toSnakeCase from 'to-snake-case'

import { getVectorizedPayload } from '../types.js'
import type { KnowledgePoolStaticConfig } from '../types.js'

/**
 * Get prior state from existing migrations
 */
function getPriorStateFromMigrations(
  migrationsDir: string,
  poolNames: string[],
): Map<string, { dims: number | null; ivfflatLists: number | null }> {
  const state = new Map<string, { dims: number | null; ivfflatLists: number | null }>()

  // Initialize with null (unknown state)
  for (const poolName of poolNames) {
    state.set(poolName, { dims: null, ivfflatLists: null })
  }

  if (!existsSync(migrationsDir)) {
    return state
  }

  // Find all migration files and read them in reverse order (newest first)
  // Exclude index.ts/index.js as those are not migration files
  const migrationFiles = readdirSync(migrationsDir)
    .filter((f) => (f.endsWith('.ts') || f.endsWith('.js')) && f !== 'index.ts' && f !== 'index.js')
    .map((f) => ({
      name: f,
      path: join(migrationsDir, f),
      mtime: statSync(join(migrationsDir, f)).mtime,
    }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())

  // Read migration files to find vector config
  for (const file of migrationFiles) {
    try {
      const content = readFileSync(file.path, 'utf-8')
      
      // Extract only the UP function content to avoid matching values in DOWN function
      const upFunctionMatch = content.match(
        /export\s+async\s+function\s+up\s*\([^)]*\)[^{]*\{([\s\S]*?)(?=\}\s*(?:export\s+async\s+function\s+down|$))/i,
      )
      const upContent = upFunctionMatch ? upFunctionMatch[1] : content

      // Look for IVFFLAT index creation with lists parameter
      for (const poolName of poolNames) {
        const tableName = toSnakeCase(poolName)
        const indexName = `${tableName}_embedding_ivfflat`

        const indexMatch =
          upContent.match(
            new RegExp(
              `db\\.execute\\(sql\\.raw.*?CREATE INDEX.*?"${indexName}".*?WITH\\s*\\(lists\\s*=\\s*(\\d+)\\)`,
              'is',
            ),
          ) ||
          upContent.match(
            new RegExp(`CREATE INDEX.*?"${indexName}".*?WITH\\s*\\(lists\\s*=\\s*(\\d+)\\)`, 'is'),
          ) ||
          upContent.match(
            new RegExp(`"${indexName}"[\\s\\S]*?lists\\s*=\\s*(\\d+)`, 'is'),
          )
        
        if (indexMatch && !state.get(poolName)?.ivfflatLists) {
          const lists = parseInt(indexMatch[1], 10)
          const current = state.get(poolName) || { dims: null, ivfflatLists: null }
          state.set(poolName, { ...current, ivfflatLists: lists })
        }

        // Check for dims in vector column definition (pool-specific patterns)
        const dimsMatch =
          upContent.match(
            new RegExp(`ALTER\\s+TABLE[^;]*?"${tableName}"[^;]*?vector\\((\\d+)\\)`, 'is'),
          ) ||
          upContent.match(
            new RegExp(`CREATE\\s+TABLE[^;]*?"${tableName}"[^;]*?embedding[^;]*?vector\\((\\d+)\\)`, 'is'),
          ) ||
          upContent.match(
            new RegExp(`"${tableName}"\\s*\\([^)]*embedding[^)]*vector\\((\\d+)\\)`, 'is'),
          )
        
        if (dimsMatch && !state.get(poolName)?.dims) {
          const dims = parseInt(dimsMatch[1], 10)
          const current = state.get(poolName) || { dims: null, ivfflatLists: null }
          state.set(poolName, { ...current, dims })
        }
      }
    } catch (err) {
      // Skip files that can't be read
      continue
    }
  }

  return state
}

/**
 * Generate SQL code for IVFFLAT index rebuild
 */
function generateIvfflatRebuildCode(
  tableName: string,
  schemaName: string,
  ivfflatLists: number,
): string {
  const indexName = `${tableName}_embedding_ivfflat`
  return `  await db.execute(sql.raw(\`DROP INDEX IF EXISTS "${schemaName}"."${indexName}"\`));
  await db.execute(sql.raw(\`CREATE INDEX "${indexName}" ON "${schemaName}"."${tableName}" USING ivfflat (embedding vector_cosine_ops) WITH (lists = ${ivfflatLists})\`));`
}

/**
 * Generate SQL code for column type change
 */
function generateColumnTypeChangeCode(
  tableName: string,
  schemaName: string,
  newDims: number,
): string {
  return `  // Change column type to new dimensions
  await db.execute(sql.raw(\`ALTER TABLE "${schemaName}"."${tableName}" ALTER COLUMN embedding TYPE vector(${newDims})\`));`
}

/**
 * Generate SQL code for destructive dims change
 */
function generateDimsChangeCode(
  tableName: string,
  schemaName: string,
  newDims: number,
  newIvfflatLists: number,
): string {
  const indexName = `${tableName}_embedding_ivfflat`
  return `  // WARNING: Changing vector dimensions is destructive and requires re-embedding
  // Step 1: Drop existing index
  await db.execute(sql.raw(\`DROP INDEX IF EXISTS "${schemaName}"."${indexName}"\`));
  // Step 2: Change column type (Payload migration may also generate this, but explicit is safer)
  await db.execute(sql.raw(\`ALTER TABLE "${schemaName}"."${tableName}" ALTER COLUMN embedding TYPE vector(${newDims})\`));
  // Step 3: Truncate table (destructive - all embeddings are lost)
  // Use CASCADE to handle foreign key constraints
  await db.execute(sql.raw(\`TRUNCATE TABLE "${schemaName}"."${tableName}" CASCADE\`));
  // Step 4: Recreate index with new parameters
  await db.execute(sql.raw(\`CREATE INDEX "${indexName}" ON "${schemaName}"."${tableName}" USING ivfflat (embedding vector_cosine_ops) WITH (lists = ${newIvfflatLists})\`));`
}

/**
 * Patch a migration file with vector-specific SQL
 */
function patchMigrationFile(
  migrationPath: string,
  staticConfigs: Record<string, KnowledgePoolStaticConfig>,
  schemaName: string,
  priorState: Map<string, { dims: number | null; ivfflatLists: number | null }>,
): void {
  let content = readFileSync(migrationPath, 'utf-8')

  // Ensure sql import exists for injected sql.raw usage
  const sqlImportRegex =
    /import\s+\{([^}]+)\}\s+from\s+['"]@payloadcms\/db-postgres['"]/
  const importMatch = content.match(sqlImportRegex)
  if (importMatch) {
    const imports = importMatch[1]
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
    if (!imports.includes('sql')) {
      imports.push('sql')
      const updatedImport = `import { ${imports.join(', ')} } from '@payloadcms/db-postgres'`
      content = content.replace(importMatch[0], updatedImport)
    }
  } else {
    content = `import { sql } from '@payloadcms/db-postgres'\n${content}`
  }

  // Generate SQL code for each pool
  const vectorUpCode: string[] = []
  const vectorDownCode: string[] = []

  for (const [poolName, config] of Object.entries(staticConfigs)) {
    const tableName = toSnakeCase(poolName)
    const priorConfig = priorState.get(poolName) || { dims: null, ivfflatLists: null }
    const dimsChanged = priorConfig.dims !== null && priorConfig.dims !== config.dims
    const ivfflatListsChanged =
      priorConfig.ivfflatLists !== null && priorConfig.ivfflatLists !== config.ivfflatLists

    // Check if dims changed (destructive) - handle this first as it includes index operations
    if (dimsChanged) {
      vectorUpCode.push(
        `  // payloadcms-vectorize: WARNING - Changing dims from ${priorConfig.dims} to ${config.dims} is destructive`,
      )
      // When dims changes, we need to:
      // 1. Drop existing index first
      // 2. Change column type (Payload migration may also generate this)
      // 3. Truncate table (destructive)
      // 4. Recreate index with new ivfflatLists
      vectorUpCode.push(
        generateDimsChangeCode(tableName, schemaName, config.dims, config.ivfflatLists),
      )
      // Down migration: restore to previous state (but can't restore data)
      vectorDownCode.push(
        `  // payloadcms-vectorize: Revert dims change (WARNING: data was truncated and cannot be restored)`,
      )
      // Restore previous column type and index
      vectorDownCode.push(
        generateColumnTypeChangeCode(tableName, schemaName, priorConfig.dims || config.dims),
      )
      vectorDownCode.push(
        generateIvfflatRebuildCode(
          tableName,
          schemaName,
          priorConfig.ivfflatLists || config.ivfflatLists,
        ),
      )
      vectorDownCode.push(`  // WARNING: Original data cannot be restored`)
    } else if (ivfflatListsChanged) {
      // Check if ivfflatLists changed (only if dims didn't change, since dims change handles index)
      vectorUpCode.push(
        `  // payloadcms-vectorize: Rebuild IVFFLAT index for ${poolName} with lists=${config.ivfflatLists}`,
      )
      vectorUpCode.push(generateIvfflatRebuildCode(tableName, schemaName, config.ivfflatLists))
      // Down migration: rebuild with old lists
      vectorDownCode.push(
        `  // payloadcms-vectorize: Revert IVFFLAT index for ${poolName} to lists=${priorConfig.ivfflatLists}`,
      )
      vectorDownCode.push(
        generateIvfflatRebuildCode(
          tableName,
          schemaName,
          priorConfig.ivfflatLists || config.ivfflatLists,
        ),
      )
    } else if (priorConfig.ivfflatLists === null) {
      // First migration - ensure index exists (only if dims/ivfflatLists didn't change above)
      // Note: Column is handled by Drizzle schema via afterSchemaInit
      vectorUpCode.push(`  // payloadcms-vectorize: Initial IVFFLAT index setup for ${poolName}`)
      vectorUpCode.push(
        `  // Note: Embedding column is created via Drizzle schema (afterSchemaInit hook)`,
      )
      vectorUpCode.push(generateIvfflatRebuildCode(tableName, schemaName, config.ivfflatLists))
      vectorDownCode.push(`  // payloadcms-vectorize: Drop index on rollback`)
      const indexName = `${tableName}_embedding_ivfflat`
      vectorDownCode.push(
        `  await db.execute(sql.raw(\`DROP INDEX IF EXISTS "${schemaName}"."${indexName}"\`));`,
      )
    }
  }

  if (vectorUpCode.length === 0) {
    // No changes needed
    return
  }

  // Find the up function and insert code before the closing brace
  const upFunctionMatch = content.match(
    /export\s+async\s+function\s+up\s*\([^)]*\)\s*:\s*Promise<void>\s*\{/i,
  )
  if (!upFunctionMatch) {
    throw new Error(`Could not find 'up' function in migration file: ${migrationPath}`)
  }

  const upFunctionStart = upFunctionMatch.index! + upFunctionMatch[0].length
  const downFunctionMatch = content.match(/export\s+async\s+function\s+down\s*\([^)]*\)/i)
  const searchEnd = downFunctionMatch ? downFunctionMatch.index! : content.length

  // Find the last closing brace before down function or end
  const upFunctionBody = content.substring(upFunctionStart, searchEnd)
  const lastBraceIndex = upFunctionBody.lastIndexOf('}')
  if (lastBraceIndex === -1) {
    throw new Error(
      `Could not find closing brace for 'up' function in migration file: ${migrationPath}`,
    )
  }

  // Insert our code before the closing brace
  const beforeBrace = content.substring(0, upFunctionStart + lastBraceIndex)
  const afterBrace = content.substring(upFunctionStart + lastBraceIndex)

  const codeToInsert = '\n' + vectorUpCode.join('\n') + '\n'
  let newContent = beforeBrace + codeToInsert + afterBrace

  // Handle down function
  if (downFunctionMatch) {
    const downFunctionStart = downFunctionMatch.index! + downFunctionMatch[0].length
    const downBraceMatch = newContent.substring(downFunctionStart).match(/\{/)
    if (downBraceMatch) {
      const downBodyStart = downFunctionStart + downBraceMatch.index! + 1
      const downBody = newContent.substring(downBodyStart)
      const downLastBraceIndex = downBody.lastIndexOf('}')
      if (downLastBraceIndex !== -1) {
        const beforeDownBrace = newContent.substring(0, downBodyStart + downLastBraceIndex)
        const afterDownBrace = newContent.substring(downBodyStart + downLastBraceIndex)
        const downCodeToInsert = '\n' + vectorDownCode.join('\n') + '\n'
        newContent = beforeDownBrace + downCodeToInsert + afterDownBrace
      }
    }
  } else if (vectorDownCode.length > 0) {
    // Add down function if it doesn't exist
    const lastFileBrace = newContent.lastIndexOf('}')
    if (lastFileBrace !== -1) {
      const beforeLastBrace = newContent.substring(0, lastFileBrace)
      const afterLastBrace = newContent.substring(lastFileBrace)
      const downFunctionCode = `\n\nexport async function down({ payload, req }: { payload: any; req: any }): Promise<void> {\n${vectorDownCode.join('\n')}\n}`
      newContent = beforeLastBrace + downFunctionCode + afterLastBrace
    }
  }

  writeFileSync(migrationPath, newContent, 'utf-8')
}

/**
 * Bin script entry point for creating vector migrations
 */
export const script = async (config: SanitizedConfig): Promise<void> => {
  const logPatchedSuccessfully = () =>
    console.log('[payloadcms-vectorize] Migration patched successfully!')

  // Get Payload instance for db operations and to access static configs via VectorizedPayload
  const getPayloadOptions = {
    config,
    // In test environment, use unique key and enable cron for job processing
    ...(process.env.TEST_ENV ? { key: `vectorize-migrate-${Date.now()}` } : {}),
  }

  const payload = await getPayload(getPayloadOptions)

  // Get static configs from VectorizedPayload
  const vectorizedPayload = getVectorizedPayload(payload)
  if (!vectorizedPayload) {
    throw new Error(
      '[payloadcms-vectorize] Vectorize plugin not found. Ensure payloadcmsVectorize is configured in your Payload config.',
    )
  }

  const staticConfigs = vectorizedPayload._staticConfigs
  if (!staticConfigs || Object.keys(staticConfigs).length === 0) {
    throw new Error('[payloadcms-vectorize] No static configs found')
  }

  const poolNames = Object.keys(staticConfigs)
  const schemaName = (payload.db as any).schemaName || 'public'
  
  // Get migrations directory
  const dbMigrationDir = (payload.db as any).migrationDir
  const migrationsDir = dbMigrationDir || resolve(process.cwd(), 'src/migrations')

  // Get prior state from migrations
  const priorState = getPriorStateFromMigrations(migrationsDir, poolNames)

  // Check if any changes are needed
  let hasChanges = false
  let isFirstMigration = false
  for (const [poolName, currentConfig] of Object.entries(staticConfigs)) {
    const prior = priorState.get(poolName) || { dims: null, ivfflatLists: null }
    
    // Check if this is the first migration (no IVFFLAT index exists yet)
    if (prior.ivfflatLists === null) {
      isFirstMigration = true
      hasChanges = true
      break
    }
    
    // Check for actual changes
    if (
      prior.dims !== null && prior.dims !== currentConfig.dims ||
      (prior.ivfflatLists !== null && prior.ivfflatLists !== currentConfig.ivfflatLists)
    ) {
      hasChanges = true
      break
    }
  }

  // If no changes detected
  if (!hasChanges) {
    console.log('[payloadcms-vectorize] No configuration changes detected.')
    return
  }
  
  // Determine if there are actual schema changes (dims change) or just index parameter changes (ivfflatLists)
  let hasSchemaChanges = false
  for (const [poolName, currentConfig] of Object.entries(staticConfigs)) {
    const prior = priorState.get(poolName) || { dims: null, ivfflatLists: null }
    if (prior.dims !== null && prior.dims !== currentConfig.dims) {
      hasSchemaChanges = true
      break
    }
  }
  
  if (isFirstMigration) {
    // Check if there's a very recent migration file (created in last 10 seconds) that we should patch
    const recentMigrations = existsSync(migrationsDir)
      ? readdirSync(migrationsDir)
          .filter(
            (f) => (f.endsWith('.ts') || f.endsWith('.js')) && f !== 'index.ts' && f !== 'index.js',
          )
          .map((f) => ({
            name: f,
            path: join(migrationsDir, f),
            mtime: statSync(join(migrationsDir, f)).mtime,
          }))
          .filter((m) => Date.now() - m.mtime.getTime() < 10000) // Created in last 10 seconds
          .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
      : []
    
    if (recentMigrations.length > 0) {
      const recentMigration = recentMigrations[0]
      // Check if it already has IVFFLAT index code
      const recentContent = readFileSync(recentMigration.path, 'utf-8')
      const hasIvfflatCode = recentContent.includes('ivfflat') && (recentContent.includes('drizzle.execute') || recentContent.includes('CREATE INDEX'))
      
      if (!hasIvfflatCode) {
        patchMigrationFile(recentMigration.path, staticConfigs, schemaName, priorState)
        logPatchedSuccessfully()
        return
      }
    }
  }

  // Create migration using Payload's API OR create manually for index-only changes
  // Note: createMigration may not return the path, so we'll find the newest migration file after creation
  const migrationsBefore = existsSync(migrationsDir)
    ? readdirSync(migrationsDir)
        .filter(
          (f) => (f.endsWith('.ts') || f.endsWith('.js')) && f !== 'index.ts' && f !== 'index.js',
        )
        .map((f) => ({
          name: f,
          path: join(migrationsDir, f),
          mtime: statSync(join(migrationsDir, f)).mtime,
        }))
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
    : []

  let migrationPath: string

  // If there are schema changes (dims changed), use Payload's createMigration
  // Otherwise (only ivfflatLists changed), create the migration file manually
  if (hasSchemaChanges) {
    await payload.db.createMigration({
      migrationName: 'vectorize-config',
      payload,
      forceAcceptWarning: true,
    })

    // Find the newest migration file (should be the one just created)
    const migrationsAfter = existsSync(migrationsDir)
      ? readdirSync(migrationsDir)
          .filter(
            (f) => (f.endsWith('.ts') || f.endsWith('.js')) && f !== 'index.ts' && f !== 'index.js',
          )
          .map((f) => ({
            name: f,
            path: join(migrationsDir, f),
            mtime: statSync(join(migrationsDir, f)).mtime,
          }))
          .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
      : []

    // Find the migration that was just created (newest that wasn't there before)
    const beforePaths = new Set(migrationsBefore.map((m) => m.path))
    const newMigrations = migrationsAfter.filter((m) => !beforePaths.has(m.path))
    const foundPath = newMigrations.length > 0 ? newMigrations[0].path : migrationsAfter[0]?.path

    if (!foundPath) {
      throw new Error(
        '[payloadcms-vectorize] Failed to create migration file - no new migration found.',
      )
    }
    migrationPath = foundPath
  } else {
    // No schema changes (only ivfflatLists changed) - create migration file manually
    const now = new Date()
    const timestamp = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
      '_',
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0'),
      String(now.getSeconds()).padStart(2, '0'),
    ].join('')
    
    const migrationFileName = `${timestamp}_vectorize_ivfflat_rebuild.ts`
    migrationPath = join(migrationsDir, migrationFileName)
    
    const migrationTemplate = `import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  // Index parameter changes only - no schema changes
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  // Revert index parameter changes
}
`
    
    writeFileSync(migrationPath, migrationTemplate, 'utf-8')
  }

  // Patch the migration file
  patchMigrationFile(migrationPath, staticConfigs, schemaName, priorState)
  logPatchedSuccessfully()

  // Only exit if not in test environment (when called from tests, just return)
  if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
    process.exit(0)
  }
}
