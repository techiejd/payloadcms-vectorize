// adapters/mongodb/dev/specs/multipools.spec.ts
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { MongoClient } from 'mongodb'
import type { BasePayload } from 'payload'
import type { DbAdapter } from 'payloadcms-vectorize'
import { MONGO_URI } from './constants.js'
import { buildMongoTestPayload, teardownDbs } from './utils.js'
import { makeDummyEmbedDocs, makeDummyEmbedQuery } from '@shared-test/helpers/embed'

const DB = `mongo_multipools_${Date.now()}`
const VECTOR_DB = `${DB}_vectors`
const DIMS_A = 8
const DIMS_B = 16

describe('Multiple knowledge pools (mongodb)', () => {
  let payload: BasePayload
  let adapter: DbAdapter

  beforeAll(async () => {
    const built = await buildMongoTestPayload({
      uri: MONGO_URI,
      dbName: DB,
      pools: {
        pool_a: { dimensions: DIMS_A },
        pool_b: { dimensions: DIMS_B },
      },
      knowledgePools: {
        pool_a: {
          collections: {},
          embeddingConfig: {
            version: 'test-pool-a',
            queryFn: makeDummyEmbedQuery(DIMS_A),
            realTimeIngestionFn: makeDummyEmbedDocs(DIMS_A),
          },
        },
        pool_b: {
          collections: {},
          embeddingConfig: {
            version: 'test-pool-b',
            queryFn: makeDummyEmbedQuery(DIMS_B),
            realTimeIngestionFn: makeDummyEmbedDocs(DIMS_B),
          },
        },
      },
    })
    payload = built.payload
    adapter = built.adapter
  })

  afterAll(async () => {
    await teardownDbs(payload, MONGO_URI, DB)
  })

  test('each pool gets its own collection and search index', async () => {
    await adapter.storeChunk(payload, 'pool_a', {
      sourceCollection: 'src',
      docId: 'a-1',
      chunkIndex: 0,
      chunkText: 'a',
      embeddingVersion: 'test-pool-a',
      embedding: Array(DIMS_A).fill(0.5),
      extensionFields: {},
    })
    await adapter.storeChunk(payload, 'pool_b', {
      sourceCollection: 'src',
      docId: 'b-1',
      chunkIndex: 0,
      chunkText: 'b',
      embeddingVersion: 'test-pool-b',
      embedding: Array(DIMS_B).fill(0.5),
      extensionFields: {},
    })

    const c = new MongoClient(MONGO_URI)
    await c.connect()
    const collections = (await c
      .db(VECTOR_DB)
      .listCollections({}, { nameOnly: true })
      .toArray()) as Array<{ name: string }>
    const names = collections.map((x) => x.name)
    expect(names).toEqual(expect.arrayContaining(['vectorize_pool_a', 'vectorize_pool_b']))

    for (const [coll, expectedDims] of [
      ['vectorize_pool_a', DIMS_A],
      ['vectorize_pool_b', DIMS_B],
    ] as const) {
      const idx = (await c.db(VECTOR_DB).collection(coll).listSearchIndexes().toArray()) as Array<{
        name: string
        latestDefinition: { fields: Array<{ type: string; numDimensions?: number }> }
      }>
      const vectorField = idx[0].latestDefinition.fields.find((f) => f.type === 'vector')
      expect(vectorField?.numDimensions).toBe(expectedDims)
    }
    await c.close()
  }, 120_000)

  test('search isolation: a vector written to pool_a is not returned from pool_b', async () => {
    await adapter.storeChunk(payload, 'pool_a', {
      sourceCollection: 'src',
      docId: 'a-iso',
      chunkIndex: 0,
      chunkText: 'isolated-a',
      embeddingVersion: 'test-pool-a',
      embedding: Array(DIMS_A).fill(0.99),
      extensionFields: {},
    })
    await new Promise((r) => setTimeout(r, 1500))

    const aResults = await adapter.search(payload, Array(DIMS_A).fill(0.99), 'pool_a', 5)
    expect(aResults.some((x) => x.docId === 'a-iso')).toBe(true)

    const bResults = await adapter.search(payload, Array(DIMS_B).fill(0.99), 'pool_b', 5)
    expect(bResults.some((x) => x.docId === 'a-iso')).toBe(false)
  }, 90_000)
})
