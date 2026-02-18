/**
 * Unit tests for the Cloudflare Vectorize adapter.
 *
 * These tests verify adapter functionality using mocked Cloudflare bindings
 * without requiring a real Payload instance.
 */
import { describe, expect, test, vi } from 'vitest'
import { createCloudflareVectorizeIntegration } from '../../src/index.js'

const DIMS = 8

// Mock Cloudflare binding
function createMockCloudflareBinding() {
  const storage = new Map<string, { id: string; values: number[]; metadata: any }>()

  return {
    query: vi.fn(async (queryVector: number[], options: any) => {
      const { topK = 10, returnMetadata = false, where } = options

      // Simple in-memory search using cosine similarity
      const results = Array.from(storage.values())
        .filter((item) => {
          // Basic metadata filtering
          if (where?.and) {
            return where.and.every((condition: any) => {
              const key = condition.key
              const value = condition.value
              return item.metadata?.[key] === value
            })
          }
          return true
        })
        .map((item) => {
          // Calculate cosine similarity
          const dotProduct = item.values.reduce((sum, v, i) => sum + v * queryVector[i], 0)
          const normA = Math.sqrt(queryVector.reduce((sum, v) => sum + v * v, 0))
          const normB = Math.sqrt(item.values.reduce((sum, v) => sum + v * v, 0))
          const score = normA === 0 || normB === 0 ? 0 : dotProduct / (normA * normB)

          return {
            id: item.id,
            score,
            metadata: returnMetadata ? item.metadata : undefined,
          }
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)

      return { matches: results }
    }),

    upsert: vi.fn(async (vectors: any[]) => {
      for (const vector of vectors) {
        storage.set(vector.id, {
          id: vector.id,
          values: vector.values,
          metadata: vector.metadata || {},
        })
      }
    }),

    deleteByIds: vi.fn(async (ids: string[]) => {
      for (const id of ids) {
        storage.delete(id)
      }
    }),

    list: vi.fn(async (options: any) => {
      const vectors = Array.from(storage.values()).map((item) => ({
        id: item.id,
        values: item.values,
        metadata: options?.returnMetadata ? item.metadata : undefined,
      }))
      return { vectors }
    }),

    // Helper to get storage for assertions
    __getStorage: () => storage,
  }
}

function createMockPayloadForEmbed(mockBinding: any) {
  return {
    config: {
      custom: {
        createVectorizedPayloadObject: () => ({
          getDbAdapterCustom: () => ({ _vectorizeBinding: mockBinding }),
        }),
      },
    },
    create: vi.fn().mockResolvedValue({ id: 'mapping-1' }),
    logger: { error: vi.fn() },
  } as any
}

describe('createCloudflareVectorizeIntegration', () => {
  describe('validation', () => {
    test('should throw if vectorize binding is missing', () => {
      expect(() => {
        createCloudflareVectorizeIntegration({
          config: { default: { dims: 384 } },
          binding: undefined as any,
        })
      }).toThrow('Cloudflare Vectorize binding is required')
    })

    test('should create integration with valid config', () => {
      const mockVectorize = { query: vi.fn(), upsert: vi.fn(), deleteByIds: vi.fn() }

      const integration = createCloudflareVectorizeIntegration({
        config: { default: { dims: 384 } },
        binding: mockVectorize,
      })

      expect(integration).toBeDefined()
      expect(integration.adapter).toBeDefined()
      expect(integration.adapter.storeEmbedding).toBeDefined()
      expect(integration.adapter.search).toBeDefined()
      expect(integration.adapter.deleteEmbeddings).toBeDefined()
      expect(integration.adapter.getConfigExtension).toBeDefined()
    })
  })

  describe('getConfigExtension', () => {
    test('should return config with pool configurations', () => {
      const poolConfigs = { mainPool: { dims: 384 }, secondaryPool: { dims: 768 } }
      const mockVectorize = { query: vi.fn(), upsert: vi.fn(), deleteByIds: vi.fn() }

      const { adapter } = createCloudflareVectorizeIntegration({
        config: poolConfigs,
        binding: mockVectorize,
      })
      const extension = adapter.getConfigExtension({} as any)

      expect(extension.custom?._cfVectorizeAdapter).toBe(true)
      expect(extension.custom?._poolConfigs).toEqual(poolConfigs)
    })

    test('should return collections with cfMappings', () => {
      const mockVectorize = { query: vi.fn(), upsert: vi.fn(), deleteByIds: vi.fn() }

      const { adapter } = createCloudflareVectorizeIntegration({
        config: { default: { dims: 384 } },
        binding: mockVectorize,
      })
      const extension = adapter.getConfigExtension({} as any)

      expect(extension.collections).toBeDefined()
      expect(extension.collections!['vector-cf-mappings']).toBeDefined()
      expect(extension.collections!['vector-cf-mappings'].slug).toBe('vector-cf-mappings')
    })
  })

  describe('storeEmbedding', () => {
    test('should convert Float32Array to regular array', async () => {
      const mockBinding = createMockCloudflareBinding()
      const { adapter } = createCloudflareVectorizeIntegration({
        config: { default: { dims: 8 } },
        binding: mockBinding as any,
      })

      const embedding = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8])
      const mockPayload = createMockPayloadForEmbed(mockBinding)

      await adapter.storeEmbedding(
        mockPayload,
        'default',
        'test-collection',
        'doc-1',
        'test-id',
        embedding,
      )

      expect(mockBinding.upsert).toHaveBeenCalledWith([
        {
          id: 'test-id',
          values: Array.from(embedding),
        },
      ])
    })

    test('should create a mapping row', async () => {
      const mockBinding = createMockCloudflareBinding()
      const { adapter } = createCloudflareVectorizeIntegration({
        config: { default: { dims: 8 } },
        binding: mockBinding as any,
      })

      const mockPayload = createMockPayloadForEmbed(mockBinding)
      const embedding = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]

      await adapter.storeEmbedding(
        mockPayload,
        'default',
        'test-collection',
        'doc-1',
        'test-id',
        embedding,
      )

      expect(mockPayload.create).toHaveBeenCalledWith({
        collection: 'vector-cf-mappings',
        data: {
          vectorId: 'test-id',
          poolName: 'default',
          sourceCollection: 'test-collection',
          docId: 'doc-1',
        },
      })
    })
  })

  describe('deleteEmbeddings', () => {
    test('should look up mappings with correct where clause', async () => {
      const mockBinding = createMockCloudflareBinding()
      const { adapter } = createCloudflareVectorizeIntegration({
        config: { default: { dims: 8 } },
        binding: mockBinding as any,
      })

      const mockPayload = {
        find: vi.fn().mockResolvedValue({ docs: [], hasNextPage: false }),
        delete: vi.fn().mockResolvedValue({}),
        logger: { error: vi.fn() },
      } as any

      await adapter.deleteEmbeddings?.(mockPayload, 'default', 'test-collection', 'doc-123')

      expect(mockPayload.find).toHaveBeenCalledWith(
        expect.objectContaining({
          collection: 'vector-cf-mappings',
          where: {
            and: [
              { poolName: { equals: 'default' } },
              { sourceCollection: { equals: 'test-collection' } },
              { docId: { equals: 'doc-123' } },
            ],
          },
        }),
      )
    })

    test('should delete matching vectors via mappings', async () => {
      const mockBinding = createMockCloudflareBinding()
      const { adapter } = createCloudflareVectorizeIntegration({
        config: { default: { dims: 8 } },
        binding: mockBinding as any,
      })

      const mockPayload = {
        find: vi.fn().mockResolvedValue({
          docs: [
            { id: 'map-1', vectorId: 'vec-1' },
            { id: 'map-2', vectorId: 'vec-2' },
          ],
          hasNextPage: false,
        }),
        delete: vi.fn().mockResolvedValue({}),
        logger: { error: vi.fn() },
      } as any

      await adapter.deleteEmbeddings?.(mockPayload, 'default', 'test-collection', 'doc-123')

      expect(mockBinding.deleteByIds).toHaveBeenCalledWith(['vec-1', 'vec-2'])
    })

    test('should clean up mapping rows after deleting vectors', async () => {
      const mockBinding = createMockCloudflareBinding()
      const { adapter } = createCloudflareVectorizeIntegration({
        config: { default: { dims: 8 } },
        binding: mockBinding as any,
      })

      const mockPayload = {
        find: vi.fn().mockResolvedValue({
          docs: [{ id: 'map-1', vectorId: 'vec-1' }],
          hasNextPage: false,
        }),
        delete: vi.fn().mockResolvedValue({}),
        logger: { error: vi.fn() },
      } as any

      await adapter.deleteEmbeddings?.(mockPayload, 'default', 'test-collection', 'doc-123')

      expect(mockPayload.delete).toHaveBeenCalledWith(
        expect.objectContaining({
          collection: 'vector-cf-mappings',
          where: {
            and: [
              { poolName: { equals: 'default' } },
              { sourceCollection: { equals: 'test-collection' } },
              { docId: { equals: 'doc-123' } },
            ],
          },
        }),
      )
    })

    test('should handle empty results gracefully', async () => {
      const mockBinding = createMockCloudflareBinding()
      const { adapter } = createCloudflareVectorizeIntegration({
        config: { default: { dims: 8 } },
        binding: mockBinding as any,
      })

      const mockPayload = {
        find: vi.fn().mockResolvedValue({ docs: [], hasNextPage: false }),
        delete: vi.fn().mockResolvedValue({}),
        logger: { error: vi.fn() },
      } as any

      await adapter.deleteEmbeddings?.(mockPayload, 'default', 'test-collection', 'doc-123')

      expect(mockBinding.deleteByIds).not.toHaveBeenCalled()
    })

    test('should handle errors', async () => {
      const mockBinding = createMockCloudflareBinding()
      const { adapter } = createCloudflareVectorizeIntegration({
        config: { default: { dims: 8 } },
        binding: mockBinding as any,
      })

      const mockPayload = {
        find: vi.fn().mockRejectedValue(new Error('Query failed')),
        logger: { error: vi.fn() },
      } as any

      await expect(
        adapter.deleteEmbeddings?.(mockPayload, 'default', 'test-collection', 'doc-123'),
      ).rejects.toThrow('Failed to delete embeddings')

      expect(mockPayload.logger.error).toHaveBeenCalled()
    })
  })
})
