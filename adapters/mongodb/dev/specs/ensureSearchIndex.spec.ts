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

  test('concurrent ensureSearchIndex calls share one createSearchIndex call', async () => {
    const create = vi.fn(async () => undefined)
    let listCallNo = 0
    const collection = {
      listSearchIndexes: () => ({
        toArray: async () => {
          listCallNo += 1
          if (listCallNo === 1) return []
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
