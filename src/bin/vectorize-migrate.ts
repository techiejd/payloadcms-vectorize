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

  console.log(`[payloadcms-vectorize] Found ${migrationFiles.length} migration file(s) to scan for prior state`)

  // Read migration files to find vector config
  for (const file of migrationFiles) {
    try {
      const content = readFileSync(file.path, 'utf-8')
      
      // Extract only the UP function content to avoid matching values in DOWN function
      // The DOWN function contains previous/rollback values which we don't want
      const upFunctionMatch = content.match(
        /export\s+async\s+function\s+up\s*\([^)]*\)[^{]*\{([\s\S]*?)(?=\}\s*(?:export\s+async\s+function\s+down|$))/i,
      )
      const upContent = upFunctionMatch ? upFunctionMatch[1] : content

      // Look for IVFFLAT index creation with lists parameter
      for (const poolName of poolNames) {
        const tableName = toSnakeCase(poolName)
        const indexName = `${tableName}_embedding_ivfflat`

        // Check if this migration creates the index (only in UP function)
        // The code format is: await db.execute(sql.raw(`CREATE INDEX "indexName" ... WITH (lists = 10)`))
        // We need to match the lists parameter in the template literal
        // Use non-greedy .*? to match the FIRST occurrence
        const indexMatch =
          // Match: db.execute(sql.raw(`...CREATE INDEX..."indexName"...WITH (lists = 10)...`))
          upContent.match(
            new RegExp(
              `db\\.execute\\(sql\\.raw.*?CREATE INDEX.*?"${indexName}".*?WITH\\s*\\(lists\\s*=\\s*(\\d+)\\)`,
              'is',
            ),
          ) ||
          // Match: CREATE INDEX "indexName" ... WITH (lists = 10) (in any context)
          upContent.match(
            new RegExp(`CREATE INDEX.*?"${indexName}".*?WITH\\s*\\(lists\\s*=\\s*(\\d+)\\)`, 'is'),
          ) ||
          // Match: lists = <number> near ivfflat (non-greedy)
          upContent.match(new RegExp(`ivfflat.*?lists\\s*=\\s*(\\d+)`, 'is'))
        
        if (indexMatch && !state.get(poolName)?.ivfflatLists) {
          const lists = parseInt(indexMatch[1], 10)
          const current = state.get(poolName) || { dims: null, ivfflatLists: null }
          state.set(poolName, { ...current, ivfflatLists: lists })
          console.log(
            `[payloadcms-vectorize] Found prior ivfflatLists=${lists} for pool "${poolName}" in ${file.name}`,
          )
        } else if (!state.get(poolName)?.ivfflatLists) {
          // Debug: log if we didn't find it
          console.log(
            `[payloadcms-vectorize] No ivfflatLists found for pool "${poolName}" in ${file.name}`,
          )
        }

        // Check for dims in vector column definition (search full content as dims should be consistent)
        const dimsMatch = content.match(new RegExp(`vector\\((\\d+)\\)`, 'i'))
        if (dimsMatch && !state.get(poolName)?.dims) {
          const dims = parseInt(dimsMatch[1], 10)
          const current = state.get(poolName) || { dims: null, ivfflatLists: null }
          state.set(poolName, { ...current, dims })
          console.log(
            `[payloadcms-vectorize] Found prior dims=${dims} for pool "${poolName}" in ${file.name}`,
          )
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
  console.log(`[vectorize-migrate] Reading migration file: ${migrationPath}`)
  const content = readFileSync(migrationPath, 'utf-8')
  console.log(`[vectorize-migrate] File read successfully, length: ${content.length} characters`)

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
    }

    // If this is the first migration, ensure index exists
    // Note: Column is handled by Drizzle schema via afterSchemaInit
    // We only check ivfflatLists because dims will always be found from Drizzle schema
    if (priorConfig.ivfflatLists === null) {
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
    console.error(
      `[vectorize-migrate] Could not find 'up' function in migration file: ${migrationPath}`,
    )
    console.error(`[vectorize-migrate] File content length: ${content.length} characters`)
    console.error(`[vectorize-migrate] File content (first 1000 chars):`)
    console.error(content.substring(0, 1000))
    console.error(`[vectorize-migrate] File content (last 1000 chars):`)
    console.error(content.substring(Math.max(0, content.length - 1000)))
    console.error(
      `[vectorize-migrate] Searching for pattern: /export\\s+async\\s+function\\s+up\\s*\\([^)]*\\)\\s*:\\s*Promise<void>\\s*\\{/i`,
    )
    throw new Error(`Could not find 'up' function in migration file: ${migrationPath}`)
  }

  const upFunctionStart = upFunctionMatch.index! + upFunctionMatch[0].length
  const downFunctionMatch = content.match(/export\s+async\s+function\s+down\s*\([^)]*\)/i)
  const searchEnd = downFunctionMatch ? downFunctionMatch.index! : content.length

  // Find the last closing brace before down function or end
  const upFunctionBody = content.substring(upFunctionStart, searchEnd)
  const lastBraceIndex = upFunctionBody.lastIndexOf('}')
  console.log(`[vectorize-migrate] up function body length: ${upFunctionBody.length}`)
  console.log(`[vectorize-migrate] lastBraceIndex in body: ${lastBraceIndex}`)
  console.log(`[vectorize-migrate] up function body ends with: ${upFunctionBody.substring(Math.max(0, upFunctionBody.length - 200))}`)
  if (lastBraceIndex === -1) {
    throw new Error(
      `Could not find closing brace for 'up' function in migration file: ${migrationPath}`,
    )
  }

  // Insert our code before the closing brace
  const beforeBrace = content.substring(0, upFunctionStart + lastBraceIndex)
  const afterBrace = content.substring(upFunctionStart + lastBraceIndex)
  console.log(`[vectorize-migrate] Insertion point: beforeBrace ends with: ${beforeBrace.substring(Math.max(0, beforeBrace.length - 100))}`)
  console.log(`[vectorize-migrate] Insertion point: afterBrace starts with: ${afterBrace.substring(0, 100)}`)

  const codeToInsert = '\n' + vectorUpCode.join('\n') + '\n'
  console.log(`[vectorize-migrate] Inserting ${vectorUpCode.length} line(s) of code into migration`)
  console.log(`[vectorize-migrate] Code to insert:\n${codeToInsert}`)
  let newContent = beforeBrace + codeToInsert + afterBrace
  console.log(`[vectorize-migrate] Migration file will be ${newContent.length} characters after patching (was ${content.length})`)
  
  // Verify insertion point looks correct
  const insertionPointPreview = newContent.substring(
    Math.max(0, beforeBrace.length - 50),
    Math.min(newContent.length, beforeBrace.length + codeToInsert.length + 50),
  )
  console.log(`[vectorize-migrate] Insertion point preview:\n${insertionPointPreview}`)

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
  console.log(`[vectorize-migrate] Migration file written successfully`)
  // Verify the code was inserted
  const verifyContent = readFileSync(migrationPath, 'utf-8')
  const hasIvfflatCode = verifyContent.includes('ivfflat') && verifyContent.includes('lists =')
  console.log(`[vectorize-migrate] Verification: migration contains IVFFLAT code: ${hasIvfflatCode}`)
  if (!hasIvfflatCode && vectorUpCode.length > 0) {
    console.error(`[vectorize-migrate] WARNING: IVFFLAT code was supposed to be inserted but not found in file!`)
    console.error(`[vectorize-migrate] Expected to find: ${vectorUpCode.join(' | ')}`)
  }
}

/**
 * Bin script entry point for creating vector migrations
 */
export const script = async (config: SanitizedConfig): Promise<void> => {
  // Use a unique key to ensure we get a fresh Payload instance with the correct config
  // This is important when running in tests or when the config has been modified
  const payload = await getPayload({
    config,
    key: `vectorize-migrate-${Date.now()}`,
  })
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
  
  // Get migrations directory - the postgres adapter stores it on payload.db.migrationDir
  // but this may be set to default before config is applied. Try multiple sources.
  const dbMigrationDir = (payload.db as any).migrationDir
  
  // Debug: log migration directory detection
  console.log('[payloadcms-vectorize] Debug: payload.db.migrationDir =', dbMigrationDir)
  
  // Use the payload.db.migrationDir - this is where Payload stores the resolved path
  const migrationsDir = dbMigrationDir || resolve(process.cwd(), 'src/migrations')
  console.log('[payloadcms-vectorize] Using migrations directory:', migrationsDir)

  console.log('[payloadcms-vectorize] Checking for configuration changes...')

  // Get prior state from migrations
  const priorState = getPriorStateFromMigrations(migrationsDir, poolNames)
  
  // Debug: log prior state
  console.log('[payloadcms-vectorize] Prior state from migrations:')
  for (const [poolName, state] of priorState.entries()) {
    console.log(`[payloadcms-vectorize]   ${poolName}: dims=${state.dims}, ivfflatLists=${state.ivfflatLists}`)
  }
  console.log('[payloadcms-vectorize] Current static configs:')
  for (const [poolName, config] of Object.entries(staticConfigs)) {
    console.log(`[payloadcms-vectorize]   ${poolName}: dims=${config.dims}, ivfflatLists=${config.ivfflatLists}`)
  }

  // Check if any changes are needed
  let hasChanges = false
  let isFirstMigration = false
  for (const [poolName, currentConfig] of Object.entries(staticConfigs)) {
    const prior = priorState.get(poolName) || { dims: null, ivfflatLists: null }
    
    // Check if this is the first migration (no IVFFLAT index exists yet)
    // Note: dims might be found from Drizzle schema, but ivfflatLists won't be found until we create the index
    if (prior.ivfflatLists === null) {
      isFirstMigration = true
      hasChanges = true
      console.log(
        `[payloadcms-vectorize] First migration detected for pool "${poolName}" (ivfflatLists not found in prior migrations)`,
      )
      break
    }
    
    // Check for actual changes
    if (
      prior.dims !== null && prior.dims !== currentConfig.dims ||
      (prior.ivfflatLists !== null && prior.ivfflatLists !== currentConfig.ivfflatLists)
    ) {
      hasChanges = true
      console.log(
        `[payloadcms-vectorize] Change detected for pool "${poolName}": dims ${prior.dims}→${currentConfig.dims}, ivfflatLists ${prior.ivfflatLists}→${currentConfig.ivfflatLists}`,
      )
      break
    }
  }

  // If no changes detected, check if artifacts exist (idempotency)
  if (!hasChanges) {
    console.log('[payloadcms-vectorize] No configuration changes detected.')
    console.log(
      '[payloadcms-vectorize] If this is the first migration, ensure your initial migration creates the embedding columns via Drizzle schema.',
    )
    return
  }

  console.log('[payloadcms-vectorize] Changes detected.')
  
  // Determine if there are actual schema changes (dims change) or just index parameter changes (ivfflatLists)
  // payload.db.createMigration only works when there are schema changes
  // For index-only changes, we need to create the migration file manually
  let hasSchemaChanges = false
  for (const [poolName, currentConfig] of Object.entries(staticConfigs)) {
    const prior = priorState.get(poolName) || { dims: null, ivfflatLists: null }
    if (prior.dims !== null && prior.dims !== currentConfig.dims) {
      hasSchemaChanges = true
      console.log(`[payloadcms-vectorize] Schema change detected for pool "${poolName}": dims ${prior.dims}→${currentConfig.dims}`)
      break
    }
  }
  
  if (isFirstMigration) {
    console.log('[payloadcms-vectorize] This is the first migration - checking if we should patch existing migration or create new one')
    
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
      console.log(`[payloadcms-vectorize] Found recent migration to patch: ${recentMigration.name}`)
      // Check if it already has IVFFLAT index code
      const recentContent = readFileSync(recentMigration.path, 'utf-8')
      const hasIvfflatCode = recentContent.includes('ivfflat') && (recentContent.includes('drizzle.execute') || recentContent.includes('CREATE INDEX'))
      
      if (!hasIvfflatCode) {
        console.log(`[payloadcms-vectorize] Patching existing migration: ${recentMigration.path}`)
        patchMigrationFile(recentMigration.path, staticConfigs, schemaName, priorState)
        console.log('[payloadcms-vectorize] Migration patched successfully!')
        return
      } else {
        console.log(`[payloadcms-vectorize] Recent migration already has IVFFLAT code, creating new migration instead`)
      }
    }
    
    console.log('[payloadcms-vectorize] Creating new migration with IVFFLAT index setup')
  } else {
    console.log('[payloadcms-vectorize] Creating new migration for configuration change')
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
  // because Payload's createMigration hangs when there are no schema changes to detect
  if (hasSchemaChanges) {
    console.log('[payloadcms-vectorize] Schema changes detected - using payload.db.createMigration...')
    try {
      await payload.db.createMigration({
        migrationName: 'vectorize-config',
        payload,
      })
      console.log('[payloadcms-vectorize] Migration created successfully')
    } catch (error) {
      console.error('[payloadcms-vectorize] Error creating migration:', error)
      throw error
    }

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
    // Payload's createMigration API doesn't support this case (it hangs when no schema changes detected)
    console.log('[payloadcms-vectorize] No schema changes (only index parameter changes) - creating migration file manually...')
    
    // Generate timestamp for migration filename (format: YYYYMMDD_HHMMSS)
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
    
    // Create a minimal migration file that we'll patch with our IVFFLAT code
    const migrationTemplate = `import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  // Index parameter changes only - no schema changes
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  // Revert index parameter changes
}
`
    
    writeFileSync(migrationPath, migrationTemplate, 'utf-8')
    console.log(`[payloadcms-vectorize] Created migration file: ${migrationPath}`)
  }

  console.log(`[payloadcms-vectorize] Patching migration: ${migrationPath}`)

  // Patch the migration file
  patchMigrationFile(migrationPath, staticConfigs, schemaName, priorState)

  console.log('[payloadcms-vectorize] Migration created and patched successfully!')
  console.log(
    '[payloadcms-vectorize] Review the migration file and apply it with: pnpm payload migrate',
  )

  // Only exit if not in test environment (when called from tests, just return)
  if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
    process.exit(0)
  }
}
