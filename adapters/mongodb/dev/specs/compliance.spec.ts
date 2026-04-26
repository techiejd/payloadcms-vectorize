import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { MongoClient } from 'mongodb'
import type { BasePayload } from 'payload'
import type { DbAdapter } from 'payloadcms-vectorize'
import { DIMS, MONGO_URI, TEST_DB } from './constants.js'
import { buildMongoTestPayload, teardownDbs } from './utils.js'
import {
  makeDummyEmbedDocs,
  makeDummyEmbedQuery,
  testEmbeddingVersion,
} from '@shared-test/helpers/embed'

describe('Mongo Adapter Compliance Tests', () => {
  let adapter: DbAdapter
  let payload: BasePayload

  beforeAll(async () => {
    const built = await buildMongoTestPayload({
      uri: MONGO_URI,
      dbName: TEST_DB,
      pools: { default: { dimensions: DIMS, filterableFields: [] } },
      knowledgePools: {
        default: {
          collections: {},
          embeddingConfig: {
            version: testEmbeddingVersion,
            queryFn: makeDummyEmbedQuery(DIMS),
            realTimeIngestionFn: makeDummyEmbedDocs(DIMS),
          },
        },
      },
    })
    payload = built.payload
    adapter = built.adapter
  })

  afterAll(async () => {
    await teardownDbs(payload, MONGO_URI, TEST_DB)
  })

  describe('getConfigExtension()', () => {
    test('returns object with custom._mongoConfig', () => {
      const ext = adapter.getConfigExtension({} as any)
      expect(ext.custom?._mongoConfig).toBeDefined()
      expect(ext.custom!._mongoConfig).not.toHaveProperty('uri')
      expect(ext.custom!._mongoConfig.dbName).toBe(`${TEST_DB}_vectors`)
      expect(ext.custom!._mongoConfig.pools.default.dimensions).toBe(DIMS)
    })

    test('does NOT include any collections (Mongo manages docs via raw driver)', () => {
      const ext = adapter.getConfigExtension({} as any)
      expect(ext.collections).toBeUndefined()
    })
  })

  describe('storeChunk()', () => {
    test('persists embedding (number[])', async () => {
      const embedding = Array(DIMS)
        .fill(0)
        .map(() => Math.random())
      await expect(
        adapter.storeChunk(payload, 'default', {
          sourceCollection: 'test-collection',
          docId: `embed-1-${Date.now()}`,
          chunkIndex: 0,
          chunkText: 'test text',
          embeddingVersion: 'v1',
          embedding,
          extensionFields: {},
        }),
      ).resolves.not.toThrow()
    })

    test('persists embedding (Float32Array)', async () => {
      const embedding = new Float32Array(
        Array(DIMS)
          .fill(0)
          .map(() => Math.random()),
      )
      await expect(
        adapter.storeChunk(payload, 'default', {
          sourceCollection: 'test-collection',
          docId: `embed-2-${Date.now()}`,
          chunkIndex: 0,
          chunkText: 'test text float32',
          embeddingVersion: 'v1',
          embedding,
          extensionFields: {},
        }),
      ).resolves.not.toThrow()
    })
  })

  describe('search()', () => {
    let target: number[]
    beforeAll(async () => {
      target = Array(DIMS).fill(0.5)
      const similar = target.map((v) => v + Math.random() * 0.05)
      await adapter.storeChunk(payload, 'default', {
        sourceCollection: 'test-collection',
        docId: `search-similar-${Date.now()}`,
        chunkIndex: 0,
        chunkText: 'similar doc',
        embeddingVersion: 'v1',
        embedding: similar,
        extensionFields: {},
      })
    })

    test('returns an array of results', async () => {
      const results = await adapter.search(payload, target, 'default')
      expect(Array.isArray(results)).toBe(true)
    })

    test('results have all required fields with correct types', async () => {
      const results = await adapter.search(payload, target, 'default')
      for (const r of results) {
        expect(typeof r.id).toBe('string')
        expect(typeof r.score).toBe('number')
        expect(typeof r.sourceCollection).toBe('string')
        expect(typeof r.docId).toBe('string')
        expect(typeof r.chunkIndex).toBe('number')
        expect(typeof r.chunkText).toBe('string')
        expect(typeof r.embeddingVersion).toBe('string')
      }
    })

    test('results are ordered by score (highest first)', async () => {
      const results = await adapter.search(payload, target, 'default', 10)
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score)
      }
    })

    test('respects limit parameter', async () => {
      const results = await adapter.search(payload, target, 'default', 1)
      expect(results.length).toBeLessThanOrEqual(1)
    })
  })

  describe('deleteChunks()', () => {
    test('removes chunks for a doc', async () => {
      const docId = `to-delete-${Date.now()}`
      await adapter.storeChunk(payload, 'default', {
        sourceCollection: 'delete-test',
        docId,
        chunkIndex: 0,
        chunkText: 'doc to delete',
        embeddingVersion: 'v1',
        embedding: Array(DIMS).fill(0.7),
        extensionFields: {},
      })

      const c = new MongoClient(MONGO_URI)
      await c.connect()
      const before = await c
        .db(`${TEST_DB}_vectors`)
        .collection('vectorize_default')
        .countDocuments({ sourceCollection: 'delete-test', docId })
      expect(before).toBeGreaterThan(0)

      await adapter.deleteChunks(payload, 'default', 'delete-test', docId)

      const after = await c
        .db(`${TEST_DB}_vectors`)
        .collection('vectorize_default')
        .countDocuments({ sourceCollection: 'delete-test', docId })
      expect(after).toBe(0)
      await c.close()
    })

    test('handles missing doc gracefully', async () => {
      await expect(
        adapter.deleteChunks(payload, 'default', 'never-existed', 'fake-id'),
      ).resolves.not.toThrow()
    })
  })

  describe('hasEmbeddingVersion()', () => {
    test('true when chunk exists', async () => {
      const docId = `has-version-${Date.now()}`
      await adapter.storeChunk(payload, 'default', {
        sourceCollection: 'test-collection',
        docId,
        chunkIndex: 0,
        chunkText: 'has version test',
        embeddingVersion: 'v1',
        embedding: Array(DIMS).fill(0.5),
        extensionFields: {},
      })
      const r = await adapter.hasEmbeddingVersion(
        payload, 'default', 'test-collection', docId, 'v1',
      )
      expect(r).toBe(true)
    })

    test('false when no chunk exists', async () => {
      const r = await adapter.hasEmbeddingVersion(
        payload, 'default', 'test-collection', 'never-existed', 'v1',
      )
      expect(r).toBe(false)
    })
  })

  describe('unknown pool errors', () => {
    test('search throws Unknown pool', async () => {
      await expect(
        adapter.search(payload, Array(DIMS).fill(0.0), 'pool_does_not_exist', 5),
      ).rejects.toThrow(/Unknown pool/)
    })

    test('storeChunk throws Unknown pool', async () => {
      await expect(
        adapter.storeChunk(payload, 'pool_does_not_exist', {
          sourceCollection: 'src',
          docId: 'x',
          chunkIndex: 0,
          chunkText: 'x',
          embeddingVersion: 'v',
          embedding: Array(DIMS).fill(0.0),
          extensionFields: {},
        }),
      ).rejects.toThrow(/Unknown pool/)
    })
  })

  describe('search input validation', () => {
    test.each([0, -1, 1.5, NaN])(
      'search rejects non-positive-integer limit (%s)',
      async (limit) => {
        await expect(
          adapter.search(payload, Array(DIMS).fill(0.0), 'default', limit),
        ).rejects.toThrow(/limit must be a positive integer/)
      },
    )
  })
})
