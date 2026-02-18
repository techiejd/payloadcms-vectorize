import { describe, expect, test } from 'vitest'
import { makeDummyEmbedDocs, makeDummyEmbedQuery, testEmbeddingVersion } from 'helpers/embed.js'
import { buildDummyConfig, DIMS } from './constants.js'
import { createTestDb, waitForVectorizationJobs } from './utils.js'
import { getPayload } from 'payload'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { chunkRichText, chunkText } from 'helpers/chunkers.js'
import { createVectorSearchHandlers } from '../../src/endpoints/vectorSearch.js'
import type { KnowledgePoolDynamicConfig } from 'payloadcms-vectorize'
import payloadcmsVectorize from 'payloadcms-vectorize'
import { createMockAdapter } from 'helpers/mockAdapter.js'

describe('extensionFields', () => {
  test('returns extensionFields in search results with correct types', async () => {
    // Create a new payload instance with extensionFields
    const dbName = 'endpoint_test_extension'
    await createTestDb({ dbName })
    const adapter = createMockAdapter()
    const defaultKnowledgePool: KnowledgePoolDynamicConfig = {
      collections: {
        posts: {
          toKnowledgePool: async (doc, payload) => {
            const chunks: Array<{ chunk: string; category?: string; priorityLevel?: number }> = []
            // Process title
            if (doc.title) {
              const titleChunks = chunkText(doc.title)
              chunks.push(
                ...titleChunks.map((chunk) => ({
                  chunk,
                  category: doc.category || 'general',
                  priorityLevel: doc.priorityLevel || 0,
                })),
              )
            }
            // Process content
            if (doc.content) {
              const contentChunks = await chunkRichText(doc.content, payload.config)
              chunks.push(
                ...contentChunks.map((chunk) => ({
                  chunk,
                  category: doc.category || 'general',
                  priorityLevel: doc.priorityLevel || 0,
                })),
              )
            }
            return chunks
          },
        },
      },
      extensionFields: [
        {
          name: 'category',
          type: 'text',
          admin: {
            description: 'Category for filtering embeddings',
          },
        },
        {
          name: 'priorityLevel',
          type: 'number',
          admin: {
            description: 'Priority level for the embedding',
          },
        },
      ],
      embeddingConfig: {
        version: testEmbeddingVersion,
        queryFn: makeDummyEmbedQuery(DIMS),
        realTimeIngestionFn: makeDummyEmbedDocs(DIMS),
      },
    } as const
    const configWithExtensions = await buildDummyConfig({
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
            { name: 'category', type: 'text' },
            { name: 'priorityLevel', type: 'number' },
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
            default: defaultKnowledgePool,
          },
        }),
      ],
    })

    const payloadWithExtensions = await getPayload({
      config: configWithExtensions,
      key: `extension-fields-vector-search-test-${Date.now()}`,
      cron: true,
    })

    // Create a post with extension field values
    const testQuery = 'Extension fields test content'
    const post = await payloadWithExtensions.create({
      collection: 'posts',
      data: {
        title: testQuery,
        content: null,
        category: 'tech',
        priorityLevel: 42,
      } as unknown as any,
    })

    // Wait for vectorization jobs to complete
    await waitForVectorizationJobs(payloadWithExtensions)

    // Perform vector search
    const knowledgePools: Record<string, KnowledgePoolDynamicConfig> = {
      default: defaultKnowledgePool,
    }
    const searchHandler = createVectorSearchHandlers(knowledgePools, adapter).requestHandler
    const mockRequest = {
      json: async () => ({
        query: testQuery,
        knowledgePool: 'default',
      }),
      payload: payloadWithExtensions,
    } as any
    const response = await searchHandler(mockRequest)
    const json = await response.json()

    // Verify results contain extensionFields
    expect(json).toHaveProperty('results')
    expect(Array.isArray(json.results)).toBe(true)
    expect(json.results.length).toBeGreaterThan(0)

    // Find a result that matches our post
    const matchingResult = json.results.find(
      (r: any) => r.docId === String(post.id) && r.chunkText === testQuery,
    )
    expect(matchingResult).toBeDefined()

    // Verify extensionFields are present
    expect(matchingResult).toHaveProperty('category')
    expect(matchingResult).toHaveProperty('priorityLevel')

    // Verify types are correct
    expect(typeof matchingResult.category).toBe('string')
    expect(matchingResult.category).toBe('tech')
    expect(typeof matchingResult.priorityLevel).toBe('number')
    expect(matchingResult.priorityLevel).toBe(42)
  })
})
