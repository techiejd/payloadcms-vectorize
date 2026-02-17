import type { Payload, SanitizedConfig } from 'payload'
import { beforeAll, describe, expect, test, afterAll, vi } from 'vitest'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { buildConfig, getPayload } from 'payload'
import { createPostgresVectorIntegration } from '../../src/index.js'
import { makeDummyEmbedDocs, makeDummyEmbedQuery, testEmbeddingVersion } from '@shared-test/helpers/embed'
import { createTestDb } from './utils.js'
import { DIMS } from './constants.js'

const createVectorizeIntegration = createPostgresVectorIntegration
import payloadcmsVectorize from 'payloadcms-vectorize'
import type { PostgresPayload } from '../../src/types.js'
import { script as vectorizeMigrateScript } from '../../src/bin-vectorize-migrate.js'
import { readdirSync, statSync, existsSync, readFileSync, writeFileSync, rmSync } from 'fs'
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
          payloadcmsVectorize({
          dbAdapter: integration.adapter,
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

    test('VectorizedPayload has _staticConfigs via getDbAdapterCustom', async () => {
      const { getVectorizedPayload } = await import('payloadcms-vectorize')
      const vectorizedPayload = getVectorizedPayload(payload)

      expect(vectorizedPayload).toBeTruthy()
      const adapterCustom = vectorizedPayload?.getDbAdapterCustom()
      expect(adapterCustom).toBeDefined()
      expect(adapterCustom?._staticConfigs).toBeDefined()
      expect(adapterCustom?._staticConfigs.default).toBeDefined()
      expect(adapterCustom?._staticConfigs.default.dims).toBe(DIMS)
      expect(adapterCustom?._staticConfigs.default.ivfflatLists).toBe(10)
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
          payloadcmsVectorize({
          dbAdapter: integration.adapter,
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

  describe('Automatic IVFFLAT index creation', () => {
    const autoDbName = `migration_auto_test_${Date.now()}`
    let autoPayload: Payload
    let autoConfig: SanitizedConfig
    const migrationsDir = resolve(process.cwd(), 'dev', 'test-migrations-auto')

    beforeAll(async () => {
      await createTestDb({ dbName: autoDbName })

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

    test('1. IVFFLAT index is created automatically via afterSchemaInitHook', async () => {
      // Create integration
      const integration = createVectorizeIntegration({
        default: {
          dims: DIMS,
          ivfflatLists: 10,
        },
      })

      autoConfig = await buildConfig({
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
            connectionString: `postgresql://postgres:password@localhost:5433/${autoDbName}`,
          },
        }),
        plugins: [
          payloadcmsVectorize({
          dbAdapter: integration.adapter,
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

      autoPayload = await getPayload({
        config: autoConfig,
        cron: true,
        key: `migration-auto-test-${Date.now()}`,
      })

      // Create initial migration - Drizzle should include the IVFFLAT index automatically
      await autoPayload.db.createMigration({
        migrationName: 'initial',
        payload: autoPayload,
      })

      // Apply the migration
      await autoPayload.db.migrate()

      // Verify index exists with correct lists parameter
      const postgresPayload = autoPayload as PostgresPayload
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
      // PostgreSQL returns lists='10' (with quotes), so match either format
      expect(indexDef).toMatch(/lists\s*=\s*['"]?10['"]?/i)
    })

    test('2. Changing ivfflatLists is handled automatically by Drizzle', async () => {
      // Recreate integration with changed ivfflatLists
      const integration = createVectorizeIntegration({
        default: {
          dims: DIMS,
          ivfflatLists: 20, // Changed from 10 to 20
        },
      })

      autoConfig = await buildConfig({
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
            connectionString: `postgresql://postgres:password@localhost:5433/${autoDbName}`,
          },
        }),
        plugins: [
          payloadcmsVectorize({
          dbAdapter: integration.adapter,
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

      autoPayload = await getPayload({
        config: autoConfig,
        cron: true,
        key: `migration-auto-test-2-${Date.now()}`,
      })

      // Create migration for ivfflatLists change - Drizzle should handle it automatically
      await autoPayload.db.createMigration({
        migrationName: 'change_ivfflat_lists',
        payload: autoPayload,
        forceAcceptWarning: true,
      })

      // Apply the migration
      await autoPayload.db.migrate()

      // Verify index was rebuilt with new lists parameter
      const postgresPayload = autoPayload as PostgresPayload
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
      expect(indexDef).toMatch(/lists\s*=\s*['"]?20['"]?/i)
    })

    test('3. vectorize:migrate shows deprecation message when no dims changes', async () => {
      // Running vectorize:migrate should show deprecation message since only ivfflatLists changed
      // (and that's now handled automatically)
      const consoleSpy = vi.spyOn(console, 'log')

      await vectorizeMigrateScript(autoConfig)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'No dims changes detected. This script is only needed when changing dims (which requires truncating the embeddings table).',
        ),
      )

      consoleSpy.mockRestore()
    })
  })

  describe('Dims change workflow (sequential)', () => {
    const dimsDbName = `migration_dims_test_${Date.now()}`
    let dimsPayload: Payload
    let dimsConfig: SanitizedConfig
    const migrationsDir = resolve(process.cwd(), 'dev', 'test-migrations-dims')

    beforeAll(async () => {
      await createTestDb({ dbName: dimsDbName })

      // Clean up any existing migrations directory
      if (existsSync(migrationsDir)) {
        rmSync(migrationsDir, { recursive: true, force: true })
      }

      const { mkdirSync } = await import('fs')
      mkdirSync(migrationsDir, { recursive: true })
    })

    afterAll(async () => {
      if (existsSync(migrationsDir)) {
        rmSync(migrationsDir, { recursive: true, force: true })
      }
    })

    test('1. Setup initial schema with dims', async () => {
      const integration = createVectorizeIntegration({
        default: {
          dims: DIMS,
          ivfflatLists: 10,
        },
      })

      dimsConfig = await buildConfig({
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
            connectionString: `postgresql://postgres:password@localhost:5433/${dimsDbName}`,
          },
        }),
        plugins: [
          payloadcmsVectorize({
          dbAdapter: integration.adapter,
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

      dimsPayload = await getPayload({
        config: dimsConfig,
        cron: true,
        key: `migration-dims-test-${Date.now()}`,
      })

      // Create and apply initial migration
      await dimsPayload.db.createMigration({
        migrationName: 'initial',
        payload: dimsPayload,
      })

      await dimsPayload.db.migrate()

      // Verify initial dims
      const postgresPayload = dimsPayload as PostgresPayload
      const schemaName = postgresPayload.db.schemaName || 'public'
      const tableName = 'default'

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
      expect(columnType).toContain(`vector(${DIMS})`)
    })

    test('2. Change dims: CLI patches migration with TRUNCATE and adds sql import', async () => {
      const NEW_DIMS = DIMS + 2 // Change dimensions (destructive)

      const integration = createVectorizeIntegration({
        default: {
          dims: NEW_DIMS,
          ivfflatLists: 10,
        },
      })

      dimsConfig = await buildConfig({
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
            connectionString: `postgresql://postgres:password@localhost:5433/${dimsDbName}`,
          },
        }),
        plugins: [
          payloadcmsVectorize({
          dbAdapter: integration.adapter,
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
              cron: '*/5 * * * * *',
              limit: 10,
            },
          ],
        },
      })

      dimsPayload = await getPayload({
        config: dimsConfig,
        cron: true,
        key: `migration-dims-test-2-${Date.now()}`,
      })

      // Create migration for dims change
      await dimsPayload.db.createMigration({
        migrationName: 'change_dims',
        payload: dimsPayload,
        forceAcceptWarning: true,
      })

      // Get the migration file path before patching
      const migrationsBeforePatch = readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
        .map((f) => ({
          name: f,
          path: join(migrationsDir, f),
          mtime: statSync(join(migrationsDir, f)).mtime,
        }))
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())

      const migrationPath = migrationsBeforePatch[0]?.path
      expect(migrationPath).toBeTruthy()

      // Remove sql from the import line to test that vectorize:migrate adds it back
      if (migrationPath) {
        const migrationContent = readFileSync(migrationPath, 'utf-8')
        const importMatch = migrationContent.match(
          /import\s+\{([^}]+)\}\s+from\s+['"]@payloadcms\/db-postgres['"]/,
        )
        if (importMatch) {
          const imports = importMatch[1]
            .split(',')
            .map((part) => part.trim())
            .filter((part) => part && part !== 'sql')
          const updatedImport = `import { ${imports.join(', ')} } from '@payloadcms/db-postgres'`
          const updatedContent = migrationContent.replace(importMatch[0], updatedImport)
          writeFileSync(migrationPath, updatedContent, 'utf-8')
        }
      }

      // Run vectorize:migrate to add TRUNCATE
      await vectorizeMigrateScript(dimsConfig)

      // Verify migration file contains TRUNCATE SQL and sql import was added
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
      const migrationContent = readFileSync(newestMigration.path, 'utf-8')

      // Verify sql import was added back
      expect(migrationContent).toMatch(
        /import\s+\{[^}]*\bsql\b[^}]*\}\s+from\s+['"]@payloadcms\/db-postgres['"]/,
      )

      // Verify it contains dims change SQL
      expect(migrationContent).toContain('TRUNCATE TABLE')
      expect(migrationContent).toContain('payloadcms-vectorize')
      expect(migrationContent).toContain('DESTRUCTIVE')

      // Verify down migration contains ALTER COLUMN to restore old dims
      expect(migrationContent).toContain(`vector(${DIMS})`)

      // Apply the migration
      await dimsPayload.db.migrate()

      // Verify column type changed
      const postgresPayload = dimsPayload as PostgresPayload
      const schemaName = postgresPayload.db.schemaName || 'public'
      const tableName = 'default'

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

      // Verify table was truncated (should be empty)
      const countCheck = await postgresPayload.db.pool?.query(
        `SELECT COUNT(*) as count FROM "${schemaName}"."${tableName}"`,
      )
      const rowCount = parseInt(countCheck?.rows[0]?.count || '0', 10)
      expect(rowCount).toBe(0)
    })

    test('3. Idempotency: CLI does not create new migration if no dims changes', async () => {
      // Get migration count before
      const migrationsBefore = readdirSync(migrationsDir).filter(
        (f) => f.endsWith('.ts') || f.endsWith('.js'),
      ).length

      // Running again should not create new migration or modify existing one
      const consoleSpy = vi.spyOn(console, 'log')

      await vectorizeMigrateScript(dimsConfig)

      // Should see "already patched" message since the migration was already patched in test 2
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Migration already patched with TRUNCATE'),
      )

      consoleSpy.mockRestore()

      // Verify no new migration was created
      const migrationsAfter = readdirSync(migrationsDir).filter(
        (f) => f.endsWith('.ts') || f.endsWith('.js'),
      ).length

      expect(migrationsAfter).toBe(migrationsBefore)
    })
  })

  describe('Multiple knowledge pools', () => {
    const multiDbName = `migration_multi_test_${Date.now()}`
    let multiPayload: Payload
    let multiConfig: SanitizedConfig
    const migrationsDir = resolve(process.cwd(), 'dev', 'test-migrations-multi')

    beforeAll(async () => {
      await createTestDb({ dbName: multiDbName })

      if (existsSync(migrationsDir)) {
        rmSync(migrationsDir, { recursive: true, force: true })
      }

      const { mkdirSync } = await import('fs')
      mkdirSync(migrationsDir, { recursive: true })
    })

    afterAll(async () => {
      if (existsSync(migrationsDir)) {
        rmSync(migrationsDir, { recursive: true, force: true })
      }
    })

    test('Multiple pools get IVFFLAT indexes automatically', async () => {
      const integration = createVectorizeIntegration({
        default: {
          dims: DIMS,
          ivfflatLists: 10,
        },
        secondary: {
          dims: DIMS + 100,
          ivfflatLists: 5,
        },
      })

      multiConfig = await buildConfig({
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
          push: false,
          extensions: ['vector'],
          afterSchemaInit: [integration.afterSchemaInitHook],
          migrationDir: migrationsDir,
          pool: {
            connectionString: `postgresql://postgres:password@localhost:5433/${multiDbName}`,
          },
        }),
        plugins: [
          payloadcmsVectorize({
          dbAdapter: integration.adapter,
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
              secondary: {
                collections: {
                  articles: {
                    toKnowledgePool: async (doc: any) => [{ chunk: doc.content || '' }],
                  },
                } as any,
                embeddingConfig: {
                  version: testEmbeddingVersion,
                  queryFn: makeDummyEmbedQuery(DIMS + 100),
                  realTimeIngestionFn: makeDummyEmbedDocs(DIMS + 100),
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

      multiPayload = await getPayload({
        config: multiConfig,
        cron: true,
        key: `migration-multi-test-${Date.now()}`,
      })

      // Create and apply migration
      await multiPayload.db.createMigration({
        migrationName: 'initial',
        payload: multiPayload,
      })

      await multiPayload.db.migrate()

      // Verify both indexes exist
      const postgresPayload = multiPayload as PostgresPayload
      const schemaName = postgresPayload.db.schemaName || 'public'

      // Check default index
      const defaultIndexCheck = await postgresPayload.db.pool?.query(
        `SELECT pg_get_indexdef(c.oid) as def
       FROM pg_indexes i
       JOIN pg_class c ON c.relname = i.indexname
       JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = i.schemaname
       WHERE i.schemaname = $1 AND i.indexname = $2`,
        [schemaName, 'default_embedding_ivfflat'],
      )
      const defaultIndexDef = defaultIndexCheck?.rows[0]?.def || ''
      expect(defaultIndexDef).toBeTruthy()
      expect(defaultIndexDef).toMatch(/lists\s*=\s*['"]?10['"]?/i)

      // Check secondary index
      const secondaryIndexCheck = await postgresPayload.db.pool?.query(
        `SELECT pg_get_indexdef(c.oid) as def
       FROM pg_indexes i
       JOIN pg_class c ON c.relname = i.indexname
       JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = i.schemaname
       WHERE i.schemaname = $1 AND i.indexname = $2`,
        [schemaName, 'secondary_embedding_ivfflat'],
      )
      const secondaryIndexDef = secondaryIndexCheck?.rows[0]?.def || ''
      expect(secondaryIndexDef).toBeTruthy()
      expect(secondaryIndexDef).toMatch(/lists\s*=\s*['"]?5['"]?/i)

      // Verify embedding column dims for both pools
      const defaultDimsCheck = await postgresPayload.db.pool?.query(
        `SELECT format_type(atttypid, atttypmod) as column_type
       FROM pg_attribute
       JOIN pg_class ON pg_attribute.attrelid = pg_class.oid
       JOIN pg_namespace ON pg_class.relnamespace = pg_namespace.oid
       WHERE pg_namespace.nspname = $1
         AND pg_class.relname = $2
         AND pg_attribute.attname = 'embedding'
         AND pg_attribute.attnum > 0
         AND NOT pg_attribute.attisdropped`,
        [schemaName, 'default'],
      )
      const defaultColumnType = defaultDimsCheck?.rows[0]?.column_type || ''
      expect(defaultColumnType).toContain(`vector(${DIMS})`)

      const secondaryDimsCheck = await postgresPayload.db.pool?.query(
        `SELECT format_type(atttypid, atttypmod) as column_type
       FROM pg_attribute
       JOIN pg_class ON pg_attribute.attrelid = pg_class.oid
       JOIN pg_namespace ON pg_class.relnamespace = pg_namespace.oid
       WHERE pg_namespace.nspname = $1
         AND pg_class.relname = $2
         AND pg_attribute.attname = 'embedding'
         AND pg_attribute.attnum > 0
         AND NOT pg_attribute.attisdropped`,
        [schemaName, 'secondary'],
      )
      const secondaryColumnType = secondaryDimsCheck?.rows[0]?.column_type || ''
      expect(secondaryColumnType).toContain(`vector(${DIMS + 100})`)
    })
  })
})
