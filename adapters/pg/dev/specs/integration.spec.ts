/**
 * Postgres-specific integration tests.
 *
 * These tests verify Postgres-specific functionality like
 * vector column creation, schema modifications, etc.
 */
import { beforeAll, describe, expect, test } from 'vitest'
import type { Payload, SanitizedConfig } from 'payload'
import { buildConfig, getPayload } from 'payload'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { Client } from 'pg'
import { createPostgresVectorIntegration } from '../../src/index.js'
import payloadcmsVectorize from 'payloadcms-vectorize'

const DIMS = 8
const embeddingsCollection = 'default'

// Helper to create test database
async function createTestDb(name: string) {
  const adminUri =
    process.env.DATABASE_ADMIN_URI || 'postgresql://postgres:password@localhost:5433/postgres'
  const client = new Client({ connectionString: adminUri })
  await client.connect()

  const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
  if (exists.rowCount === 0) {
    await client.query(`CREATE DATABASE ${name}`)
  }
  await client.end()
}

describe('Postgres-specific integration tests', () => {
  let payload: Payload
  let config: SanitizedConfig
  const dbName = `pg_int_test_${Date.now()}`

  beforeAll(async () => {
    await createTestDb(dbName)

    const { afterSchemaInitHook, adapter } = createPostgresVectorIntegration({
      default: {
        dims: DIMS,
        ivfflatLists: 1,
      },
    })
    config = await buildConfig({
      secret: 'test-secret',
      editor: lexicalEditor(),
      collections: [
        {
          slug: 'posts',
          fields: [{ name: 'title', type: 'text' }],
        },
      ],
      db: postgresAdapter({
        extensions: ['vector'],
        afterSchemaInit: [afterSchemaInitHook],
        pool: {
          connectionString: `postgresql://postgres:password@localhost:5433/${dbName}`,
        },
      }),
      plugins: [
        payloadcmsVectorize({
          dbAdapter: adapter,
          knowledgePools: {
            default: {
              collections: {
                posts: {
                  toKnowledgePool: async (doc) => [{ chunk: doc.title || '' }],
                },
              },
              embeddingConfig: {
                version: 'test-v1',
                queryFn: async () => Array(DIMS).fill(0.5),
                realTimeIngestionFn: async (texts) => texts.map(() => Array(DIMS).fill(0.5)),
              },
            },
          },
        }),
      ],
    })

    payload = await getPayload({
      config,
      key: `pg-int-test-${Date.now()}`,
      cron: false,
    })
  })

  test('adds embeddings collection with vector column', async () => {
    // Check schema for embeddings collection
    const collections = payload.collections
    expect(collections).toHaveProperty(embeddingsCollection)

    // Query Postgres information_schema to verify vector column exists
    const db = (payload as any).db
    const sql = `
      SELECT column_name, udt_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = '${embeddingsCollection}'
    `

    let rows: any[] = []
    if (db?.pool?.query) {
      const res = await db.pool.query(sql)
      rows = res?.rows || []
    } else if (db?.drizzle?.execute) {
      const res = await db.drizzle.execute(sql)
      rows = Array.isArray(res) ? res : res?.rows || []
    }

    const columnsByName = Object.fromEntries(rows.map((r: any) => [r.column_name, r]))

    expect(columnsByName.embedding).toBeDefined()
    // pgvector columns report udt_name = 'vector'
    expect(columnsByName.embedding.udt_name).toBe('vector')
  })
})
