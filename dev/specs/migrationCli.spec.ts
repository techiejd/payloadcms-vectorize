import type { Payload, SanitizedConfig } from 'payload'
import { beforeAll, describe, expect, test, afterAll } from 'vitest'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { buildConfig, getPayload } from 'payload'
import { createVectorizeIntegration } from 'payloadcms-vectorize'
import { makeDummyEmbedDocs, makeDummyEmbedQuery, testEmbeddingVersion } from '../helpers/embed.js'
import { createTestDb } from './utils.js'
import { DIMS } from './constants.js'
import type { PostgresPayload } from '../../src/types.js'
import { script as vectorizeMigrateScript } from '../../src/bin/vectorize-migrate.js'
import { readdirSync, statSync, existsSync, readFileSync, rmSync } from 'fs'
import { join, resolve } from 'path'

describe('Migration CLI integration tests', () => {
  describe('VectorizedPayload access', () => {
    let payload: Payload
    const dbName = `migration_cli_test_${Date.now()}`

    beforeAll(async () => {
      await createTestDb({ dbName })

      const integration = createVectorizeIntegration({
        default: {
          dims: DIMS,
          ivfflatLists: 10,
        },
      })

      const config = await buildConfig({
        secret: 'test-secret',
        collections: [
          {
            slug: 'posts',
            fields: [{ name: 'title', type: 'text' }],
          },
        ],
        db: postgresAdapter({
          extensions: ['vector'],
          afterSchemaInit: [integration.afterSchemaInitHook],
          pool: {
            connectionString: `postgresql://postgres:password@localhost:5433/${dbName}`,
          },
        }),
        plugins: [
          integration.payloadcmsVectorize({
            knowledgePools: {
              default: {
                collections: {
                  posts: {
                    toKnowledgePool: async (doc) => [{ chunk: doc.title || '' }],
                  },
                },
                embeddingConfig: {
                  version: testEmbeddingVersion,
                  queryFn: makeDummyEmbedQuery(DIMS),
                  realTimeIngestionFn: makeDummyEmbedDocs(DIMS),
                },
              },
            },
          }),
        ],
        jobs: {
          tasks: [],
          autoRun: [
            {
              cron: '*/5 * * * * *',
              limit: 10,
            },
          ],
        },
      })

      payload = await getPayload({ config, cron: true })
    })

    test('VectorizedPayload has _staticConfigs', async () => {
      const { getVectorizedPayload } = await import('payloadcms-vectorize')
      const vectorizedPayload = getVectorizedPayload(payload)

      expect(vectorizedPayload).toBeTruthy()
      expect(vectorizedPayload?._staticConfigs).toBeDefined()
      expect(vectorizedPayload?._staticConfigs.default).toBeDefined()
      expect(vectorizedPayload?._staticConfigs.default.dims).toBe(DIMS)
      expect(vectorizedPayload?._staticConfigs.default.ivfflatLists).toBe(10)
    })
  })

  describe('Error handling when migrations not run', () => {
    let payload: Payload
    const dbName = `migration_error_test_${Date.now()}`

    beforeAll(async () => {
      await createTestDb({ dbName })

      const integration = createVectorizeIntegration({
        default: {
          dims: DIMS,
          ivfflatLists: 10,
        },
      })

      const config = await buildConfig({
        secret: 'test-secret',
        collections: [
          {
            slug: 'posts',
            fields: [{ name: 'title', type: 'text' }],
          },
        ],
        db: postgresAdapter({
          extensions: ['vector'],
          afterSchemaInit: [integration.afterSchemaInitHook],
          pool: {
            connectionString: `postgresql://postgres:password@localhost:5433/${dbName}`,
          },
          // Don't push schema changes - we want to test without migrations
          push: false,
        }),
        plugins: [
          integration.payloadcmsVectorize({
            knowledgePools: {
              default: {
                collections: {
                  posts: {
                    toKnowledgePool: async (doc) => [{ chunk: doc.title || '' }],
                  },
                },
                embeddingConfig: {
                  version: testEmbeddingVersion,
                  queryFn: makeDummyEmbedQuery(DIMS),
                  realTimeIngestionFn: makeDummyEmbedDocs(DIMS),
                },
              },
            },
          }),
        ],
        jobs: {
          tasks: [],
          autoRun: [
            {
              cron: '*/5 * * * * *',
              limit: 10,
            },
          ],
        },
      })

      payload = await getPayload({
        config,
        cron: false, // Disable cron to avoid background jobs
        key: `migration-error-test-${Date.now()}`,
      })
    })

    test('vector search fails with descriptive error when embedding column missing', async () => {
      const { getVectorizedPayload } = await import('payloadcms-vectorize')
      const vectorizedPayload = getVectorizedPayload(payload)

      // Vector search should fail with a descriptive error
      await expect(
        vectorizedPayload?.search({
          knowledgePool: 'default',
          query: 'test query',
          limit: 10,
        }),
      ).rejects.toThrow()
    })

    test('creating document fails when embedding table does not exist', async () => {
      // Try to create a document that would trigger vectorization
      // This should fail because the embedding table doesn't exist
      await expect(
        payload.create({
          collection: 'posts',
          data: {
            title: 'Test Post',
          },
        }),
      ).rejects.toThrow()
    })
  })

  describe('CLI workflow (sequential)', () => {
    const cliDbName = `migration_cli_e2e_test_${Date.now()}`
    let cliPayload: Payload
    let cliConfig: SanitizedConfig
    const migrationsDir = resolve(process.cwd(), 'dev', 'test-migrations-cli')

    beforeAll(async () => {
      await createTestDb({ dbName: cliDbName })

      // Clean up any existing migrations directory to ensure clean state
      if (existsSync(migrationsDir)) {
        rmSync(migrationsDir, { recursive: true, force: true })
      }

      // Create test migrations directory
      const { mkdirSync } = await import('fs')
      mkdirSync(migrationsDir, { recursive: true })
    })

    afterAll(async () => {
      // Cleanup: remove test migrations directory
      if (existsSync(migrationsDir)) {
        rmSync(migrationsDir, { recursive: true, force: true })
      }
    })

    test('1. Initial setup: create migration with IVFFLAT index', async () => {
      // Step 1: Create integration with initial config
      const integration = createVectorizeIntegration({
        default: {
          dims: DIMS,
          ivfflatLists: 10, // Initial lists parameter
        },
      })

      cliConfig = await buildConfig({
        secret: 'test-secret',
        collections: [
          {
            slug: 'posts',
            fields: [{ name: 'title', type: 'text' }],
          },
        ],
        db: postgresAdapter({
          extensions: ['vector'],
          afterSchemaInit: [integration.afterSchemaInitHook],
          migrationDir: migrationsDir,
          pool: {
            connectionString: `postgresql://postgres:password@localhost:5433/${cliDbName}`,
          },
        }),
        plugins: [
          integration.payloadcmsVectorize({
            knowledgePools: {
              default: {
                collections: {
                  posts: {
                    toKnowledgePool: async (doc) => [{ chunk: doc.title || '' }],
                  },
                },
                embeddingConfig: {
                  version: testEmbeddingVersion,
                  queryFn: makeDummyEmbedQuery(DIMS),
                  realTimeIngestionFn: makeDummyEmbedDocs(DIMS),
                },
              },
            },
          }),
        ],
        jobs: {
          tasks: [],
          autoRun: [
            {
              cron: '*\/5 * * * * *',
              limit: 10,
            },
          ],
        },
      })

      // Get payload instance
      cliPayload = await getPayload({
        config: cliConfig,
        cron: true,
        key: `migration-cli-test-${Date.now()}`,
      })

      // Step 2: Create initial migration (this will include the embedding column via Drizzle)
      console.log('[TEST] Step 2: Creating initial migration...')
      await cliPayload.db.createMigration({
        migrationName: 'initial',
        payload: cliPayload,
      })
      console.log('[TEST] Step 2.5: Initial migration created')

      // Step 3: Run vectorize:migrate to add IVFFLAT index to the migration
      console.log('[TEST] Step 3: Running vectorize:migrate...')
      await vectorizeMigrateScript(cliConfig)

      // Debug: Print all files in migrations directory
      console.log('[TEST] Step 3.5: Listing all files in migrations directory:')
      const allFiles = readdirSync(migrationsDir)
      for (const file of allFiles) {
        const filePath = join(migrationsDir, file)
        const stats = statSync(filePath)
        console.log(
          `[TEST]   - ${file} (${stats.size} bytes, modified: ${stats.mtime.toISOString()})`,
        )
        if (file.endsWith('.ts') && file !== 'index.ts') {
          const content = readFileSync(filePath, 'utf-8')
          console.log(`[TEST]     Content preview (first 500 chars): ${content.substring(0, 500)}`)
          console.log(
            `[TEST]     Contains 'up' function: ${content.includes('export async function up')}`,
          )
          console.log(`[TEST]     Contains 'CREATE INDEX': ${content.includes('CREATE INDEX')}`)
          console.log(`[TEST]     Contains 'ivfflat': ${content.includes('ivfflat')}`)
          console.log(`[TEST]     Contains 'lists =': ${content.includes('lists =')}`)
          console.log(
            `[TEST]     Contains 'default_embedding_ivfflat': ${content.includes('default_embedding_ivfflat')}`,
          )
          // Show the last 1000 chars where our code should be
          console.log(
            `[TEST]     Content preview (last 1000 chars): ${content.substring(Math.max(0, content.length - 1000))}`,
          )
        }
      }

      // Step 4: Apply the migration
      console.log('[TEST] Step 4: Applying migration...')
      try {
        // Try using db.migrate() if it exists (internal API)
        if (typeof (cliPayload.db as any).migrate === 'function') {
          console.log('[TEST] Step 4.1: Using db.migrate() method')
          await (cliPayload.db as any).migrate()
        } else {
          // Fallback: manually load and execute migration files
          console.log(
            '[TEST] Step 4.1: db.migrate() not available, using manual migration execution',
          )
          const migrationFiles = readdirSync(migrationsDir)
            .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
            .sort()

          for (const file of migrationFiles) {
            const migrationPath = join(migrationsDir, file)
            console.log(`[TEST] Step 4.2: Loading migration: ${file}`)
            const migration = await import(migrationPath)
            if (migration.up) {
              console.log(`[TEST] Step 4.3: Executing up() for ${file}`)
              await migration.up({ db: cliPayload.db.drizzle, payload: cliPayload, req: {} as any })
            }
          }
        }
        console.log('[TEST] Step 4.5: Migration applied')
      } catch (error) {
        console.error('[TEST] Step 4.5: Migration failed with error:', error)
        throw error
      }

      // Step 4.55: Check database directly to see if index exists
      const postgresPayloadCheck = cliPayload as PostgresPayload
      const schemaNameCheck = postgresPayloadCheck.db.schemaName || 'public'
      const indexNameCheck = 'default_embedding_ivfflat'
      try {
        const directIndexCheck = await postgresPayloadCheck.db.pool?.query(
          `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname = $2`,
          [schemaNameCheck, indexNameCheck],
        )
        console.log(
          `[TEST] Step 4.55: Direct database check - index exists: ${(directIndexCheck?.rows.length || 0) > 0}`,
        )
        if (directIndexCheck?.rows.length === 0) {
          console.log(`[TEST] Step 4.55: WARNING - Index not found in database after migration!`)
          // List all indexes on the default table
          const allIndexes = await postgresPayloadCheck.db.pool?.query(
            `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'default'`,
            [schemaNameCheck],
          )
          console.log(
            `[TEST] Step 4.55: All indexes on 'default' table: ${allIndexes?.rows.map((r: any) => r.indexname).join(', ') || 'none'}`,
          )
        }
      } catch (error) {
        console.error('[TEST] Step 4.55: Error checking database:', error)
      }

      // Step 4.6: Verify the migration file actually contains the IVFFLAT code
      const allMigrationsAfter = readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
        .map((f) => ({
          name: f,
          path: join(migrationsDir, f),
          mtime: statSync(join(migrationsDir, f)).mtime,
        }))
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
      const latestMigrationFile = allMigrationsAfter[0]?.path
      if (latestMigrationFile) {
        const migrationFileAfterApply = readFileSync(latestMigrationFile, 'utf-8')
        console.log(`[TEST] Step 4.6: Checking migration file after apply: ${latestMigrationFile}`)
        console.log(
          `[TEST]   File contains 'ivfflat': ${migrationFileAfterApply.includes('ivfflat')}`,
        )
        console.log(
          `[TEST]   File contains 'lists = 10': ${migrationFileAfterApply.includes('lists = 10')}`,
        )
        console.log(
          `[TEST]   File contains 'drizzle.execute': ${migrationFileAfterApply.includes('drizzle.execute')}`,
        )
        // Find the IVFFLAT code section
        const ivfflatMatch = migrationFileAfterApply.match(/ivfflat[\s\S]{0,500}/i)
        if (ivfflatMatch) {
          console.log(`[TEST]   IVFFLAT code section: ${ivfflatMatch[0]}`)
        }
        // Show the end of the up function where our code should be
        const upFunctionEnd = migrationFileAfterApply.lastIndexOf('export async function up')
        if (upFunctionEnd !== -1) {
          const upFunctionContent = migrationFileAfterApply.substring(upFunctionEnd)
          const last500OfUp = upFunctionContent.substring(
            Math.max(0, upFunctionContent.length - 500),
          )
          console.log(`[TEST]   Last 500 chars of up function: ${last500OfUp}`)
        }
      }

      // Step 5: Verify index exists with correct lists parameter
      const postgresPayload = cliPayload as PostgresPayload
      const schemaName = postgresPayload.db.schemaName || 'public'
      const tableName = 'default'
      const indexName = `${tableName}_embedding_ivfflat`

      const indexCheck = await postgresPayload.db.pool?.query(
        `SELECT pg_get_indexdef(c.oid) as def
       FROM pg_indexes i
       JOIN pg_class c ON c.relname = i.indexname
       JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = i.schemaname
       WHERE i.schemaname = $1 AND i.tablename = $2 AND i.indexname = $3`,
        [schemaName, tableName, indexName],
      )
      const indexDef = indexCheck?.rows[0]?.def || ''
      console.log(`[TEST] Step 5.5: Index definition: ${indexDef}`)
      expect(indexDef).toBeTruthy()
      // PostgreSQL returns lists='10' (with quotes), so match either format
      expect(indexDef).toMatch(/lists\s*=\s*['"]?10['"]?/i)
      console.log('[TEST] Test 1 completed successfully')
    })

    test('2. Change ivfflatLists: CLI creates migration, apply and verify', async () => {
      // Step 1: Recreate integration with changed ivfflatLists
      const integration = createVectorizeIntegration({
        default: {
          dims: DIMS,
          ivfflatLists: 20, // Changed from 10 to 20
        },
      })

      // Update config with new integration (this simulates changing static config in payload.config.ts)
      cliConfig = await buildConfig({
        secret: 'test-secret',
        collections: [
          {
            slug: 'posts',
            fields: [{ name: 'title', type: 'text' }],
          },
        ],
        db: postgresAdapter({
          extensions: ['vector'],
          afterSchemaInit: [integration.afterSchemaInitHook],
          migrationDir: migrationsDir,
          pool: {
            connectionString: `postgresql://postgres:password@localhost:5433/${cliDbName}`,
          },
        }),
        plugins: [
          integration.payloadcmsVectorize({
            knowledgePools: {
              default: {
                collections: {
                  posts: {
                    toKnowledgePool: async (doc) => [{ chunk: doc.title || '' }],
                  },
                },
                embeddingConfig: {
                  version: testEmbeddingVersion,
                  queryFn: makeDummyEmbedQuery(DIMS),
                  realTimeIngestionFn: makeDummyEmbedDocs(DIMS),
                },
              },
            },
          }),
        ],
        jobs: {
          tasks: [],
          autoRun: [
            {
              cron: '*\/5 * * * * *',
              limit: 10,
            },
          ],
        },
      })

      // Get payload instance
      cliPayload = await getPayload({
        config: cliConfig,
        cron: true,
        key: `migration-cli-test-${Date.now()}`,
      })

      // Step 2: Run vectorize:migrate (should detect change and create migration)
      console.log('[TEST] Step 2: Running vectorize:migrate...')
      const migrateScriptStart = Date.now()
      try {
        await Promise.race([
          vectorizeMigrateScript(cliConfig),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('vectorize:migrate timed out after 30s')), 30000),
          ),
        ])
        const migrateScriptEnd = Date.now()
        console.log(
          `[TEST] Step 2.5: vectorize:migrate completed in ${migrateScriptEnd - migrateScriptStart}ms`,
        )
      } catch (error) {
        console.error('[TEST] Step 2.5: vectorize:migrate failed:', error)
        throw error
      }

      // Step 3: Verify migration file was created and contains correct SQL
      console.log('[TEST] Step 3: Listing all files in migrations directory:')
      const allFiles = readdirSync(migrationsDir)
      for (const file of allFiles) {
        const filePath = join(migrationsDir, file)
        const stats = statSync(filePath)
        console.log(
          `[TEST]   - ${file} (${stats.size} bytes, modified: ${stats.mtime.toISOString()})`,
        )
      }

      const migrations = readdirSync(migrationsDir)
        .filter(
          (f) => (f.endsWith('.ts') || f.endsWith('.js')) && f !== 'index.ts' && f !== 'index.js',
        )
        .map((f) => ({
          name: f,
          path: join(migrationsDir, f),
          mtime: statSync(join(migrationsDir, f)).mtime,
        }))
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())

      console.log(`[TEST] Found ${migrations.length} migration files (excluding index.ts/js)`)
      migrations.forEach((m, i) => {
        console.log(`[TEST]   ${i + 1}. ${m.name} (${m.mtime.toISOString()})`)
      })

      const newestMigration = migrations[0]
      expect(newestMigration).toBeTruthy()
      console.log(`[TEST] Reading migration file: ${newestMigration.path}`)

      // Verify migration file contains IVFFLAT rebuild SQL
      const migrationContent = readFileSync(newestMigration.path, 'utf-8')
      console.log(`[TEST] Migration file content length: ${migrationContent.length} characters`)
      console.log(
        `[TEST] Migration file preview (first 1000 chars):\n${migrationContent.substring(0, 1000)}`,
      )
      // PostgreSQL returns lists='20' (with quotes), so match either format
      expect(migrationContent).toMatch(/lists\s*=\s*['"]?20['"]?/i)
      expect(migrationContent).toContain('DROP INDEX')
      expect(migrationContent).toContain('CREATE INDEX')

      // Step 4: Apply the migration
      if (typeof (cliPayload.db as any).migrate === 'function') {
        await (cliPayload.db as any).migrate()
      } else {
        // Fallback: manually load and execute migration files
        const migrationFiles = readdirSync(migrationsDir)
          .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
          .sort()

        for (const file of migrationFiles) {
          const migrationPath = join(migrationsDir, file)
          const migration = await import(migrationPath)
          if (migration.up) {
            await migration.up({ db: cliPayload.db.drizzle, payload: cliPayload, req: {} as any })
          }
        }
      }

      // Step 5: Verify index was rebuilt with new lists parameter
      const postgresPayload = cliPayload as PostgresPayload
      const schemaName = postgresPayload.db.schemaName || 'public'
      const tableName = 'default'
      const indexName = `${tableName}_embedding_ivfflat`

      const indexCheck = await postgresPayload.db.pool?.query(
        `SELECT pg_get_indexdef(c.oid) as def
       FROM pg_indexes i
       JOIN pg_class c ON c.relname = i.indexname
       JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = i.schemaname
       WHERE i.schemaname = $1 AND i.tablename = $2 AND i.indexname = $3`,
        [schemaName, tableName, indexName],
      )
      const indexDef = indexCheck?.rows[0]?.def || ''
      expect(indexDef).toBeTruthy()
      // PostgreSQL returns lists='20' (with quotes), so match either format
      expect(indexDef).toMatch(/lists\s*=\s*['"]?20['"]?/i)
    })

    test('3. Idempotency: CLI does not create duplicate migration when config unchanged', async () => {
      // Get migration count before
      const migrationsBefore = readdirSync(migrationsDir).filter(
        (f) => f.endsWith('.ts') || f.endsWith('.js'),
      ).length

      // Run vectorize:migrate again (config hasn't changed)
      console.log('[TEST] Running vectorize:migrate for idempotency check...')
      const startTime = Date.now()
      try {
        await Promise.race([
          vectorizeMigrateScript(cliConfig),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('vectorize:migrate timed out after 30s')), 30000),
          ),
        ])
        const endTime = Date.now()
        console.log(`[TEST] vectorize:migrate completed in ${endTime - startTime}ms`)
      } catch (error) {
        console.error('[TEST] vectorize:migrate failed:', error)
        throw error
      }

      // Verify no new migration was created
      const migrationsAfter = readdirSync(migrationsDir).filter(
        (f) => f.endsWith('.ts') || f.endsWith('.js'),
      ).length

      expect(migrationsAfter).toBe(migrationsBefore)
    })

    test('4. Change dims: CLI creates destructive migration', async () => {
      console.log('[TEST] Starting test 4: Change dims')
      const NEW_DIMS = DIMS + 2 // Change dimensions (destructive)
      console.log(`[TEST] NEW_DIMS: ${NEW_DIMS}`)

      // Step 1: Recreate integration with changed dims
      console.log('[TEST] Step 1: Creating integration with changed dims...')
      const integration = createVectorizeIntegration({
        default: {
          dims: NEW_DIMS, // Changed dimensions
          ivfflatLists: 20, // Keep same lists
        },
      })

      // Update config with new integration
      cliConfig = await buildConfig({
        secret: 'test-secret',
        collections: [
          {
            slug: 'posts',
            fields: [{ name: 'title', type: 'text' }],
          },
        ],
        db: postgresAdapter({
          extensions: ['vector'],
          afterSchemaInit: [integration.afterSchemaInitHook],
          migrationDir: migrationsDir,
          pool: {
            connectionString: `postgresql://postgres:password@localhost:5433/${cliDbName}`,
          },
        }),
        plugins: [
          integration.payloadcmsVectorize({
            knowledgePools: {
              default: {
                collections: {
                  posts: {
                    toKnowledgePool: async (doc) => [{ chunk: doc.title || '' }],
                  },
                },
                embeddingConfig: {
                  version: testEmbeddingVersion,
                  queryFn: makeDummyEmbedQuery(NEW_DIMS),
                  realTimeIngestionFn: makeDummyEmbedDocs(NEW_DIMS),
                },
              },
            },
          }),
        ],
        jobs: {
          tasks: [],
          autoRun: [
            {
              cron: '*\/5 * * * * *',
              limit: 10,
            },
          ],
        },
      })

      // Get payload instance
      cliPayload = await getPayload({
        config: cliConfig,
        cron: true,
        key: `migration-cli-test-${Date.now()}`,
      })

      // Step 2: Run vectorize:migrate (should detect dims change)
      console.log('[TEST] Step 2: Running vectorize:migrate...')
      await vectorizeMigrateScript(cliConfig)
      console.log('[TEST] Step 2.5: vectorize:migrate completed')

      // Step 3: Verify migration file contains destructive SQL (truncate + column type change)
      console.log('[TEST] Step 3: Listing all files in migrations directory:')
      const allFiles = readdirSync(migrationsDir)
      for (const file of allFiles) {
        const filePath = join(migrationsDir, file)
        const stats = statSync(filePath)
        console.log(
          `[TEST]   - ${file} (${stats.size} bytes, modified: ${stats.mtime.toISOString()})`,
        )
      }

      const migrations = readdirSync(migrationsDir)
        .filter(
          (f) => (f.endsWith('.ts') || f.endsWith('.js')) && f !== 'index.ts' && f !== 'index.js',
        )
        .map((f) => ({
          name: f,
          path: join(migrationsDir, f),
          mtime: statSync(join(migrationsDir, f)).mtime,
        }))
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())

      console.log(`[TEST] Found ${migrations.length} migration files (excluding index.ts/js)`)
      const newestMigration = migrations[0]
      console.log(`[TEST] Reading newest migration: ${newestMigration.path}`)
      const migrationContent = readFileSync(newestMigration.path, 'utf-8')
      console.log(`[TEST] Migration content length: ${migrationContent.length} characters`)
      console.log(
        `[TEST] Migration content preview (first 1000 chars):\n${migrationContent.substring(0, 1000)}`,
      )

      // Verify it contains dims change SQL
      expect(migrationContent).toContain('Changing dims')
      expect(migrationContent).toContain('TRUNCATE TABLE')
      expect(migrationContent).toContain(`vector(${NEW_DIMS})`)
      expect(migrationContent).toContain('ALTER COLUMN embedding TYPE')
      console.log('[TEST] Step 3.5: Migration file verification passed')

      // Step 4: Apply the migration
      console.log('[TEST] Step 4: Applying migration...')
      console.log('[TEST] Step 4.1: About to call cliPayload.db.migrate()...')
      console.log('[TEST] Step 4.1.1: Migration directory:', migrationsDir)
      console.log(
        '[TEST] Step 4.1.2: Payload instance migrationDir:',
        (cliPayload.db as any).migrationDir,
      )
      try {
        const migrateStart = Date.now()
        console.log('[TEST] Step 4.1.3: Calling migrate() at', new Date().toISOString())
        if (typeof (cliPayload.db as any).migrate === 'function') {
          await (cliPayload.db as any).migrate()
        } else {
          // Fallback: manually load and execute migration files
          const migrationFiles = readdirSync(migrationsDir)
            .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
            .sort()

          for (const file of migrationFiles) {
            const migrationPath = join(migrationsDir, file)
            const migration = await import(migrationPath)
            if (migration.up) {
              await migration.up({ db: cliPayload.db.drizzle, payload: cliPayload, req: {} as any })
            }
          }
        }
        const migrateEnd = Date.now()
        console.log(
          `[TEST] Step 4.2: cliPayload.db.migrate() completed in ${migrateEnd - migrateStart}ms`,
        )
      } catch (error) {
        console.error('[TEST] Step 4.2: Error during migration:', error)
        throw error
      }
      console.log('[TEST] Step 4.5: Migration applied successfully')

      // Step 5: Verify column type changed and table was truncated
      console.log('[TEST] Step 5: Verifying column type and table state...')
      const postgresPayload = cliPayload as PostgresPayload
      const schemaName = postgresPayload.db.schemaName || 'public'
      const tableName = 'default'

      // Check column type
      const columnCheck = await postgresPayload.db.pool?.query(
        `SELECT format_type(atttypid, atttypmod) as column_type
       FROM pg_attribute 
       JOIN pg_class ON pg_attribute.attrelid = pg_class.oid
       JOIN pg_namespace ON pg_class.relnamespace = pg_namespace.oid
       WHERE pg_namespace.nspname = $1 
         AND pg_class.relname = $2 
         AND pg_attribute.attname = 'embedding'
         AND pg_attribute.attnum > 0
         AND NOT pg_attribute.attisdropped`,
        [schemaName, tableName],
      )
      const columnType = columnCheck?.rows[0]?.column_type || ''
      expect(columnType).toContain(`vector(${NEW_DIMS})`)

      // Verify table was truncated (should be empty or have no embeddings)
      console.log('[TEST] Step 5.5: Checking table row count...')
      const countCheck = await postgresPayload.db.pool?.query(
        `SELECT COUNT(*) as count FROM "${schemaName}"."${tableName}"`,
      )
      const rowCount = parseInt(countCheck?.rows[0]?.count || '0', 10)
      console.log(`[TEST] Table row count: ${rowCount}`)
      // Table should be empty after truncate (unless new embeddings were created during test)
      expect(rowCount).toBe(0)
      console.log('[TEST] Test 4 completed successfully')
    })

    test('5. Add new knowledgePool: CLI creates migration for new table', async () => {
      console.log('[TEST] Starting test 5: Add new knowledgePool')

      // Step 1: Create integration with an additional knowledgePool "secondary"
      const integrationWithSecondary = createVectorizeIntegration({
        default: {
          dims: 10, // Keep same dims as test 4
          ivfflatLists: 20, // Keep same lists as test 4
        },
        secondary: {
          dims: DIMS,
          ivfflatLists: 5,
        },
      })

      cliConfig = await buildConfig({
        secret: 'test-secret',
        collections: [
          {
            slug: 'posts',
            fields: [{ name: 'title', type: 'text' }],
          },
          {
            slug: 'articles',
            fields: [{ name: 'content', type: 'text' }],
          },
        ],
        db: postgresAdapter({
          extensions: ['vector'],
          afterSchemaInit: [integrationWithSecondary.afterSchemaInitHook],
          migrationDir: migrationsDir,
          push: false,
          pool: {
            connectionString: `postgresql://postgres:password@localhost:5433/${cliDbName}`,
          },
        }),
        plugins: [
          integrationWithSecondary.payloadcmsVectorize({
            knowledgePools: {
              default: {
                collections: {
                  posts: {
                    toKnowledgePool: async (doc) => [{ chunk: doc.title || '' }],
                  },
                },
                embeddingConfig: {
                  version: testEmbeddingVersion,
                  queryFn: makeDummyEmbedQuery(10),
                  realTimeIngestionFn: makeDummyEmbedDocs(10),
                },
              },
              secondary: {
                collections: {
                  articles: {
                    toKnowledgePool: async (doc: any) => [{ chunk: doc.content || '' }],
                  },
                } as any,
                embeddingConfig: {
                  version: testEmbeddingVersion,
                  queryFn: makeDummyEmbedQuery(DIMS),
                  realTimeIngestionFn: makeDummyEmbedDocs(DIMS),
                },
              },
            },
          }),
        ],
        jobs: {
          tasks: [],
          autoRun: [
            {
              cron: '*/5 * * * * *',
              limit: 10,
            },
          ],
        },
      })

      // Get new payload instance
      cliPayload = await getPayload({
        config: cliConfig,
        cron: true,
        key: `migration-cli-test-5-${Date.now()}`,
      })

      // Step 2: Create migration for new table
      console.log('[TEST] Step 2: Creating migration for new knowledgePool...')
      try {
        await cliPayload.db.createMigration({
          migrationName: 'add_secondary_pool',
          payload: cliPayload,
          forceAcceptWarning: true, // Skip prompts in tests
        })
        console.log('[TEST] Step 2.5: Migration created')
      } catch (e) {
        console.error('[TEST] Step 2 ERROR - createMigration failed:', e)
        throw e
      }

      // Step 3: Run vectorize:migrate to add IVFFLAT index for new pool
      console.log('[TEST] Step 3: Running vectorize:migrate...')
      try {
        await vectorizeMigrateScript(cliConfig)
        console.log('[TEST] Step 3.5: vectorize:migrate completed')
      } catch (e) {
        console.error('[TEST] Step 3 ERROR - vectorize:migrate failed:', e)
        throw e
      }

      // Step 4: Verify migration file contains secondary table creation and IVFFLAT index
      const migrations = readdirSync(migrationsDir)
        .filter(
          (f) => (f.endsWith('.ts') || f.endsWith('.js')) && f !== 'index.ts' && f !== 'index.js',
        )
        .map((f) => ({
          name: f,
          path: join(migrationsDir, f),
          mtime: statSync(join(migrationsDir, f)).mtime,
        }))
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())

      const newestMigration = migrations[0]
      console.log(`[TEST] Step 4: Checking newest migration: ${newestMigration.name}`)
      const migrationContent = readFileSync(newestMigration.path, 'utf-8')

      // Should contain secondary table creation
      expect(migrationContent).toContain('secondary')
      // Should contain IVFFLAT index for secondary pool
      expect(migrationContent).toContain('secondary_embedding_ivfflat')
      console.log('[TEST] Step 4.5: Migration file verification passed')

      // Step 5: Apply the migration
      console.log('[TEST] Step 5: Applying migration...')
      try {
        await (cliPayload.db as any).migrate({ forceAcceptWarning: true })
        console.log('[TEST] Step 5.5: Migration applied')
      } catch (e) {
        console.error('[TEST] Step 5 ERROR - migrate failed:', e)
        throw e
      }

      // Step 6: Verify new table exists with IVFFLAT index
      const postgresPayload = cliPayload as PostgresPayload
      const schemaName = postgresPayload.db.schemaName || 'public'

      // Check table exists
      const tableCheck = await postgresPayload.db.pool?.query(
        `SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = $1 AND table_name = 'secondary'
        )`,
        [schemaName],
      )
      expect(tableCheck?.rows[0]?.exists).toBe(true)
      console.log('[TEST] Step 6: Secondary table exists')

      // Check IVFFLAT index exists
      const indexCheck = await postgresPayload.db.pool?.query(
        `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname = $2`,
        [schemaName, 'secondary_embedding_ivfflat'],
      )
      expect(indexCheck?.rows.length).toBeGreaterThan(0)
      console.log('[TEST] Step 6.5: Secondary IVFFLAT index exists')
      console.log('[TEST] Test 5 completed successfully')
    })

    test('6. Remove knowledgePool: Secondary table can be dropped manually', async () => {
      console.log('[TEST] Starting test 6: Remove knowledgePool')

      // Note: Payload's migration system doesn't automatically generate DROP TABLE 
      // migrations when collections are removed. Users need to manually drop tables.
      // This test verifies that after removing a pool, the vectorize plugin handles
      // it gracefully and the table can be dropped manually.

      // Step 1: Create integration with only 'default' pool (removing 'secondary')
      const integrationWithoutSecondary = createVectorizeIntegration({
        default: {
          dims: 10,
          ivfflatLists: 20,
        },
      })

      cliConfig = await buildConfig({
        secret: 'test-secret',
        collections: [
          {
            slug: 'posts',
            fields: [{ name: 'title', type: 'text' }],
          },
        ],
        db: postgresAdapter({
          extensions: ['vector'],
          afterSchemaInit: [integrationWithoutSecondary.afterSchemaInitHook],
          migrationDir: migrationsDir,
          push: false,
          pool: {
            connectionString: `postgresql://postgres:password@localhost:5433/${cliDbName}`,
          },
        }),
        plugins: [
          integrationWithoutSecondary.payloadcmsVectorize({
            knowledgePools: {
              default: {
                collections: {
                  posts: {
                    toKnowledgePool: async (doc) => [{ chunk: doc.title || '' }],
                  },
                },
                embeddingConfig: {
                  version: testEmbeddingVersion,
                  queryFn: makeDummyEmbedQuery(10),
                  realTimeIngestionFn: makeDummyEmbedDocs(10),
                },
              },
            },
          }),
        ],
        jobs: {
          tasks: [],
          autoRun: [
            {
              cron: '*/5 * * * * *',
              limit: 10,
            },
          ],
        },
      })

      // Get new payload instance
      cliPayload = await getPayload({
        config: cliConfig,
        cron: true,
        key: `migration-cli-test-6-${Date.now()}`,
      })

      // Step 2: Run vectorize:migrate - should detect no changes for default pool
      // and not error out because secondary is no longer in config
      console.log('[TEST] Step 2: Running vectorize:migrate with secondary pool removed...')
      await vectorizeMigrateScript(cliConfig)
      console.log('[TEST] Step 2.5: vectorize:migrate completed (no changes expected)')

      // Step 3: Verify secondary table still exists (Payload doesn't auto-drop)
      const postgresPayload = cliPayload as PostgresPayload
      const schemaName = postgresPayload.db.schemaName || 'public'

      const tableCheck = await postgresPayload.db.pool?.query(
        `SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = $1 AND table_name = 'secondary'
        )`,
        [schemaName],
      )
      // Table should still exist since Payload doesn't auto-drop tables
      expect(tableCheck?.rows[0]?.exists).toBe(true)
      console.log('[TEST] Step 3: Secondary table still exists (as expected - manual drop required)')

      // Step 4: Manually drop the secondary table and its index
      console.log('[TEST] Step 4: Manually dropping secondary table...')
      await postgresPayload.db.pool?.query(
        `DROP INDEX IF EXISTS "${schemaName}"."secondary_embedding_ivfflat"`,
      )
      await postgresPayload.db.pool?.query(`DROP TABLE IF EXISTS "${schemaName}"."secondary" CASCADE`)
      console.log('[TEST] Step 4.5: Secondary table dropped')

      // Step 5: Verify secondary table no longer exists
      const tableCheckAfter = await postgresPayload.db.pool?.query(
        `SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = $1 AND table_name = 'secondary'
        )`,
        [schemaName],
      )
      expect(tableCheckAfter?.rows[0]?.exists).toBe(false)
      console.log('[TEST] Step 5: Secondary table no longer exists')
      console.log('[TEST] Test 6 completed successfully')
    })
  })
})
