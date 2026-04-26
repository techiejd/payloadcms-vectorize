import { afterEach, describe, expect, test, vi } from 'vitest'
import { __resetIndexCacheForTests, ensureSearchIndex } from '../../src/indexes.js'
import type { ResolvedPoolConfig } from '../../src/types.js'

const POOL: ResolvedPoolConfig = {
  dimensions: 4,
  similarity: 'cosine',
  filterableFields: [],
  forceExact: false,
  collectionName: 'vectorize_default',
  indexName: 'vectorize_default_idx',
}

afterEach(() => __resetIndexCacheForTests())

describe('ensureSearchIndex', () => {
  test('listSearchIndexes errors propagate (no silent fallback)', async () => {
    const collection = {
      listSearchIndexes: () => ({
        toArray: async () => {
          throw new Error('boom')
        },
      }),
      createSearchIndex: async () => undefined,
    }
    const client = {
      db: () => ({
        collection: () => collection,
        listCollections: () => ({ toArray: async () => [] }),
        createCollection: async () => undefined,
      }),
    } as any
    await expect(ensureSearchIndex(client, 'db', POOL)).rejects.toThrow('boom')
  })

  test('polls until status transitions from BUILDING to READY', async () => {
    vi.useFakeTimers()
    try {
      const definition = {
        fields: [
          { type: 'vector', path: 'embedding', numDimensions: 4, similarity: 'cosine' },
          { type: 'filter', path: 'sourceCollection' },
          { type: 'filter', path: 'docId' },
          { type: 'filter', path: 'embeddingVersion' },
        ],
      }
      let listCount = 0
      const list = vi.fn(() => ({
        toArray: async () => {
          listCount += 1
          if (listCount === 1) return []
          if (listCount <= 3) {
            return [{ name: POOL.indexName, status: 'BUILDING', latestDefinition: definition }]
          }
          return [{ name: POOL.indexName, status: 'READY', latestDefinition: definition }]
        },
      }))
      const create = vi.fn(async () => undefined)
      const collection = {
        listSearchIndexes: list,
        createSearchIndex: create,
      }
      const client = {
        db: () => ({
          collection: () => collection,
          listCollections: () => ({ toArray: async () => [] }),
          createCollection: async () => undefined,
        }),
      } as any

      const promise = ensureSearchIndex(client, 'db', POOL)
      await vi.advanceTimersByTimeAsync(3000)
      await promise

      expect(create).toHaveBeenCalledTimes(1)
      expect(list).toHaveBeenCalledTimes(4)
    } finally {
      vi.useRealTimers()
    }
  })

  test('treats existing index as equal when mongot returns reordered fields/keys', async () => {
    const reorderedDefinition = {
      fields: [
        { path: 'docId', type: 'filter' },
        { path: 'embeddingVersion', type: 'filter' },
        { similarity: 'cosine', path: 'embedding', numDimensions: 4, type: 'vector' },
        { path: 'sourceCollection', type: 'filter' },
      ],
    }
    const create = vi.fn(async () => undefined)
    const collection = {
      listSearchIndexes: () => ({
        toArray: async () => [
          { name: POOL.indexName, status: 'READY', latestDefinition: reorderedDefinition },
        ],
      }),
      createSearchIndex: create,
    }
    const client = {
      db: () => ({
        collection: () => collection,
        listCollections: () => ({ toArray: async () => [] }),
        createCollection: async () => undefined,
      }),
    } as any
    await expect(ensureSearchIndex(client, 'db', POOL)).resolves.toBeUndefined()
    expect(create).not.toHaveBeenCalled()
  })

  test('throws when existing index has a genuinely different definition', async () => {
    const differentDefinition = {
      fields: [
        { type: 'vector', path: 'embedding', numDimensions: 4, similarity: 'euclidean' },
        { type: 'filter', path: 'sourceCollection' },
        { type: 'filter', path: 'docId' },
        { type: 'filter', path: 'embeddingVersion' },
      ],
    }
    const collection = {
      listSearchIndexes: () => ({
        toArray: async () => [
          { name: POOL.indexName, status: 'READY', latestDefinition: differentDefinition },
        ],
      }),
      createSearchIndex: async () => undefined,
    }
    const client = {
      db: () => ({
        collection: () => collection,
        listCollections: () => ({ toArray: async () => [] }),
        createCollection: async () => undefined,
      }),
    } as any
    await expect(ensureSearchIndex(client, 'db', POOL)).rejects.toThrow(/different definition/)
  })

  test('concurrent ensureSearchIndex calls share one createSearchIndex call', async () => {
    let createCount = 0
    const create = vi.fn(async () => {
      createCount += 1
    })
    const collection = {
      listSearchIndexes: () => ({
        toArray: async () => {
          if (createCount === 0) return []
          return [
            {
              name: POOL.indexName,
              status: 'READY',
              latestDefinition: {
                fields: [
                  { type: 'vector', path: 'embedding', numDimensions: 4, similarity: 'cosine' },
                  { type: 'filter', path: 'sourceCollection' },
                  { type: 'filter', path: 'docId' },
                  { type: 'filter', path: 'embeddingVersion' },
                ],
              },
            },
          ]
        },
      }),
      createSearchIndex: create,
    }
    const client = {
      db: () => ({
        collection: () => collection,
        listCollections: () => ({ toArray: async () => [] }),
        createCollection: async () => undefined,
      }),
    } as any

    await Promise.all([
      ensureSearchIndex(client, 'db', POOL),
      ensureSearchIndex(client, 'db', POOL),
      ensureSearchIndex(client, 'db', POOL),
    ])
    expect(create).toHaveBeenCalledTimes(1)
  })
})
