import type { Payload } from 'payload'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { getVectorizedPayload, VectorizedPayload } from '../../src/types.js'
import { buildDummyConfig, DIMS, getInitialMarkdownContent } from './constants.js'
import {
  createTestDb,
  destroyPayload,
  waitForVectorizationJobs,
} from './utils.js'
import { getPayload } from 'payload'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { makeDummyEmbedDocs, makeDummyEmbedQuery, testEmbeddingVersion } from 'helpers/embed.js'
import { chunkRichText, chunkText } from 'helpers/chunkers.js'
import payloadcmsVectorize from 'payloadcms-vectorize'
import { type SerializedEditorState } from '@payloadcms/richtext-lexical/lexical'
import {
  expectValidVectorSearchResults,
  expectResultsOrderedByScore,
  expectResultsRespectLimit,
  expectResultsRespectWhere,
  expectResultsContainTitle,
} from './helpers/vectorSearchExpectations.js'
import { createMockAdapter } from 'helpers/mockAdapter.js'

describe('VectorizedPayload', () => {
  let payload: Payload
  let markdownContent: SerializedEditorState
  const titleAndQuery = 'VectorizedPayload Test Title'
  const dbName = 'vectorized_payload_test'
  const adapter = createMockAdapter()

  beforeAll(async () => {
    await createTestDb({ dbName })

    const config = await buildDummyConfig({
      jobs: {
        tasks: [],
        autoRun: [
          {
            cron: '*/5 * * * * *',
            limit: 10,
          },
        ],
      },
      collections: [
        {
          slug: 'posts',
          fields: [
            { name: 'title', type: 'text' },
            { name: 'content', type: 'richText' },
          ],
        },
      ],
      db: postgresAdapter({
        pool: {
          connectionString: `postgresql://postgres:password@localhost:5433/${dbName}`,
        },
      }),
      plugins: [
        payloadcmsVectorize({
          dbAdapter: adapter,
          knowledgePools: {
            default: {
              collections: {
                posts: {
                  toKnowledgePool: async (doc, payload) => {
                    const chunks: Array<{ chunk: string }> = []
                    if (doc.title) {
                      const titleChunks = chunkText(doc.title)
                      chunks.push(...titleChunks.map((chunk) => ({ chunk })))
                    }
                    if (doc.content) {
                      const contentChunks = await chunkRichText(doc.content, payload.config)
                      chunks.push(...contentChunks.map((chunk) => ({ chunk })))
                    }
                    return chunks
                  },
                },
              },
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

    payload = await getPayload({
      config,
      key: `vectorized-payload-test-${Date.now()}`,
      cron: true,
    })
    markdownContent = await getInitialMarkdownContent(config)
  })

  afterAll(async () => {
    await destroyPayload(payload)
  })

  describe('getVectorizedPayload', () => {
    test('returns vectorized payload object for a payload instance with vectorize extensions', () => {
      const vectorizedPayload = getVectorizedPayload(payload)
      expect(vectorizedPayload).not.toBeNull()
      expect(vectorizedPayload).toBeDefined()
    })

    test('returns null for a payload instance without vectorize extensions', () => {
      const plainPayload = {} as unknown as Payload
      expect(getVectorizedPayload(plainPayload)).toBeNull()
    })
  })

  describe('search method', () => {
    let postId: string

    beforeAll(async () => {
      const post = await payload.create({
        collection: 'posts',
        data: {
          title: titleAndQuery,
          content: markdownContent as unknown as any,
        },
      })
      postId = String(post.id)

      await waitForVectorizationJobs(payload)
    })

    test('payload has search method', () => {
      const vectorizedPayload = getVectorizedPayload(payload)
      expect(vectorizedPayload).not.toBeNull()
      expect(typeof vectorizedPayload!.search).toBe('function')
    })

    test('search returns an array of VectorSearchResult', async () => {
      const vectorizedPayload = getVectorizedPayload(payload)!

      const results = await vectorizedPayload.search({
        query: titleAndQuery,
        knowledgePool: 'default',
        limit: 5,
      })

      expectValidVectorSearchResults(results, { checkShape: true })
    })

    test('search results are ordered by score (highest first)', async () => {
      const vectorizedPayload = getVectorizedPayload(payload)!

      const results = await vectorizedPayload.search({
        query: titleAndQuery,
        knowledgePool: 'default',
        limit: 10,
      })

      expectResultsOrderedByScore(results)
    })

    test('search respects limit parameter', async () => {
      const vectorizedPayload = getVectorizedPayload(payload)!

      const results = await vectorizedPayload.search({
        query: titleAndQuery,
        knowledgePool: 'default',
        limit: 1,
      })

      expectResultsRespectLimit(results, 1)
    })

    test('search respects where clause', async () => {
      const vectorizedPayload = getVectorizedPayload(payload)!

      const results = await vectorizedPayload.search({
        query: titleAndQuery,
        knowledgePool: 'default',
        where: {
          docId: { equals: postId },
        },
        limit: 10,
      })

      expectResultsRespectWhere(results, (r) => r.docId === postId)
    })

    test('querying a title should return the title as top result', async () => {
      const vectorizedPayload = getVectorizedPayload(payload)!

      const results = await vectorizedPayload.search({
        query: titleAndQuery,
        knowledgePool: 'default',
        limit: 10,
      })

      expectResultsContainTitle(results, titleAndQuery, postId, testEmbeddingVersion)
    })

    test('includes the embedding vector on each result when populateEmbedding is true', async () => {
      const vectorizedPayload = getVectorizedPayload(payload)!

      const results = await vectorizedPayload.search({
        query: titleAndQuery,
        knowledgePool: 'default',
        limit: 5,
        populateEmbedding: true,
      })

      expect(results.length).toBeGreaterThan(0)
      for (const r of results) {
        expect(Array.isArray(r.embedding)).toBe(true)
        expect(r.embedding?.length).toBe(DIMS)
      }
    })

    test('omits the embedding vector by default', async () => {
      const vectorizedPayload = getVectorizedPayload(payload)!

      const results = await vectorizedPayload.search({
        query: titleAndQuery,
        knowledgePool: 'default',
        limit: 5,
      })

      expect(results.length).toBeGreaterThan(0)
      for (const r of results) {
        expect(r.embedding).toBeUndefined()
      }
    })
  })

  describe('findByIds method', () => {
    let embeddingId: string

    beforeAll(async () => {
      const post = await payload.create({
        collection: 'posts',
        data: { title: 'FindByIds seed', content: markdownContent as unknown as any },
      })
      await waitForVectorizationJobs(payload)
      const rows = await payload.find({
        collection: 'default' as any,
        where: { docId: { equals: String(post.id) } },
        limit: 1,
      })
      embeddingId = String(rows.docs[0].id)
    })

    test('payload has findByIds method', () => {
      const vectorizedPayload = getVectorizedPayload(payload)
      expect(typeof vectorizedPayload!.findByIds).toBe('function')
    })

    test('returns the full EmbeddingRecord including the embedding vector when populateEmbedding is true', async () => {
      const vectorizedPayload = getVectorizedPayload(payload)!
      const records = await vectorizedPayload.findByIds({
        knowledgePool: 'default',
        ids: [embeddingId],
        populateEmbedding: true,
      })
      expect(Object.keys(records)).toEqual([embeddingId])
      const record = records[embeddingId]!
      expect(record.id).toBe(embeddingId)
      expect(Array.isArray(record.embedding)).toBe(true)
      expect(record.embedding!.length).toBe(DIMS)
      expect(typeof record.sourceCollection).toBe('string')
      expect(typeof record.chunkText).toBe('string')
    })

    test('omits the embedding vector by default', async () => {
      const vectorizedPayload = getVectorizedPayload(payload)!
      const records = await vectorizedPayload.findByIds({
        knowledgePool: 'default',
        ids: [embeddingId],
      })
      expect(Object.keys(records)).toEqual([embeddingId])
      const record = records[embeddingId]!
      expect(record.id).toBe(embeddingId)
      expect(record.embedding).toBeUndefined()
      expect(typeof record.sourceCollection).toBe('string')
      expect(typeof record.chunkText).toBe('string')
    })

    test('maps unknown ids to undefined (every requested id is a key)', async () => {
      const vectorizedPayload = getVectorizedPayload(payload)!
      const records = await vectorizedPayload.findByIds({
        knowledgePool: 'default',
        ids: [embeddingId, 'definitely-not-an-id-999999'],
      })
      expect(Object.keys(records).sort()).toEqual(
        [embeddingId, 'definitely-not-an-id-999999'].sort(),
      )
      expect(records[embeddingId]!.id).toBe(embeddingId)
      expect(records['definitely-not-an-id-999999']).toBeUndefined()
    })

    test('empty ids returns {}', async () => {
      const vectorizedPayload = getVectorizedPayload(payload)!
      const records = await vectorizedPayload.findByIds({
        knowledgePool: 'default',
        ids: [],
      })
      expect(records).toEqual({})
    })
  })

  describe('queueEmbed method', () => {
    test('payload has queueEmbed method', () => {
      const vectorizedPayload = getVectorizedPayload(payload)
      expect(vectorizedPayload).not.toBeNull()
      expect(typeof vectorizedPayload!.queueEmbed).toBe('function')
    })

    test('queueEmbed queues a vectorization job', async () => {
      const vectorizedPayload = getVectorizedPayload(payload)!

      // Create a post (triggers automatic embedding)
      const post = await payload.create({
        collection: 'posts',
        data: {
          title: 'Queue Embed Test Post',
          content: markdownContent as unknown as any,
        },
      })

      // Wait for automatic vectorization to complete
      await waitForVectorizationJobs(payload)

      // Call queueEmbed to queue another job
      await vectorizedPayload.queueEmbed({
        collection: 'posts',
        docId: String(post.id),
      })

      // Check that a pending job was queued
      const pendingJobs = await payload.find({
        collection: 'payload-jobs',
        where: {
          and: [
            { taskSlug: { equals: 'payloadcms-vectorize:vectorize' } },
            { completedAt: { equals: null } },
          ],
        },
      })

      expect(pendingJobs.totalDocs).toBeGreaterThan(0)
    })
  })

  describe('bulkEmbed method', () => {
    test('payload has bulkEmbed method', () => {
      const vectorizedPayload = getVectorizedPayload(payload)
      expect(vectorizedPayload).not.toBeNull()
      expect(typeof vectorizedPayload!.bulkEmbed).toBe('function')
    })

    test('bulkEmbed throws error when bulk embedding not configured', async () => {
      const vectorizedPayload = getVectorizedPayload(payload)!

      // This pool doesn't have bulkEmbeddingsFns configured
      await expect(vectorizedPayload.bulkEmbed({ knowledgePool: 'default' })).rejects.toThrow(
        'does not have bulk embedding configured',
      )
    })
  })

  describe('retryFailedBatch method', () => {
    test('payload has retryFailedBatch method', () => {
      const vectorizedPayload = getVectorizedPayload(payload)
      expect(vectorizedPayload).not.toBeNull()
      expect(typeof vectorizedPayload!.retryFailedBatch).toBe('function')
    })

    test('retryFailedBatch returns error for non-existent batch', async () => {
      const vectorizedPayload = getVectorizedPayload(payload)!

      const result = await vectorizedPayload.retryFailedBatch({ batchId: '999999' })

      expect('error' in result).toBe(true)
      if ('error' in result) {
        expect(result.error).toContain('not found')
      }
    })
  })
  describe('getAdapterCustom method', () => {
    test('payload has getAdapterCustom method', () => {
      const vectorizedPayload = getVectorizedPayload(payload)
      expect(vectorizedPayload).not.toBeNull()
      expect(typeof vectorizedPayload!.getDbAdapterCustom).toBe('function')
    })

    test('getAdapterCustom returns the adapter custom', () => {
      const vectorizedPayload = getVectorizedPayload(payload)
      expect(vectorizedPayload).not.toBeNull()
      expect(vectorizedPayload!.getDbAdapterCustom()).toBeDefined()
    })
  })
})
