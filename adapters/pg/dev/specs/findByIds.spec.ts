import type { Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { buildDummyConfig, integration, plugin, DIMS } from './constants.js'
import { createTestDb, destroyPayload, waitForVectorizationJobs } from './utils.js'
import { getPayload } from 'payload'
import { chunkText } from '@shared-test/helpers/chunkers'
import { makeDummyEmbedDocs, makeDummyEmbedQuery, testEmbeddingVersion } from '@shared-test/helpers/embed'

describe('pg findByIds', () => {
  let payload: Payload
  const dbName = 'pg_find_by_ids_test'
  let embeddingId: string

  beforeAll(async () => {
    await createTestDb({ dbName })
    const config = await buildDummyConfig({
      jobs: { tasks: [], autoRun: [{ cron: '*/5 * * * * *', limit: 10 }] },
      collections: [
        { slug: 'posts', fields: [
          { name: 'title', type: 'text' },
          { name: 'category', type: 'text' },
        ] },
      ],
      db: postgresAdapter({
        extensions: ['vector'],
        afterSchemaInit: [integration.afterSchemaInitHook],
        pool: { connectionString: `postgresql://postgres:password@localhost:5433/${dbName}` },
      }),
      plugins: [
        plugin({
          knowledgePools: {
            default: {
              collections: {
                posts: {
                  toKnowledgePool: async (doc) => {
                    const chunks: Array<{ chunk: string; category?: string }> = []
                    if (doc.title) {
                      for (const chunk of chunkText(doc.title)) {
                        chunks.push({ chunk, category: doc.category || 'general' })
                      }
                    }
                    return chunks
                  },
                },
              },
              extensionFields: [{ name: 'category', type: 'text' }],
              embeddingConfig: {
                version: testEmbeddingVersion,
                queryFn: makeDummyEmbedQuery(DIMS),
                realTimeIngestionFn: makeDummyEmbedDocs(DIMS),
              },
            },
          },
        }),
      ],
    })
    payload = await getPayload({ config, key: `pg-find-by-ids-${Date.now()}`, cron: true })

    const post = await payload.create({
      collection: 'posts',
      data: { title: 'Find me by id', category: 'science' },
    })
    await waitForVectorizationJobs(payload)
    const rows = await payload.find({
      collection: 'default' as any,
      where: { docId: { equals: String(post.id) } },
      limit: 1,
    })
    embeddingId = String(rows.docs[0].id)
  })

  afterAll(async () => {
    await destroyPayload(payload)
  })

  test('returns full EmbeddingRecord including numeric embedding array when populateEmbedding is true', async () => {
    const records = await integration.adapter.findByIds(payload, 'default', [embeddingId], true)
    expect(records).toHaveLength(1)
    const [r] = records
    expect(r.id).toBe(embeddingId)
    expect(Array.isArray(r.embedding)).toBe(true)
    expect(r.embedding!.length).toBe(DIMS)
    expect(r.embedding!.every((n) => typeof n === 'number')).toBe(true)
    expect(r.sourceCollection).toBe('posts')
    expect(typeof r.chunkText).toBe('string')
    expect(r.embeddingVersion).toBe(testEmbeddingVersion)
  })

  test('omits the embedding array by default', async () => {
    const records = await integration.adapter.findByIds(payload, 'default', [embeddingId])
    expect(records).toHaveLength(1)
    const [r] = records
    expect(r.id).toBe(embeddingId)
    expect(r.embedding).toBeUndefined()
    expect(r.sourceCollection).toBe('posts')
  })

  test('includes extension fields when the pool defines them', async () => {
    const [r] = await integration.adapter.findByIds(payload, 'default', [embeddingId])
    expect((r as any).category).toBe('science')
  })

  test('drops misses', async () => {
    const records = await integration.adapter.findByIds(payload, 'default', [embeddingId, '999999'])
    expect(records).toHaveLength(1)
    expect(records[0].id).toBe(embeddingId)
  })

  test('empty ids returns []', async () => {
    const records = await integration.adapter.findByIds(payload, 'default', [])
    expect(records).toEqual([])
  })
})

describe('pg findByIds (uuid idType)', () => {
  let payload: Payload
  const dbName = 'pg_find_by_ids_uuid_test'
  let embeddingId: string

  beforeAll(async () => {
    await createTestDb({ dbName })
    const config = await buildDummyConfig({
      jobs: { tasks: [], autoRun: [{ cron: '*/5 * * * * *', limit: 10 }] },
      collections: [
        { slug: 'posts', fields: [
          { name: 'title', type: 'text' },
          { name: 'category', type: 'text' },
        ] },
      ],
      db: postgresAdapter({
        idType: 'uuid',
        extensions: ['vector'],
        afterSchemaInit: [integration.afterSchemaInitHook],
        pool: { connectionString: `postgresql://postgres:password@localhost:5433/${dbName}` },
      }),
      plugins: [
        plugin({
          knowledgePools: {
            default: {
              collections: {
                posts: {
                  toKnowledgePool: async (doc) => {
                    const chunks: Array<{ chunk: string; category?: string }> = []
                    if (doc.title) {
                      for (const chunk of chunkText(doc.title)) {
                        chunks.push({ chunk, category: doc.category || 'general' })
                      }
                    }
                    return chunks
                  },
                },
              },
              extensionFields: [{ name: 'category', type: 'text' }],
              embeddingConfig: {
                version: testEmbeddingVersion,
                queryFn: makeDummyEmbedQuery(DIMS),
                realTimeIngestionFn: makeDummyEmbedDocs(DIMS),
              },
            },
          },
        }),
      ],
    })
    payload = await getPayload({ config, key: `pg-find-by-ids-uuid-${Date.now()}`, cron: true })

    const post = await payload.create({
      collection: 'posts',
      data: { title: 'Find me by uuid', category: 'science' },
    })
    await waitForVectorizationJobs(payload)
    const rows = await payload.find({
      collection: 'default' as any,
      where: { docId: { equals: String(post.id) } },
      limit: 1,
    })
    embeddingId = String(rows.docs[0].id)
  })

  afterAll(async () => {
    await destroyPayload(payload)
  })

  test('embedding id is a uuid, not a numeric PK', () => {
    expect(embeddingId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
  })

  test('findByIds resolves a uuid id (regression: numeric-only filter dropped uuids)', async () => {
    const records = await integration.adapter.findByIds(payload, 'default', [embeddingId], true)
    expect(records).toHaveLength(1)
    const [r] = records
    expect(r.id).toBe(embeddingId)
    expect(Array.isArray(r.embedding)).toBe(true)
    expect(r.embedding!.length).toBe(DIMS)
    expect((r as any).category).toBe('science')
  })

  test('drops a well-formed but nonexistent uuid', async () => {
    const records = await integration.adapter.findByIds(payload, 'default', [
      embeddingId,
      '00000000-0000-0000-0000-000000000000',
    ])
    expect(records).toHaveLength(1)
    expect(records[0].id).toBe(embeddingId)
  })
})
