/**
 * Adapter compliance tests for the Postgres adapter.
 *
 * These tests verify that the Postgres adapter correctly implements
 * the DbAdapter interface as defined in payloadcms-vectorize.
 */
import { beforeAll, afterAll, describe, expect, test } from 'vitest'
import type { Payload, SanitizedConfig } from 'payload'
import { buildConfig, getPayload } from 'payload'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { Client } from 'pg'
import { createPostgresVectorIntegration } from '../../src/index.js'
import payloadcmsVectorize from 'payloadcms-vectorize'
import type { DbAdapter } from 'payloadcms-vectorize'

const DIMS = 8
const dbName = `pg_compliance_test_${Date.now()}`

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

describe('Postgres Adapter Compliance Tests', () => {
  let adapter: DbAdapter
  let payload: Payload
  let config: SanitizedConfig

  beforeAll(async () => {
    await createTestDb(dbName)

    const { afterSchemaInitHook, adapter: pgAdapter } = createPostgresVectorIntegration({
      default: {
        dims: DIMS,
        ivfflatLists: 1,
      },
    })
    adapter = pgAdapter

    config = await buildConfig({
      secret: 'test-secret',
      editor: lexicalEditor(),
      collections: [],
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
              collections: {},
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
      key: `pg-compliance-${Date.now()}`,
      cron: false,
    })
  })

  afterAll(async () => {
    // Cleanup is handled by test isolation
  })

  describe('getConfigExtension()', () => {
    test('returns a valid config extension object', () => {
      const extension = adapter.getConfigExtension({} as any)

      expect(extension).toBeDefined()
      expect(typeof extension).toBe('object')
    })

    test('bins property contains vectorize:migrate script', () => {
      const extension = adapter.getConfigExtension({} as any)

      expect(extension.bins).toBeDefined()
      expect(Array.isArray(extension.bins)).toBe(true)
      expect(extension.bins!.length).toBeGreaterThan(0)

      const migrateScript = extension.bins!.find((b) => b.key === 'vectorize:migrate')
      expect(migrateScript).toBeDefined()
      expect(migrateScript!.scriptPath).toBeTruthy()
    })

    test('custom property contains _staticConfigs', () => {
      const extension = adapter.getConfigExtension({} as any)

      expect(extension.custom).toBeDefined()
      expect(extension.custom!._staticConfigs).toBeDefined()
      expect(extension.custom!._staticConfigs.default).toBeDefined()
      expect(extension.custom!._staticConfigs.default.dims).toBe(DIMS)
    })
  })

  describe('embed()', () => {
    test('persists embedding without error (number[])', async () => {
      const embedding = Array(DIMS)
        .fill(0)
        .map(() => Math.random())

      // Create a document first
      const doc = await payload.create({
        collection: 'default' as any,
        data: {
          sourceCollection: 'test-collection',
          docId: `test-embed-1-${Date.now()}`,
          chunkIndex: 0,
          chunkText: 'test text for embedding',
          embeddingVersion: 'v1-test',
        },
      })

      await expect(
        adapter.storeEmbedding(payload, 'default', String(doc.id), embedding),
      ).resolves.not.toThrow()
    })

    test('persists embedding without error (Float32Array)', async () => {
      const embedding = new Float32Array(
        Array(DIMS)
          .fill(0)
          .map(() => Math.random()),
      )

      const doc = await payload.create({
        collection: 'default' as any,
        data: {
          sourceCollection: 'test-collection',
          docId: `test-embed-2-${Date.now()}`,
          chunkIndex: 0,
          chunkText: 'test text for Float32Array',
          embeddingVersion: 'v1-test',
        },
      })

      await expect(
        adapter.storeEmbedding(payload, 'default', String(doc.id), embedding),
      ).resolves.not.toThrow()
    })
  })

  describe('search()', () => {
    let targetEmbedding: number[]
    let similarDocId: string

    beforeAll(async () => {
      // Create test documents with known embeddings
      targetEmbedding = Array(DIMS).fill(0.5)
      const similarEmbedding = Array(DIMS)
        .fill(0.5)
        .map((v) => v + Math.random() * 0.05)

      // Create and embed a document
      const similarDoc = await payload.create({
        collection: 'default' as any,
        data: {
          sourceCollection: 'test-collection',
          docId: `test-search-similar-${Date.now()}`,
          chunkIndex: 0,
          chunkText: 'similar document for search test',
          embeddingVersion: 'v1-test',
        },
      })
      similarDocId = String(similarDoc.id)
      await adapter.storeEmbedding(payload, 'default', similarDocId, similarEmbedding)
    })

    test('returns an array of results', async () => {
      const results = await adapter.search(payload, targetEmbedding, 'default')

      expect(Array.isArray(results)).toBe(true)
    })

    test('results contain required fields', async () => {
      const results = await adapter.search(payload, targetEmbedding, 'default')

      for (const result of results) {
        expect(result).toHaveProperty('id')
        expect(result).toHaveProperty('score')
        expect(result).toHaveProperty('sourceCollection')
        expect(result).toHaveProperty('docId')
        expect(result).toHaveProperty('chunkIndex')
        expect(result).toHaveProperty('chunkText')
        expect(result).toHaveProperty('embeddingVersion')

        expect(typeof result.id).toBe('string')
        expect(typeof result.score).toBe('number')
        expect(typeof result.sourceCollection).toBe('string')
        expect(typeof result.docId).toBe('string')
        expect(typeof result.chunkIndex).toBe('number')
        expect(typeof result.chunkText).toBe('string')
        expect(typeof result.embeddingVersion).toBe('string')
      }
    })

    test('results are ordered by score (highest first)', async () => {
      const results = await adapter.search(payload, targetEmbedding, 'default', 10)

      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score)
      }
    })

    test('respects limit parameter', async () => {
      const results = await adapter.search(payload, targetEmbedding, 'default', 1)

      expect(results.length).toBeLessThanOrEqual(1)
    })
  })
})
