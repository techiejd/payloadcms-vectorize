import type { Payload } from 'payload'
import { getPayload } from 'payload'
import { beforeAll, describe, expect, test } from 'vitest'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { buildDummyConfig, integration, plugin } from './constants.js'
import { createTestDb } from './utils.js'
import { PostgresPayload } from '../../src/types.js'
import { chunkText, chunkRichText } from 'helpers/chunkers.js'
import { makeDummyEmbedDocs, makeDummyEmbedQuery, testEmbeddingVersion } from 'helpers/embed.js'
import { DIMS } from './constants.js'

describe('Extension fields integration tests', () => {
  let payload: Payload
  const dbName = 'extension_fields_test'

  beforeAll(async () => {
    await createTestDb({ dbName })
    const config = await buildDummyConfig({
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
          connectionString: `postgresql://postgres:password@localhost:5433/${dbName}`,
        },
      }),
      plugins: [
        plugin({
          knowledgePools: {
            default: {
              collections: {
                posts: {
                  toKnowledgePool: async (doc, payload) => {
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
                      const contentChunks = await chunkRichText(doc.content, payload)
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
    payload = await getPayload({ config })
  })

  test('extension fields are added to the embeddings table schema', async () => {
    const db = (payload as PostgresPayload).db
    const sql = `
      SELECT column_name, data_type, udt_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'default'
      ORDER BY column_name
    `

    let rows: any[] = []
    if (db?.pool?.query) {
      const res = await db.pool.query(sql)
      rows = res?.rows || []
    } else if (db?.drizzle?.execute) {
      const res = await db.drizzle.execute(sql)
      rows = Array.isArray(res) ? res : res?.rows || []
    }

    const columnsByName = Object.fromEntries(rows.map((r: any) => [r.column_name, r]))

    // Check that reserved fields exist
    expect(columnsByName.source_collection).toBeDefined()
    expect(columnsByName.doc_id).toBeDefined()
    expect(columnsByName.chunk_index).toBeDefined()
    expect(columnsByName.chunk_text).toBeDefined()
    expect(columnsByName.embedding_version).toBeDefined()
    expect(columnsByName.embedding).toBeDefined()

    // Check that extension fields exist
    expect(columnsByName.category).toBeDefined()
    expect(columnsByName.category.data_type).toBe('text')
    expect(columnsByName.priority).toBeDefined()
    expect(columnsByName.priority.data_type).toBe('numeric' || 'integer')
  })

  test('extension field values are stored with embeddings', async () => {
    const post = await payload.create({
      collection: 'posts',
      data: {
        title: 'Test Post',
        content: null,
        category: 'tech',
        priority: 5,
      },
    })

    // Wait for vectorization to complete
    await new Promise((resolve) => setTimeout(resolve, 6000))

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
