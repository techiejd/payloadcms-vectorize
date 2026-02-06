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

    delete: vi.fn(async (ids: string[]) => {
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
      const mockVectorize = { query: vi.fn(), upsert: vi.fn(), delete: vi.fn() }

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
      const mockVectorize = { query: vi.fn() }

      const { adapter } = createCloudflareVectorizeIntegration({
        config: poolConfigs,
        binding: mockVectorize,
      })
      const extension = adapter.getConfigExtension({} as any)

      expect(extension.custom?._cfVectorizeAdapter).toBe(true)
      expect(extension.custom?._poolConfigs).toEqual(poolConfigs)
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
      const mockPayload = { context: {} } as any

      await adapter.storeEmbedding(mockPayload, 'default', 'test-id', embedding)

      expect(mockBinding.upsert).toHaveBeenCalledWith([
        {
          id: 'test-id',
          values: Array.from(embedding),
        },
      ])
    })

    test('should inject vectorize binding into context', async () => {
      const mockBinding = createMockCloudflareBinding()
      const { adapter } = createCloudflareVectorizeIntegration({
        config: { default: { dims: 8 } },
        binding: mockBinding as any,
      })

      const mockPayload = { context: {} } as any
      const embedding = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]

      await adapter.storeEmbedding(mockPayload, 'default', 'test-id', embedding)

      expect(mockPayload.context.vectorize).toBe(mockBinding)
    })
  })

  describe('deleteEmbeddings', () => {
    test('should query with correct where clause', async () => {
      const mockBinding = createMockCloudflareBinding()
      const { adapter } = createCloudflareVectorizeIntegration({
        config: { default: { dims: 8 } },
        binding: mockBinding as any,
      })

      const mockPayload = { context: {}, logger: { error: vi.fn() } } as any

      await adapter.deleteEmbeddings?.(mockPayload, 'default', 'test-collection', 'doc-123')

      expect(mockBinding.query).toHaveBeenCalled()
      const queryCall = mockBinding.query.mock.calls[0]
      const options = queryCall[1]

      expect(options.where?.and).toEqual([
        { key: 'sourceCollection', value: 'test-collection' },
        { key: 'docId', value: 'doc-123' },
      ])
    })

    test('should delete matching vectors', async () => {
      const mockBinding = createMockCloudflareBinding()
      const { adapter } = createCloudflareVectorizeIntegration({
        config: { default: { dims: 8 } },
        binding: mockBinding as any,
      })

      // Manually add some vectors to the mock storage
      const storage = mockBinding.__getStorage()
      storage.set('vec-1', {
        id: 'vec-1',
        values: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
        metadata: { sourceCollection: 'test-collection', docId: 'doc-123' },
      })
      storage.set('vec-2', {
        id: 'vec-2',
        values: [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9],
        metadata: { sourceCollection: 'test-collection', docId: 'doc-123' },
      })

      const mockPayload = { context: {}, logger: { error: vi.fn() } } as any

      await adapter.deleteEmbeddings?.(mockPayload, 'default', 'test-collection', 'doc-123')

      expect(mockBinding.delete).toHaveBeenCalledWith(['vec-1', 'vec-2'])
    })

    test('should handle empty results gracefully', async () => {
      const mockBinding = createMockCloudflareBinding()
      const { adapter } = createCloudflareVectorizeIntegration({
        config: { default: { dims: 8 } },
        binding: mockBinding as any,
      })

      const mockPayload = { context: {}, logger: { error: vi.fn() } } as any

      await adapter.deleteEmbeddings?.(mockPayload, 'default', 'test-collection', 'doc-123')

      expect(mockBinding.delete).not.toHaveBeenCalled()
    })

    test('should handle query errors', async () => {
      const mockBinding = createMockCloudflareBinding()
      mockBinding.query = vi.fn().mockRejectedValue(new Error('Query failed'))

      const { adapter } = createCloudflareVectorizeIntegration({
        config: { default: { dims: 8 } },
        binding: mockBinding as any,
      })

      const mockPayload = {
        context: {},
        logger: { error: vi.fn() },
      } as any

      await expect(
        adapter.deleteEmbeddings?.(mockPayload, 'default', 'test-collection', 'doc-123'),
      ).rejects.toThrow('Failed to delete embeddings')

      expect(mockPayload.logger.error).toHaveBeenCalled()
    })
  })
})
