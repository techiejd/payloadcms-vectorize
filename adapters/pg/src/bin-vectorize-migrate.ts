import type { SanitizedConfig } from 'payload'
import { getPayload } from 'payload'
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import toSnakeCase from 'to-snake-case'

import { getVectorizedPayload } from 'payloadcms-vectorize'
import { KnowledgePoolsConfig } from './types.js'

function listMigrationFiles(migrationsDir: string) {
  return readdirSync(migrationsDir)
    .filter((f) => (f.endsWith('.ts') || f.endsWith('.js')) && f !== 'index.ts' && f !== 'index.js')
    .map((f) => ({
      name: f,
      path: join(migrationsDir, f),
      mtime: statSync(join(migrationsDir, f)).mtime,
    }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
}

/**
 * Get prior dims state from existing migrations
 */
function getPriorDimsFromMigrations(
  migrationsDir: string,
  poolNames: string[],
): Map<string, number | null> {
  const state = new Map<string, number | null>()

  // Initialize with null (unknown state)
  for (const poolName of poolNames) {
    state.set(poolName, null)
  }

  if (!existsSync(migrationsDir)) {
    return state
  }

  // Find all migration files and read them in reverse order (newest first)
  const migrationFiles = listMigrationFiles(migrationsDir)

  // Skip the most recent migration when determining prior dims, since it may contain
  // the pending dims change that we're trying to detect
  const filesToCheck = migrationFiles.slice(1)

  // Read migration files to find vector dims
  for (const file of filesToCheck) {
    try {
      const content = readFileSync(file.path, 'utf-8')

      // Extract only the UP function content to avoid matching values in DOWN function
      const upFunctionMatch = content.match(
        /export\s+async\s+function\s+up\s*\([^)]*\)[^{]*\{([\s\S]*?)(?=\}\s*(?:export\s+async\s+function\s+down|$))/i,
      )
      const upContent = upFunctionMatch ? upFunctionMatch[1] : content

      // Look for dims in vector column definition (pool-specific patterns)
      for (const poolName of poolNames) {
        const tableName = toSnakeCase(poolName)

        const pattern1 = new RegExp(
          `ALTER\\s+TABLE[^;]*?"${tableName}"[^;]*?vector\\((\\d+)\\)`,
          'is',
        )
        const pattern2 = new RegExp(
          `CREATE\\s+TABLE[^;]*?"${tableName}"[^;]*?embedding[^;]*?vector\\((\\d+)\\)`,
          'is',
        )
        const pattern3 = new RegExp(
          `"${tableName}"\\s*\\([^)]*embedding[^)]*vector\\((\\d+)\\)`,
          'is',
        )

        const match1 = upContent.match(pattern1)
        const match2 = upContent.match(pattern2)
        const match3 = upContent.match(pattern3)

        const dimsMatch = match1 || match2 || match3

        if (dimsMatch && !state.get(poolName)) {
          const dims = parseInt(dimsMatch[1], 10)
          state.set(poolName, dims)
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
 * Generate SQL code for destructive dims change (truncate table)
 */
function generateDimsChangeTruncateCode(
  tableName: string,
  schemaName: string,
  oldDims: number,
  newDims: number,
): string {
  return `  // payloadcms-vectorize: WARNING - Changing dims from ${oldDims} to ${newDims} is DESTRUCTIVE
 // All existing embeddings will be deleted. You must re-embed all documents after this migration.
 // Truncate table (destructive - all embeddings are lost)
 // Use CASCADE to handle foreign key constraints
 await db.execute(sql.raw(\`TRUNCATE TABLE "${schemaName}"."${tableName}" CASCADE\`));`
}

/**
 * Generate SQL code for down migration (restore old dims column type)
 */
function generateDimsChangeDownCode(
  tableName: string,
  schemaName: string,
  oldDims: number,
): string {
  return `  // payloadcms-vectorize: Revert column type to old dimensions
 // WARNING: Data was truncated during up migration and cannot be restored.
 // You will need to re-embed all documents after rolling back.
 await db.execute(sql.raw(\`ALTER TABLE "${schemaName}"."${tableName}" ALTER COLUMN embedding TYPE vector(${oldDims})\`));`
}

/**
 * Patch a migration file with truncate SQL for dims changes
 */
function patchMigrationFileForDimsChange(
  migrationPath: string,
  tableName: string,
  schemaName: string,
  oldDims: number,
  newDims: number,
): void {
  let content = readFileSync(migrationPath, 'utf-8')

  // Ensure sql import exists for injected sql.raw usage
  const sqlImportRegex = /import\s+\{([^}]+)\}\s+from\s+['"]@payloadcms\/db-postgres['"]/
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

  // Generate SQL code
  const truncateCode = generateDimsChangeTruncateCode(tableName, schemaName, oldDims, newDims)
  const downCode = generateDimsChangeDownCode(tableName, schemaName, oldDims)

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

  const codeToInsert = '\n' + truncateCode + '\n'
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
        const downCodeToInsert = '\n' + downCode + '\n'
        newContent = beforeDownBrace + downCodeToInsert + afterDownBrace
      }
    }
  }

  writeFileSync(migrationPath, newContent, 'utf-8')
}

/**
 * Bin script entry point for patching vector migrations with truncate for dims changes
 *
 * NOTE: As of v0.5.3, the IVFFLAT index is created automatically via afterSchemaInitHook
 * using Drizzle's extraConfig. This script is only needed when changing dims, which
 * requires truncating the embeddings table (destructive operation).
 */
export const script = async (config: SanitizedConfig): Promise<void> => {
  // Get Payload instance to access static configs via VectorizedPayload
  const getPayloadOptions = {
    config,
    // In test environment, use unique key
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

  const staticConfigs = (
    vectorizedPayload.getDbAdapterCustom() as { _staticConfigs: KnowledgePoolsConfig }
  )._staticConfigs
  if (!staticConfigs || Object.keys(staticConfigs).length === 0) {
    throw new Error('[payloadcms-vectorize] No static configs found')
  }

  const poolNames = Object.keys(staticConfigs)
  const schemaName = (payload.db as any).schemaName || 'public'

  // Get migrations directory
  const dbMigrationDir = (payload.db as any).migrationDir
  const migrationsDir = dbMigrationDir || resolve(process.cwd(), 'src/migrations')

  // Get prior dims state from migrations
  const priorDims = getPriorDimsFromMigrations(migrationsDir, poolNames)

  // Check if any dims have changed
  const dimsChanges: Array<{
    poolName: string
    tableName: string
    oldDims: number
    newDims: number
  }> = []

  for (const poolName of poolNames) {
    const currentConfig = staticConfigs[poolName]
    const priorDimsValue = priorDims.get(poolName)
    const currentDims = currentConfig.dims

    // Only flag as change if we have a prior value AND it's different
    if (priorDimsValue !== null && priorDimsValue !== undefined && priorDimsValue !== currentDims) {
      dimsChanges.push({
        poolName,
        tableName: toSnakeCase(poolName),
        oldDims: priorDimsValue as number,
        newDims: currentDims,
      })
    }
  }

  // If no dims changes detected, show deprecation message
  if (dimsChanges.length === 0) {
    console.log(
      '\n[payloadcms-vectorize] No dims changes detected. ' +
        'This script is only needed when changing dims (which requires truncating the embeddings table). ',
    )
    return
  }

  // Dims changed - we need to patch the most recent migration with TRUNCATE
  console.log('\n[payloadcms-vectorize] Detected dims changes:')
  for (const change of dimsChanges) {
    console.log(`  - ${change.poolName}: ${change.oldDims} → ${change.newDims}`)
  }
  console.log('')

  // Find the most recent migration file
  if (!existsSync(migrationsDir)) {
    throw new Error(
      `[payloadcms-vectorize] Migrations directory not found: ${migrationsDir}\n` +
        `Please run 'payload migrate:create' first to create a migration for the dims change.`,
    )
  }

  const migrationFiles = listMigrationFiles(migrationsDir)

  if (migrationFiles.length === 0) {
    throw new Error(
      `[payloadcms-vectorize] No migration files found in ${migrationsDir}\n` +
        `Please run 'payload migrate:create' first to create a migration for the dims change.`,
    )
  }

  const latestMigration = migrationFiles[0]

  // Check if migration already has truncate code
  const migrationContent = readFileSync(latestMigration.path, 'utf-8')
  if (
    migrationContent.includes('TRUNCATE TABLE') &&
    migrationContent.includes('payloadcms-vectorize')
  ) {
    console.log(
      '[payloadcms-vectorize] Migration already patched with TRUNCATE. No changes needed.',
    )
    return
  }

  // Patch the migration for each dims change
  for (const change of dimsChanges) {
    patchMigrationFileForDimsChange(
      latestMigration.path,
      change.tableName,
      schemaName,
      change.oldDims,
      change.newDims,
    )
  }

  console.log(`[payloadcms-vectorize] Migration patched successfully: ${latestMigration.name}`)
  console.log('')
  console.log('⚠️  WARNING: This migration will TRUNCATE your embeddings table(s).')
  console.log('   All existing embeddings will be deleted.')
  console.log('   After running the migration, you must re-embed all documents.')
  console.log('')

  // Only exit if not in test environment
  if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
    process.exit(0)
  }
}
