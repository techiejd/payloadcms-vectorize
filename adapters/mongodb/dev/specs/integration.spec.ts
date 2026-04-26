import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { MongoClient } from 'mongodb'
import type { BasePayload } from 'payload'
import type { DbAdapter } from 'payloadcms-vectorize'
import { DIMS, MONGO_URI } from './constants.js'
import { buildMongoTestPayload, teardownDbs } from './utils.js'
import {
  makeDummyEmbedDocs,
  makeDummyEmbedQuery,
  testEmbeddingVersion,
} from '@shared-test/helpers/embed'

const DB1 = `vectorize_mongo_int_${Date.now()}_a`
const DB1_VECTORS = `${DB1}_vectors`

describe('Mongo-specific integration tests', () => {
  let adapter: DbAdapter
  let payload: BasePayload

  beforeAll(async () => {
    const built = await buildMongoTestPayload({
      uri: MONGO_URI,
      dbName: DB1,
      pools: {
        default: { dimensions: DIMS, numCandidates: 50 },
        secondary: { dimensions: DIMS, numCandidates: 50 },
      },
      knowledgePools: {
        default: {
          collections: {},
          embeddingConfig: {
            version: testEmbeddingVersion,
            queryFn: makeDummyEmbedQuery(DIMS),
            realTimeIngestionFn: makeDummyEmbedDocs(DIMS),
          },
        },
        secondary: {
          collections: {},
          embeddingConfig: {
            version: testEmbeddingVersion,
            queryFn: makeDummyEmbedQuery(DIMS),
            realTimeIngestionFn: makeDummyEmbedDocs(DIMS),
          },
        },
      },
    })
    adapter = built.adapter
    payload = built.payload
  })

  afterAll(async () => {
    await teardownDbs(payload, MONGO_URI, DB1)
  })

  test('ensureSearchIndex is idempotent across multiple storeChunk calls', async () => {
    for (let i = 0; i < 3; i++) {
      await adapter.storeChunk(payload, 'default', {
        sourceCollection: 'idempotent',
        docId: `id-${i}`,
        chunkIndex: 0,
        chunkText: `chunk ${i}`,
        embeddingVersion: 'v1',
        embedding: Array(DIMS).fill(0.1 + i * 0.01),
        extensionFields: {},
      })
    }

    const c = new MongoClient(MONGO_URI)
    await c.connect()
    const indexes = (await c
      .db(DB1_VECTORS)
      .collection('vectorize_default')
      .listSearchIndexes()
      .toArray()) as Array<{ name: string }>
    const matches = indexes.filter((i) => i.name === 'vectorize_default_idx')
    expect(matches.length).toBe(1)
    await c.close()
  }, 90_000)

  test('storeChunk → immediate search returns the inserted doc', async () => {
    const docId = `imm-${Date.now()}`
    const target = Array(DIMS).fill(0.42)
    await adapter.storeChunk(payload, 'default', {
      sourceCollection: 'immediate',
      docId,
      chunkIndex: 0,
      chunkText: 'immediate test',
      embeddingVersion: 'v1',
      embedding: target,
      extensionFields: {},
    })
    await new Promise((r) => setTimeout(r, 1200))
    const r = await adapter.search(payload, target, 'default', 5)
    const found = r.some((x) => x.docId === docId)
    expect(found).toBe(true)
  })

  test('multiple pools coexist without collision', async () => {
    await adapter.storeChunk(payload, 'secondary', {
      sourceCollection: 'sec',
      docId: 'sec-1',
      chunkIndex: 0,
      chunkText: 'secondary pool',
      embeddingVersion: 'v1',
      embedding: Array(DIMS).fill(0.9),
      extensionFields: {},
    })

    const c = new MongoClient(MONGO_URI)
    await c.connect()
    const a = await c.db(DB1_VECTORS).collection('vectorize_default').countDocuments()
    const b = await c.db(DB1_VECTORS).collection('vectorize_secondary').countDocuments()
    expect(a).toBeGreaterThan(0)
    expect(b).toBeGreaterThan(0)
    await c.close()
  }, 90_000)

  test('conflicting index definition throws actionable error', async () => {
    // Boot a fresh payload, then pre-seed a conflicting index in the vectors DB
    // BEFORE the adapter's first storeChunk runs ensureSearchIndex.
    const conflictBase = `${DB1}_conflict`
    const conflictVectorsDb = `${conflictBase}_vectors`

    const built = await buildMongoTestPayload({
      uri: MONGO_URI,
      dbName: conflictBase,
      pools: { default: { dimensions: DIMS, similarity: 'cosine', numCandidates: 50 } },
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

    const c = new MongoClient(MONGO_URI)
    await c.connect()
    const coll = c.db(conflictVectorsDb).collection('vectorize_default')
    // Ensure the collection exists by inserting a sentinel doc, then drop it.
    await coll.insertOne({ _bootstrap: true })
    await coll.deleteMany({ _bootstrap: true })
    await coll.createSearchIndex({
      name: 'vectorize_default_idx',
      type: 'vectorSearch',
      definition: {
        fields: [
          { type: 'vector', path: 'embedding', numDimensions: DIMS, similarity: 'euclidean' },
          { type: 'filter', path: 'sourceCollection' },
          { type: 'filter', path: 'docId' },
          { type: 'filter', path: 'embeddingVersion' },
        ],
      },
    })

    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const list = (await coll.listSearchIndexes('vectorize_default_idx').toArray()) as Array<{ name: string; status: string }>
      const status = list.find((i) => i.name === 'vectorize_default_idx')?.status
      if (status === 'BUILDING' || status === 'READY') break
      await new Promise((r) => setTimeout(r, 200))
    }

    try {
      await expect(
        built.adapter.storeChunk(built.payload, 'default', {
          sourceCollection: 'x',
          docId: 'x-1',
          chunkIndex: 0,
          chunkText: 'should fail',
          embeddingVersion: 'v1',
          embedding: Array(DIMS).fill(0.5),
          extensionFields: {},
        }),
      ).rejects.toThrowError(/different definition/)
    } finally {
      await teardownDbs(built.payload, MONGO_URI, conflictBase)
      await c.close()
    }
  }, 90_000)
})
