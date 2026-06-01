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

  test('returns full EmbeddingRecord including numeric embedding array', async () => {
    const records = await adapter.findByIds(payload, 'default', [embeddingId])
    expect(records).toHaveLength(1)
    const [r] = records
    expect(r.id).toBe(embeddingId)
    expect(Array.isArray(r.embedding)).toBe(true)
    expect(r.embedding.length).toBe(DIMS)
    expect(r.embedding.every((n) => typeof n === 'number')).toBe(true)
    expect(r.sourceCollection).toBe('posts')
    expect(r.chunkText).toBe('find me')
    expect(r.embeddingVersion).toBe(testEmbeddingVersion)
  })

  test('includes extension fields', async () => {
    const [r] = await adapter.findByIds(payload, 'default', [embeddingId])
    expect((r as any).category).toBe('science')
  })

  test('drops misses and invalid ids without throwing', async () => {
    const records = await adapter.findByIds(payload, 'default', [
      embeddingId,
      '000000000000000000000000',
      'not-an-object-id',
    ])
    expect(records).toHaveLength(1)
    expect(records[0].id).toBe(embeddingId)
  })

  test('empty ids returns []', async () => {
    const records = await adapter.findByIds(payload, 'default', [])
    expect(records).toEqual([])
  })
})
