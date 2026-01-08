import type { Payload } from 'payload'

import { getPayload } from 'payload'
import { beforeAll, describe, expect, test } from 'vitest'
import { makeDummyEmbedDocs, makeDummyEmbedQuery, testEmbeddingVersion } from 'helpers/embed.js'
import { type SerializedEditorState } from '@payloadcms/richtext-lexical/lexical'
import { buildDummyConfig, DIMS, getInitialMarkdownContent } from './constants.js'
import {
  BULK_QUEUE_NAMES,
  createMockBulkEmbeddings,
  createTestDb,
  waitForVectorizationJobs,
} from './utils.js'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { chunkRichText, chunkText } from 'helpers/chunkers.js'
import { createVectorSearchHandler } from '../../src/endpoints/vectorSearch.js'
import { createVectorizeIntegration, type KnowledgePoolDynamicConfig } from 'payloadcms-vectorize'

const embedFn = makeDummyEmbedQuery(DIMS)

// Helper function to perform vector search directly
async function performVectorSearch(
  payload: Payload,
  query: any,
  knowledgePool: string = 'default',
  where?: any,
  limit?: number,
): Promise<Response> {
  const knowledgePools: Record<string, KnowledgePoolDynamicConfig> = {
    default: {
      collections: {},
      embeddingConfig: {
        version: testEmbeddingVersion,
        queryFn: makeDummyEmbedQuery(DIMS),
        realTimeIngestionFn: makeDummyEmbedDocs(DIMS),
      },
    },
  }
  const searchHandler = createVectorSearchHandler(knowledgePools)

  // Create a mock request object
  const mockRequest = {
    json: async () => ({
      query,
      knowledgePool,
      ...(where ? { where } : {}),
      ...(limit ? { limit } : {}),
    }),
    payload,
  } as any

  return await searchHandler(mockRequest)
}

const integration = createVectorizeIntegration({
  default: {
    dims: DIMS,
    ivfflatLists: 1,
  },
  nonSnakeCasePost: {
    dims: DIMS,
    ivfflatLists: 1,
  },
  'test-non-snake-case-post': {
    dims: DIMS,
    ivfflatLists: 1,
  },
})
const plugin = integration.payloadcmsVectorize

describe('Search endpoint integration tests', () => {
  let payload: Payload
  let markdownContent: SerializedEditorState
  const titleAndQuery = 'My query is a title'

  beforeAll(async () => {
    await createTestDb({ dbName: 'endpoint_test' })
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
        extensions: ['vector'],
        afterSchemaInit: [integration.afterSchemaInitHook],
        pool: {
          connectionString: 'postgresql://postgres:password@localhost:5433/endpoint_test',
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
                    // Process title
                    if (doc.title) {
                      const titleChunks = chunkText(doc.title)
                      chunks.push(...titleChunks.map((chunk) => ({ chunk })))
                    }
                    // Process content
                    if (doc.content) {
                      const contentChunks = await chunkRichText(doc.content, payload)
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
            nonSnakeCasePost: {
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
                      const contentChunks = await chunkRichText(doc.content, payload)
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
            'test-non-snake-case-post': {
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
                      const contentChunks = await chunkRichText(doc.content, payload)
                      chunks.push(...contentChunks.map((chunk) => ({ chunk })))
                    }
                    return chunks
                  },
                },
              },
              embeddingConfig: {
                version: testEmbeddingVersion,
                queryFn: makeDummyEmbedQuery(DIMS),
                bulkEmbeddingsFns: createMockBulkEmbeddings({ statusSequence: ['succeeded'] }),
              },
            },
          },
          bulkQueueNames: BULK_QUEUE_NAMES,
        }),
      ],
    })
    payload = await getPayload({ config, cron: true })
    markdownContent = await getInitialMarkdownContent(config)
  })

  test('querying a title should return the title', async () => {
    // This should create multiple embeddings for the title and content
    const post = await payload.create({
      collection: 'posts',
      data: {
        title: titleAndQuery,
        content: markdownContent as unknown as any,
      },
    })

    // Wait for vectorization jobs to complete
    await waitForVectorizationJobs(payload)
    const response = await performVectorSearch(payload, titleAndQuery)
    const json = await response.json()

    expect(json).toHaveProperty('results')
    expect(Array.isArray(json.results)).toBe(true)
    expect(json.results.length).toBeGreaterThan(0)

    expect(json.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceCollection: 'posts',
          docId: String(post.id),
          chunkIndex: 0,
          chunkText: titleAndQuery,
          embeddingVersion: testEmbeddingVersion,
        }),
      ]),
    )
  })

  test('search results are ordered by similarity (highest first)', async () => {
    const response = await performVectorSearch(payload, titleAndQuery)
    const json = await response.json()

    expect(json.results.length).toBeGreaterThan(1)

    // Check that results are ordered by similarity (descending)
    for (let i = 0; i < json.results.length - 1; i++) {
      expect(json.results[i].similarity).toBeGreaterThanOrEqual(json.results[i + 1].similarity)
    }
  })

  test('search handles empty query gracefully', async () => {
    const response = await performVectorSearch(payload, '')

    expect(response.status).toBe(400)
    const error = await response.json()
    expect(error).toHaveProperty('error')
    expect(error.error).toContain('Query is required')
  })

  test('search handles missing query parameter', async () => {
    const response = await performVectorSearch(payload, undefined)

    expect(response.status).toBe(400)
    const error = await response.json()
    expect(error).toHaveProperty('error')
    expect(error.error).toContain('Query is required')
  })

  test('search handles non-string query', async () => {
    const response = await performVectorSearch(payload, 123)

    expect(response.status).toBe(400)
    const error = await response.json()
    expect(error).toHaveProperty('error')
    expect(error.error).toContain('Query is required and must be a string')
  })

  describe('where', () => {
    test('filters results by extensionFields using WHERE clause', async () => {
      const sharedText = 'Shared searchable content'

      // Create two posts with same text but different categories
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

      // Search without WHERE - should return both
      const responseAll = await performVectorSearch(payload, sharedText)
      const jsonAll = await responseAll.json()

      expect(jsonAll.results.length).toBeGreaterThanOrEqual(2)

      // Search with WHERE clause filtering by docId - should return only one
      const responseFiltered = await performVectorSearch(payload, sharedText, 'default', {
        docId: { equals: String(post1.id) },
      })
      const jsonFiltered = await responseFiltered.json()
      expect(jsonFiltered.results.length).toBeGreaterThan(0)
      expect(jsonFiltered.results.every((r: any) => r.docId === String(post1.id))).toBe(true)
    })
  })
})
