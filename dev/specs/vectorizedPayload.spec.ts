import type { Payload } from 'payload'

import { getPayload } from 'payload'
import { beforeAll, describe, expect, test } from 'vitest'
import { isVectorizedPayload, VectorizedPayload } from '../../src/types.js'
import { buildDummyConfig, DIMS, getInitialMarkdownContent } from './constants.js'
import { createTestDb, waitForVectorizationJobs } from './utils.js'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { makeDummyEmbedDocs, makeDummyEmbedQuery, testEmbeddingVersion } from 'helpers/embed.js'
import { chunkRichText, chunkText } from 'helpers/chunkers.js'
import { createVectorizeIntegration } from 'payloadcms-vectorize'
import { type SerializedEditorState } from '@payloadcms/richtext-lexical/lexical'
import {
  expectValidVectorSearchResults,
  expectResultsOrderedBySimilarity,
  expectResultsRespectLimit,
  expectResultsRespectWhere,
  expectResultsContainTitle,
} from './helpers/vectorSearchExpectations.js'

const integration = createVectorizeIntegration({
  default: {
    dims: DIMS,
    ivfflatLists: 1,
  },
})
const plugin = integration.payloadcmsVectorize

describe('VectorizedPayload', () => {
  let payload: Payload
  let markdownContent: SerializedEditorState
  const titleAndQuery = 'VectorizedPayload Test Title'

  beforeAll(async () => {
    await createTestDb({ dbName: 'vectorized_payload_test' })
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
        extensions: ['vector'],
        afterSchemaInit: [integration.afterSchemaInitHook],
        pool: {
          connectionString: 'postgresql://postgres:password@localhost:5433/vectorized_payload_test',
        },
      }),
      plugins: [
        plugin({
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
                      const contentChunks = await chunkRichText(doc.content, payload)
                      chunks.push(...contentChunks.map((chunk) => ({ chunk })))
                    }
                    return chunks
                  },
                },
              },
              embedDocs: makeDummyEmbedDocs(DIMS),
              embedQuery: makeDummyEmbedQuery(DIMS),
              embeddingVersion: testEmbeddingVersion,
            },
          },
        }),
      ],
    })
    payload = await getPayload({ config, cron: true })
    markdownContent = await getInitialMarkdownContent(config)
  })

  describe('isVectorizedPayload type guard', () => {
    test('returns true for a payload instance with vectorize extensions', () => {
      expect(isVectorizedPayload(payload)).toBe(true)
    })

    test('returns false for a plain object without search method', () => {
      const plainObj = { queueEmbed: () => Promise.resolve() } as unknown as Payload
      expect(isVectorizedPayload(plainObj)).toBe(false)
    })

    test('returns false for a plain object without queueEmbed method', () => {
      const plainObj = { search: () => Promise.resolve([]) } as unknown as Payload
      expect(isVectorizedPayload(plainObj)).toBe(false)
    })

    test('returns false for an empty object', () => {
      const emptyObj = {} as unknown as Payload
      expect(isVectorizedPayload(emptyObj)).toBe(false)
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
      expect(typeof (payload as VectorizedPayload).search).toBe('function')
    })

    test('search returns an array of VectorSearchResult', async () => {
      const vectorizedPayload = payload as VectorizedPayload<'default'>

      const results = await vectorizedPayload.search({
        query: titleAndQuery,
        knowledgePool: 'default',
        limit: 5,
      })

      expectValidVectorSearchResults(results, { checkShape: true })
    })

    test('search results are ordered by similarity (highest first)', async () => {
      const vectorizedPayload = payload as VectorizedPayload<'default'>

      const results = await vectorizedPayload.search({
        query: titleAndQuery,
        knowledgePool: 'default',
        limit: 10,
      })

      expectResultsOrderedBySimilarity(results)
    })

    test('search respects limit parameter', async () => {
      const vectorizedPayload = payload as VectorizedPayload<'default'>

      const results = await vectorizedPayload.search({
        query: titleAndQuery,
        knowledgePool: 'default',
        limit: 1,
      })

      expectResultsRespectLimit(results, 1)
    })

    test('search respects where clause', async () => {
      const vectorizedPayload = payload as VectorizedPayload<'default'>

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
      const vectorizedPayload = payload as VectorizedPayload<'default'>

      const results = await vectorizedPayload.search({
        query: titleAndQuery,
        knowledgePool: 'default',
        limit: 10,
      })

      expectResultsContainTitle(results, titleAndQuery, postId, testEmbeddingVersion)
    })
  })

  describe('queueEmbed method', () => {
    test('payload has queueEmbed method', () => {
      expect(typeof (payload as VectorizedPayload).queueEmbed).toBe('function')
    })

    test('queueEmbed queues a vectorization job', async () => {
      const vectorizedPayload = payload as VectorizedPayload

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
})
