import type { Payload } from 'payload'
import { beforeAll, describe, expect, test } from 'vitest'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { createTestDb, waitForVectorizationJobs } from './utils.js'
import { getPayload, buildConfig } from 'payload'
import { chunkText, chunkRichText } from 'helpers/chunkers.js'
import { makeDummyEmbedDocs, makeDummyEmbedQuery, testEmbeddingVersion } from 'helpers/embed.js'
import { DIMS } from './constants.js'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { createMockAdapter } from 'helpers/mockAdapter.js'
import payloadcmsVectorize from 'payloadcms-vectorize'

describe('Extension fields integration tests', () => {
  let payload: Payload
  const dbName = 'extension_fields_test'

  beforeAll(async () => {
    await createTestDb({ dbName })

    // Create mock adapter for testing without requiring pg vector extension
    const dbAdapter = createMockAdapter()

    const config = await buildConfig({
      secret: process.env.PAYLOAD_SECRET || 'test-secret',
      editor: lexicalEditor(),
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
            { name: 'priority', type: 'number' },
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
          dbAdapter,
          knowledgePools: {
            default: {
              collections: {
                posts: {
                  toKnowledgePool: async (doc: any, payload: Payload) => {
                    const chunks: Array<{ chunk: string; category?: string; priority?: number }> =
                      []
                    // Process title
                    if (doc.title) {
                      const titleChunks = chunkText(doc.title)
                      chunks.push(
                        ...titleChunks.map((chunk) => ({
                          chunk,
                          category: doc.category || 'general',
                          priority: doc.priority || 0,
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
                          priority: doc.priority || 0,
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
                  name: 'priority',
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
            },
          },
        }),
      ],
    })

    payload = await getPayload({
      config,
      key: `extension-fields-test-${Date.now()}`,
      cron: true,
    })
  })

  test('extension field values are stored with embeddings', async () => {
    const post = await payload.create({
      collection: 'posts',
      data: {
        title: 'Test Post',
        content: null,
        category: 'tech',
        priority: 5,
      } as unknown as any, // any type needed because generated types works off of payload.config.ts, and does not take into account our `buildDummyConfig`.
    })

    // Wait for vectorization jobs to complete
    await waitForVectorizationJobs(payload)

    const embeddings = await payload.find({
      collection: 'default',
      where: {
        and: [{ sourceCollection: { equals: 'posts' } }, { docId: { equals: String(post.id) } }],
      },
    })

    expect(embeddings.docs.length).toBeGreaterThan(0)
    expect(embeddings.docs[0]).toHaveProperty('category', 'tech')
    expect(embeddings.docs[0]).toHaveProperty('priority', 5)
  })
})
