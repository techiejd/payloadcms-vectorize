import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { MongoClient } from 'mongodb'
import type { BasePayload } from 'payload'
import type { DbAdapter } from 'payloadcms-vectorize'
import { DIMS, MONGO_URI } from './constants.js'
import { buildMongoTestPayload, teardownDbs } from './utils.js'
import { testEmbeddingVersion, makeDummyEmbedDocs, makeDummyEmbedQuery } from '@shared-test/helpers/embed'

const DB = `mongo_find_by_ids_${Date.now()}`

describe('mongodb findByIds', () => {
  let payload: BasePayload
  let adapter: DbAdapter
  let embeddingId: string

  beforeAll(async () => {
    const built = await buildMongoTestPayload({
      uri: MONGO_URI,
      dbName: DB,
      pools: { default: { dimensions: DIMS, filterableFields: ['category'] } },
      knowledgePools: {
        default: {
          collections: {},
          extensionFields: [{ name: 'category', type: 'text' }],
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

    await adapter.storeChunk(payload, 'default', {
      sourceCollection: 'posts',
      docId: 'doc-1',
      chunkIndex: 0,
      chunkText: 'find me',
      embeddingVersion: testEmbeddingVersion,
      embedding: Array(DIMS).fill(0.25),
      extensionFields: { category: 'science' },
    })

    const c = new MongoClient(MONGO_URI)
    await c.connect()
    const doc = await c.db(`${DB}_vectors`).collection('vectorize_default').findOne({ docId: 'doc-1' })
    embeddingId = String(doc!._id)
    await c.close()
  })

  afterAll(async () => {
    await teardownDbs(payload, MONGO_URI, DB)
  })

  test('returns full EmbeddingRecord including numeric embedding array when populateEmbedding is true', async () => {
    const records = await adapter.findByIds(payload, 'default', [embeddingId], true)
    expect(Object.keys(records)).toEqual([embeddingId])
    const r = records[embeddingId]!
    expect(r.id).toBe(embeddingId)
    expect(Array.isArray(r.embedding)).toBe(true)
    expect(r.embedding!.length).toBe(DIMS)
    expect(r.embedding!.every((n) => typeof n === 'number')).toBe(true)
    expect(r.sourceCollection).toBe('posts')
    expect(r.chunkText).toBe('find me')
    expect(r.embeddingVersion).toBe(testEmbeddingVersion)
  })

  test('omits the embedding array by default', async () => {
    const records = await adapter.findByIds(payload, 'default', [embeddingId])
    expect(Object.keys(records)).toEqual([embeddingId])
    const r = records[embeddingId]!
    expect(r.id).toBe(embeddingId)
    expect(r.embedding).toBeUndefined()
    expect(r.sourceCollection).toBe('posts')
    expect(r.chunkText).toBe('find me')
  })

  test('includes extension fields', async () => {
    const records = await adapter.findByIds(payload, 'default', [embeddingId])
    expect((records[embeddingId] as any).category).toBe('science')
  })

  test('maps misses and invalid ids to undefined without throwing', async () => {
    const records = await adapter.findByIds(payload, 'default', [
      embeddingId,
      '000000000000000000000000',
      'not-an-object-id',
    ])
    expect(Object.keys(records).sort()).toEqual(
      [embeddingId, '000000000000000000000000', 'not-an-object-id'].sort(),
    )
    expect(records[embeddingId]!.id).toBe(embeddingId)
    expect(records['000000000000000000000000']).toBeUndefined()
    expect(records['not-an-object-id']).toBeUndefined()
  })

  test('empty ids returns {}', async () => {
    const records = await adapter.findByIds(payload, 'default', [])
    expect(records).toEqual({})
  })
})
