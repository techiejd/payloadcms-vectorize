/**
 * Unit tests for the Cloudflare Vectorize adapter.
 *
 * These tests verify adapter functionality using mocked Cloudflare bindings
 * without requiring a real Payload instance.
 */
import { describe, expect, test, vi } from 'vitest'
import { createCloudflareVectorizeIntegration } from '../../src/index.js'

const DIMS = 8

function createMockCloudflareBinding() {
  const storage = new Map<string, { id: string; values: number[]; metadata: any }>()

  return {
    query: vi.fn(async (queryVector: number[], options: any) => {
      const { topK = 10, returnMetadata = false, returnValues = false, where } = options

      const results = Array.from(storage.values())
        .filter((item) => {
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
          const dotProduct = item.values.reduce((sum, v, i) => sum + v * queryVector[i], 0)
          const normA = Math.sqrt(queryVector.reduce((sum, v) => sum + v * v, 0))
          const normB = Math.sqrt(item.values.reduce((sum, v) => sum + v * v, 0))
          const score = normA === 0 || normB === 0 ? 0 : dotProduct / (normA * normB)

          return {
            id: item.id,
            score,
            values: returnValues ? item.values : undefined,
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

    getByIds: vi.fn(async (ids: string[]) => {
      return ids
        .map((id) => storage.get(id))
        .filter((v): v is { id: string; values: number[]; metadata: any } => v !== undefined)
        .map((v) => ({ id: v.id, values: v.values, metadata: v.metadata }))
    }),

    list: vi.fn(async (options: any) => {
      const vectors = Array.from(storage.values()).map((item) => ({
        id: item.id,
        values: item.values,
        metadata: options?.returnMetadata ? item.metadata : undefined,
      }))
      return { vectors }
    }),

    __getStorage: () => storage,
  }
}

function createMockPayload(mockBinding: any, overrides: Record<string, any> = {}) {
  return {
    config: {
      custom: {
        createVectorizedPayloadObject: () => ({
          getDbAdapterCustom: () => ({ _vectorizeBinding: mockBinding }),
        }),
      },
    },
    create: vi.fn().mockResolvedValue({ id: 'mapping-1' }),
    find: vi.fn().mockResolvedValue({ docs: [], hasNextPage: false, totalDocs: 0 }),
    delete: vi.fn().mockResolvedValue({}),
    logger: { error: vi.fn() },
    ...overrides,
  } as any
}

describe('createCloudflareVectorizeIntegration', () => {
  describe('validation', () => {
    test('should NOT throw at construction if vectorize binding is missing', () => {
      expect(() => {
        createCloudflareVectorizeIntegration({
          config: { default: { dims: 384 } },
          binding: undefined as any,
        })
      }).not.toThrow()
    })

    test('should throw at call-time if vectorize binding is missing', async () => {
      const { adapter } = createCloudflareVectorizeIntegration({
        config: { default: { dims: 384 } },
        binding: undefined as any,
      })
      const payloadWithoutBinding = createMockPayload(undefined)

      await expect(
        adapter.deleteChunks(payloadWithoutBinding, 'default', 'col', 'doc-1'),
      ).rejects.toThrow('Cloudflare Vectorize binding not found')
    })

    test('should create integration with valid config', () => {
      const mockVectorize = { query: vi.fn(), upsert: vi.fn(), deleteByIds: vi.fn() }

      const integration = createCloudflareVectorizeIntegration({
        config: { default: { dims: 384 } },
        binding: mockVectorize,
      })

      expect(integration).toBeDefined()
      expect(integration.adapter).toBeDefined()
      expect(integration.adapter.storeChunk).toBeDefined()
      expect(integration.adapter.search).toBeDefined()
      expect(integration.adapter.deleteChunks).toBeDefined()
      expect(integration.adapter.hasEmbeddingVersion).toBeDefined()
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

  describe('storeChunk', () => {
    test('should convert Float32Array to regular array', async () => {
      const mockBinding = createMockCloudflareBinding()
      const { adapter } = createCloudflareVectorizeIntegration({
        config: { default: { dims: DIMS } },
        binding: mockBinding as any,
      })

      const embedding = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8])
      const mockPayload = createMockPayload(mockBinding)

      await adapter.storeChunk(mockPayload, 'default', {
        sourceCollection: 'test-collection',
        docId: 'doc-1',
        chunkIndex: 0,
        chunkText: 'test text',
        embeddingVersion: 'v1',
        embedding,
        extensionFields: {},
      })

      expect(mockBinding.upsert).toHaveBeenCalledWith([
        {
          id: 'default:test-collection:doc-1:0',
          values: Array.from(embedding),
          metadata: {
            sourceCollection: 'test-collection',
            docId: 'doc-1',
            chunkIndex: 0,
            chunkText: 'test text',
            embeddingVersion: 'v1',
          },
        },
      ])
    })

    test('should create a mapping row', async () => {
      const mockBinding = createMockCloudflareBinding()
      const { adapter } = createCloudflareVectorizeIntegration({
        config: { default: { dims: DIMS } },
        binding: mockBinding as any,
      })

      const mockPayload = createMockPayload(mockBinding)
      const embedding = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]

      await adapter.storeChunk(mockPayload, 'default', {
        sourceCollection: 'test-collection',
        docId: 'doc-1',
        chunkIndex: 0,
        chunkText: 'test text',
        embeddingVersion: 'v1',
        embedding,
        extensionFields: {},
      })

      expect(mockPayload.create).toHaveBeenCalledWith({
        collection: 'vector-cf-mappings',
        data: {
          vectorId: 'default:test-collection:doc-1:0',
          poolName: 'default',
          sourceCollection: 'test-collection',
          docId: 'doc-1',
          embeddingVersion: 'v1',
        },
      })
    })

    test('should include extension fields in metadata', async () => {
      const mockBinding = createMockCloudflareBinding()
      const { adapter } = createCloudflareVectorizeIntegration({
        config: { default: { dims: DIMS } },
        binding: mockBinding as any,
      })

      const mockPayload = createMockPayload(mockBinding)
      const embedding = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]

      await adapter.storeChunk(mockPayload, 'default', {
        sourceCollection: 'test-collection',
        docId: 'doc-1',
        chunkIndex: 0,
        chunkText: 'test text',
        embeddingVersion: 'v1',
        embedding,
        extensionFields: { category: 'science', priority: 5 },
      })

      expect(mockBinding.upsert).toHaveBeenCalledWith([
        expect.objectContaining({
          metadata: expect.objectContaining({
            category: 'science',
            priority: 5,
          }),
        }),
      ])
    })
  })

  describe('deleteChunks', () => {
    test('should look up mappings with correct where clause', async () => {
      const mockBinding = createMockCloudflareBinding()
      const { adapter } = createCloudflareVectorizeIntegration({
        config: { default: { dims: DIMS } },
        binding: mockBinding as any,
      })

      const mockPayload = createMockPayload(mockBinding)

      await adapter.deleteChunks(mockPayload, 'default', 'test-collection', 'doc-123')

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
        config: { default: { dims: DIMS } },
        binding: mockBinding as any,
      })

      const mockPayload = createMockPayload(mockBinding, {
        find: vi.fn().mockResolvedValue({
          docs: [
            { id: 'map-1', vectorId: 'vec-1' },
            { id: 'map-2', vectorId: 'vec-2' },
          ],
          hasNextPage: false,
        }),
      })

      await adapter.deleteChunks(mockPayload, 'default', 'test-collection', 'doc-123')

      expect(mockBinding.deleteByIds).toHaveBeenCalledWith(['vec-1', 'vec-2'])
    })

    test('should clean up mapping rows after deleting vectors', async () => {
      const mockBinding = createMockCloudflareBinding()
      const { adapter } = createCloudflareVectorizeIntegration({
        config: { default: { dims: DIMS } },
        binding: mockBinding as any,
      })

      const mockPayload = createMockPayload(mockBinding, {
        find: vi.fn().mockResolvedValue({
          docs: [{ id: 'map-1', vectorId: 'vec-1' }],
          hasNextPage: false,
        }),
      })

      await adapter.deleteChunks(mockPayload, 'default', 'test-collection', 'doc-123')

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
        config: { default: { dims: DIMS } },
        binding: mockBinding as any,
      })

      const mockPayload = createMockPayload(mockBinding)

      await adapter.deleteChunks(mockPayload, 'default', 'test-collection', 'doc-123')

      expect(mockBinding.deleteByIds).not.toHaveBeenCalled()
    })

    test('should handle errors', async () => {
      const mockBinding = createMockCloudflareBinding()
      const { adapter } = createCloudflareVectorizeIntegration({
        config: { default: { dims: DIMS } },
        binding: mockBinding as any,
      })

      const mockPayload = createMockPayload(mockBinding, {
        find: vi.fn().mockRejectedValue(new Error('Query failed')),
      })

      await expect(
        adapter.deleteChunks(mockPayload, 'default', 'test-collection', 'doc-123'),
      ).rejects.toThrow('Failed to delete embeddings')

      expect(mockPayload.logger.error).toHaveBeenCalled()
    })
  })

  describe('hasEmbeddingVersion', () => {
    test('should return true when mappings exist', async () => {
      const mockBinding = createMockCloudflareBinding()
      const { adapter } = createCloudflareVectorizeIntegration({
        config: { default: { dims: DIMS } },
        binding: mockBinding as any,
      })

      const mockPayload = createMockPayload(mockBinding, {
        find: vi.fn().mockResolvedValue({ totalDocs: 1 }),
      })

      const result = await adapter.hasEmbeddingVersion(
        mockPayload, 'default', 'test-collection', 'doc-1', 'v1',
      )
      expect(result).toBe(true)
    })

    test('should return false when no mappings exist', async () => {
      const mockBinding = createMockCloudflareBinding()
      const { adapter } = createCloudflareVectorizeIntegration({
        config: { default: { dims: DIMS } },
        binding: mockBinding as any,
      })

      const mockPayload = createMockPayload(mockBinding)

      const result = await adapter.hasEmbeddingVersion(
        mockPayload, 'default', 'test-collection', 'doc-1', 'v1',
      )
      expect(result).toBe(false)
    })

    test('should query with correct where clause', async () => {
      const mockBinding = createMockCloudflareBinding()
      const { adapter } = createCloudflareVectorizeIntegration({
        config: { default: { dims: DIMS } },
        binding: mockBinding as any,
      })

      const mockPayload = createMockPayload(mockBinding)

      await adapter.hasEmbeddingVersion(
        mockPayload, 'default', 'test-collection', 'doc-1', 'v1',
      )

      expect(mockPayload.find).toHaveBeenCalledWith({
        collection: 'vector-cf-mappings',
        where: {
          and: [
            { poolName: { equals: 'default' } },
            { sourceCollection: { equals: 'test-collection' } },
            { docId: { equals: 'doc-1' } },
            { embeddingVersion: { equals: 'v1' } },
          ],
        },
        limit: 1,
      })
    })
  })

  describe('search', () => {
    test('includes the embedding vector on each result when populateEmbedding is true', async () => {
      const mockBinding = createMockCloudflareBinding()
      const { adapter } = createCloudflareVectorizeIntegration({
        config: { default: { dims: DIMS } },
        binding: mockBinding as any,
      })
      const mockPayload = createMockPayload(mockBinding)
      const embedding = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]

      await adapter.storeChunk(mockPayload, 'default', {
        sourceCollection: 'posts',
        docId: 'doc-1',
        chunkIndex: 0,
        chunkText: 'find me',
        embeddingVersion: 'v1',
        embedding,
        extensionFields: { category: 'science' },
      })

      const results = await adapter.search(mockPayload, embedding, 'default', 10, undefined, true)
      expect(results).toHaveLength(1)
      expect(results[0].embedding).toEqual(embedding)
      expect(results[0].chunkText).toBe('find me')
      expect((results[0] as any).category).toBe('science')
      expect(mockBinding.query).toHaveBeenCalledWith(
        embedding,
        expect.objectContaining({ returnValues: true }),
      )
    })

    test('omits the embedding vector by default', async () => {
      const mockBinding = createMockCloudflareBinding()
      const { adapter } = createCloudflareVectorizeIntegration({
        config: { default: { dims: DIMS } },
        binding: mockBinding as any,
      })
      const mockPayload = createMockPayload(mockBinding)
      const embedding = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]

      await adapter.storeChunk(mockPayload, 'default', {
        sourceCollection: 'posts',
        docId: 'doc-1',
        chunkIndex: 0,
        chunkText: 'find me',
        embeddingVersion: 'v1',
        embedding,
        extensionFields: {},
      })

      const results = await adapter.search(mockPayload, embedding, 'default')
      expect(results).toHaveLength(1)
      expect(results[0].embedding).toBeUndefined()
      expect(mockBinding.query).not.toHaveBeenCalledWith(
        embedding,
        expect.objectContaining({ returnValues: true }),
      )
    })
  })

  describe('findByIds', () => {
    test('returns full EmbeddingRecord including embedding values when populateEmbedding is true', async () => {
      const mockBinding = createMockCloudflareBinding()
      const { adapter } = createCloudflareVectorizeIntegration({
        config: { default: { dims: DIMS } },
        binding: mockBinding as any,
      })
      const mockPayload = createMockPayload(mockBinding)
      const embedding = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]

      await adapter.storeChunk(mockPayload, 'default', {
        sourceCollection: 'posts',
        docId: 'doc-1',
        chunkIndex: 0,
        chunkText: 'find me',
        embeddingVersion: 'v1',
        embedding,
        extensionFields: { category: 'science' },
      })

      const id = 'default:posts:doc-1:0'
      const records = await adapter.findByIds(mockPayload, 'default', [id], true)
      expect(Object.keys(records)).toEqual([id])
      const r = records[id]!
      expect(r.id).toBe(id)
      expect(r.embedding).toEqual(embedding)
      expect(r.sourceCollection).toBe('posts')
      expect(r.docId).toBe('doc-1')
      expect(r.chunkText).toBe('find me')
      expect(r.embeddingVersion).toBe('v1')
      expect((r as any).category).toBe('science')
    })

    test('omits embedding values by default', async () => {
      const mockBinding = createMockCloudflareBinding()
      const { adapter } = createCloudflareVectorizeIntegration({
        config: { default: { dims: DIMS } },
        binding: mockBinding as any,
      })
      const mockPayload = createMockPayload(mockBinding)

      await adapter.storeChunk(mockPayload, 'default', {
        sourceCollection: 'posts',
        docId: 'doc-1',
        chunkIndex: 0,
        chunkText: 'find me',
        embeddingVersion: 'v1',
        embedding: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
        extensionFields: { category: 'science' },
      })

      const id = 'default:posts:doc-1:0'
      const records = await adapter.findByIds(mockPayload, 'default', [id])
      expect(Object.keys(records)).toEqual([id])
      const r = records[id]!
      expect(r.id).toBe(id)
      expect(r.embedding).toBeUndefined()
      expect(r.chunkText).toBe('find me')
      expect((r as any).category).toBe('science')
    })

    test('maps misses to undefined', async () => {
      const mockBinding = createMockCloudflareBinding()
      const { adapter } = createCloudflareVectorizeIntegration({
        config: { default: { dims: DIMS } },
        binding: mockBinding as any,
      })
      const mockPayload = createMockPayload(mockBinding)
      await adapter.storeChunk(mockPayload, 'default', {
        sourceCollection: 'posts',
        docId: 'doc-1',
        chunkIndex: 0,
        chunkText: 'x',
        embeddingVersion: 'v1',
        embedding: [0, 0, 0, 0, 0, 0, 0, 0],
        extensionFields: {},
      })
      const records = await adapter.findByIds(mockPayload, 'default', [
        'default:posts:doc-1:0',
        'default:posts:nope:0',
      ])
      expect(Object.keys(records).sort()).toEqual(
        ['default:posts:doc-1:0', 'default:posts:nope:0'].sort(),
      )
      expect(records['default:posts:doc-1:0']!.id).toBe('default:posts:doc-1:0')
      expect(records['default:posts:nope:0']).toBeUndefined()
    })

    test('empty ids returns {}', async () => {
      const mockBinding = createMockCloudflareBinding()
      const { adapter } = createCloudflareVectorizeIntegration({
        config: { default: { dims: DIMS } },
        binding: mockBinding as any,
      })
      const mockPayload = createMockPayload(mockBinding)
      const records = await adapter.findByIds(mockPayload, 'default', [])
      expect(records).toEqual({})
    })
  })
})
