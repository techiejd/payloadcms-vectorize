import type { Payload } from 'payload'

import { postgresAdapter } from '@payloadcms/db-postgres'
import { type SerializedEditorState } from '@payloadcms/richtext-lexical/lexical'
import { chunkRichText, chunkText } from 'helpers/chunkers.js'
import { makeDummyEmbedDocs, makeDummyEmbedQuery, testEmbeddingVersion } from 'helpers/embed.js'
import { createMockAdapter } from 'helpers/mockAdapter.js'
import { getPayload } from 'payload'
import payloadcmsVectorize, {
  DbAdapter,
  getVectorizedPayload,
  type VectorizedPayload,
} from 'payloadcms-vectorize'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { buildDummyConfig, DIMS, getInitialMarkdownContent } from './constants.js'
import {
  expectResultsOrderedByScore,
  expectResultsRespectWhere,
  expectValidVectorSearchResults,
} from './helpers/vectorSearchExpectations.js'
import {
  BULK_QUEUE_NAMES,
  createTestDb,
  destroyPayload,
  waitForVectorizationJobs,
} from './utils.js'

const embedFn = makeDummyEmbedQuery(DIMS)

describe('searchByEmbedding method tests', () => {
  let payload: Payload
  let vectorizedPayload: VectorizedPayload
  let adapter: DbAdapter
  let markdownContent: SerializedEditorState
  const titleAndQuery = 'My query is a title for searchByEmbedding'
  const dbName = 'search_by_embedding_test'

  beforeAll(async () => {
    await createTestDb({ dbName })
    adapter = createMockAdapter()

    const config = await buildDummyConfig({
      jobs: {
        tasks: [],
        autoRun: [
          {
            cron: '*/5 * * * * *', // Run every 5 seconds
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
                    // Process title
                    if (doc.title) {
                      const titleChunks = chunkText(doc.title)
                      chunks.push(...titleChunks.map((chunk) => ({ chunk })))
                    }
                    // Process content
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
          bulkQueueNames: BULK_QUEUE_NAMES,
        }),
      ],
    })

    payload = await getPayload({
      config,
      key: `search-by-embedding-test-${Date.now()}`,
      cron: true,
    })

    const vp = getVectorizedPayload(payload)
    if (!vp) {
      throw new Error('Failed to get vectorized payload')
    }
    vectorizedPayload = vp

    markdownContent = await getInitialMarkdownContent(config)
  })

  afterAll(async () => {
    await destroyPayload(payload)
  })

  test('searchByEmbedding with embedding vector returns valid results', async () => {
    // Create a post
    const post = await payload.create({
      collection: 'posts',
      data: {
        title: titleAndQuery,
        content: markdownContent as unknown as any,
      },
    })

    // Wait for vectorization jobs to complete
    await waitForVectorizationJobs(payload)

    // Get the embedding for our query
    const queryEmbedding = await embedFn(titleAndQuery)
    const embeddingArray = Array.isArray(queryEmbedding)
      ? queryEmbedding
      : Array.from(queryEmbedding)

    // Search using the embedding directly
    const results = await vectorizedPayload.searchByEmbedding({
      knowledgePool: 'default',
      embedding: embeddingArray,
    })

    expectValidVectorSearchResults(results, {
      checkShape: true,
      expectedTitle: {
        title: titleAndQuery,
        postId: String(post.id),
        embeddingVersion: testEmbeddingVersion,
      },
    })
  })

  test('searchByEmbedding results are ordered by score (highest first)', async () => {
    // Get the embedding for our query
    const queryEmbedding = await embedFn(titleAndQuery)
    const embeddingArray = Array.isArray(queryEmbedding)
      ? queryEmbedding
      : Array.from(queryEmbedding)

    const results = await vectorizedPayload.searchByEmbedding({
      knowledgePool: 'default',
      embedding: embeddingArray,
    })

    expectResultsOrderedByScore(results)
  })

  test('searchByEmbedding includes the embedding vector when populateEmbedding is true', async () => {
    const queryEmbedding = await embedFn(titleAndQuery)
    const embeddingArray = Array.isArray(queryEmbedding)
      ? queryEmbedding
      : Array.from(queryEmbedding)

    const results = await vectorizedPayload.searchByEmbedding({
      knowledgePool: 'default',
      embedding: embeddingArray,
      populateEmbedding: true,
    })

    expect(results.length).toBeGreaterThan(0)
    for (const r of results) {
      expect(Array.isArray(r.embedding)).toBe(true)
      expect(r.embedding?.length).toBe(DIMS)
    }
  })

  test('searchByEmbedding omits the embedding vector by default', async () => {
    const queryEmbedding = await embedFn(titleAndQuery)
    const embeddingArray = Array.isArray(queryEmbedding)
      ? queryEmbedding
      : Array.from(queryEmbedding)

    const results = await vectorizedPayload.searchByEmbedding({
      knowledgePool: 'default',
      embedding: embeddingArray,
    })

    expect(results.length).toBeGreaterThan(0)
    for (const r of results) {
      expect(r.embedding).toBeUndefined()
    }
  })

  test('searchByEmbedding respects limit parameter', async () => {
    // Get the embedding for our query
    const queryEmbedding = await embedFn(titleAndQuery)
    const embeddingArray = Array.isArray(queryEmbedding)
      ? queryEmbedding
      : Array.from(queryEmbedding)

    const limit = 2
    const results = await vectorizedPayload.searchByEmbedding({
      knowledgePool: 'default',
      embedding: embeddingArray,
      limit,
    })

    expect(results.length).toBeLessThanOrEqual(limit)
  })

  test('searchByEmbedding respects where clause', async () => {
    const sharedText = 'Shared searchable content for embedding search'

    // Create two posts with same text
    const post1 = await payload.create({
      collection: 'posts',
      data: {
        title: sharedText,
        content: null,
      },
    })

    const post2 = await payload.create({
      collection: 'posts',
      data: {
        title: sharedText,
        content: null,
      },
    })

    // Wait for vectorization jobs to complete
    await waitForVectorizationJobs(payload)

    // Get the embedding for our query
    const queryEmbedding = await embedFn(sharedText)
    const embeddingArray = Array.isArray(queryEmbedding)
      ? queryEmbedding
      : Array.from(queryEmbedding)

    // Search without WHERE - should return both
    const resultsAll = await vectorizedPayload.searchByEmbedding({
      knowledgePool: 'default',
      embedding: embeddingArray,
    })

    expect(resultsAll.length).toBeGreaterThanOrEqual(2)

    // Search with WHERE clause filtering by docId - should return only one
    const resultsFiltered = await vectorizedPayload.searchByEmbedding({
      knowledgePool: 'default',
      embedding: embeddingArray,
      where: {
        docId: { equals: String(post1.id) },
      },
    })

    expectResultsRespectWhere(resultsFiltered, (r) => r.docId === String(post1.id))
  })

  test('searchByEmbedding with same embedding as search returns similar results', async () => {
    const testQuery = 'test query for comparison'

    // Create a post to search for
    const post = await payload.create({
      collection: 'posts',
      data: {
        title: testQuery,
        content: null,
      },
    })

    // Wait for vectorization jobs to complete
    await waitForVectorizationJobs(payload)

    // Get results using regular search
    const searchResults = await vectorizedPayload.search({
      knowledgePool: 'default',
      query: testQuery,
    })

    // Get the embedding and use searchByEmbedding
    const queryEmbedding = await embedFn(testQuery)
    const embeddingArray = Array.isArray(queryEmbedding)
      ? queryEmbedding
      : Array.from(queryEmbedding)

    const embeddingSearchResults = await vectorizedPayload.searchByEmbedding({
      knowledgePool: 'default',
      embedding: embeddingArray,
    })

    // Both should return results (not necessarily identical due to possible reranking in search)
    expect(searchResults.length).toBeGreaterThan(0)
    expect(embeddingSearchResults.length).toBeGreaterThan(0)

    // The top result should be the same document chunk for both approaches
    // since we're using the same embedding
    expect(embeddingSearchResults[0].docId).toBe(searchResults[0].docId)
  })
})
