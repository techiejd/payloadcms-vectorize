/**
 * Adapter compliance tests for the Cloudflare Vectorize adapter.
 *
 * These tests verify that the Cloudflare adapter correctly implements
 * the DbAdapter interface as defined in payloadcms-vectorize.
 *
 * Note: Uses mocked Cloudflare bindings since there's no local Vectorize emulator.
 */
import { beforeAll, afterAll, describe, expect, test, vi } from 'vitest'
import type { Payload, SanitizedConfig } from 'payload'
import { buildConfig, getPayload } from 'payload'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { Client } from 'pg'
import { createCloudflareVectorizeIntegration } from '../../src/index.js'
import payloadcmsVectorize from 'payloadcms-vectorize'
import type { DbAdapter } from 'payloadcms-vectorize'

const DIMS = 8
const dbName = `cf_compliance_test_${Date.now()}`

// Mock Cloudflare Vectorize binding
function createMockVectorizeBinding() {
  const storage = new Map<
    string,
    { id: string; values: number[]; metadata?: Record<string, any> }
  >()

  return {
    query: vi.fn(async (vector: number[], options?: any) => {
      const topK = options?.topK || 10
      const allVectors = Array.from(storage.values())

      // Apply WHERE filter if present
      let filtered = allVectors
      if (options?.where?.and) {
        filtered = allVectors.filter((vec) => {
          return options.where.and.every((condition: any) => {
            return vec.metadata?.[condition.key] === condition.value
          })
        })
      }

      // Calculate cosine similarity
      const results = filtered.map((vec) => {
        let dotProduct = 0
        let normA = 0
        let normB = 0

        for (let i = 0; i < vector.length; i++) {
          dotProduct += vector[i] * vec.values[i]
          normA += vector[i] * vector[i]
          normB += vec.values[i] * vec.values[i]
        }

        const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))

        return {
          id: vec.id,
          score: similarity,
          metadata: vec.metadata,
        }
      })

      // Sort by score descending and limit
      results.sort((a, b) => b.score - a.score)
      return { matches: results.slice(0, topK) }
    }),

    upsert: vi.fn(async (vectors: Array<{ id: string; values: number[]; metadata?: any }>) => {
      for (const vec of vectors) {
        storage.set(vec.id, vec)
      }
    }),

    delete: vi.fn(async (ids: string[]) => {
      for (const id of ids) {
        storage.delete(id)
      }
    }),

    list: vi.fn(async () => {
      return Array.from(storage.values())
    }),

    // Test helper
    __getStorage: () => storage,
  }
}

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

describe('Cloudflare Adapter Compliance Tests', () => {
  let adapter: DbAdapter
  let payload: Payload
  let config: SanitizedConfig
  let mockVectorize: ReturnType<typeof createMockVectorizeBinding>

  beforeAll(async () => {
    await createTestDb(dbName)

    mockVectorize = createMockVectorizeBinding()

    const { adapter: cfAdapter } = createCloudflareVectorizeIntegration(
      {
        default: {
          dims: DIMS,
        },
      },
      {
        vectorize: mockVectorize as any,
      },
    )
    adapter = cfAdapter

    config = await buildConfig({
      secret: 'test-secret',
      editor: lexicalEditor(),
      collections: [],
      db: postgresAdapter({
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
      key: `cf-compliance-${Date.now()}`,
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

    test('custom property contains adapter metadata', () => {
      const extension = adapter.getConfigExtension({} as any)

      expect(extension.custom).toBeDefined()
      expect(extension.custom!._cfVectorizeAdapter).toBe(true)
      expect(extension.custom!._poolConfigs).toBeDefined()
      expect(extension.custom!._poolConfigs.default).toBeDefined()
      expect(extension.custom!._poolConfigs.default.dims).toBe(DIMS)
    })
  })

  describe('storeEmbedding()', () => {
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

      expect(mockVectorize.upsert).toHaveBeenCalled()
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

      expect(mockVectorize.upsert).toHaveBeenCalled()
    })

    test('stores embedding in Vectorize with correct ID', async () => {
      const embedding = Array(DIMS).fill(0.5)

      const doc = await payload.create({
        collection: 'default' as any,
        data: {
          sourceCollection: 'test-collection',
          docId: `test-embed-id-${Date.now()}`,
          chunkIndex: 0,
          chunkText: 'test text',
          embeddingVersion: 'v1-test',
        },
      })

      const docId = String(doc.id)
      await adapter.storeEmbedding(payload, 'default', docId, embedding)

      const storage = mockVectorize.__getStorage()
      expect(storage.has(docId)).toBe(true)
      expect(storage.get(docId)?.values).toEqual(embedding)
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

    test('calls Vectorize query with correct parameters', async () => {
      await adapter.search(payload, targetEmbedding, 'default', 5)

      expect(mockVectorize.query).toHaveBeenCalledWith(targetEmbedding, expect.any(Object))
    })
  })

  describe('deleteEmbeddings()', () => {
    test('removes embeddings from Vectorize', async () => {
      const embedding = Array(DIMS).fill(0.7)

      // Create and embed a document
      const doc = await payload.create({
        collection: 'default' as any,
        data: {
          sourceCollection: 'delete-test',
          docId: `doc-to-delete-${Date.now()}`,
          chunkIndex: 0,
          chunkText: 'document to delete',
          embeddingVersion: 'v1-test',
        },
      })

      const docId = String(doc.id)
      await adapter.storeEmbedding(payload, 'default', docId, embedding)

      // Verify it's stored
      const storage = mockVectorize.__getStorage()
      expect(storage.has(docId)).toBe(true)

      // Delete it
      await adapter.deleteEmbeddings?.(payload, 'default', 'delete-test', docId)

      // Verify it's gone
      expect(mockVectorize.delete).toHaveBeenCalledWith([docId])
    })

    test('handles non-existent embeddings gracefully', async () => {
      await expect(
        adapter.deleteEmbeddings?.(payload, 'default', 'non-existent', 'fake-id'),
      ).resolves.not.toThrow()
    })
  })
})
