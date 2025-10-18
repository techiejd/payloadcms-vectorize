import type { Payload } from 'payload'

import config from '@payload-config'
import { getPayload } from 'payload'
import { beforeAll, describe, expect, test } from 'vitest'
import { makeDummyEmbed, testEmbeddingVersion } from 'helpers/embed.js'
import { createHeadlessEditor } from '@payloadcms/richtext-lexical/lexical/headless'
import {
  $getRoot,
  $createParagraphNode,
  $createTextNode,
  type SerializedEditorState,
} from '@payloadcms/richtext-lexical/lexical'
import { $createHeadingNode } from '@payloadcms/richtext-lexical/lexical/rich-text'
import { editorConfigFactory, getEnabledNodes } from '@payloadcms/richtext-lexical'
import {
  buildDummyConfig,
  DIMS,
  getInitialMarkdownContent,
  integration,
  plugin,
} from './constants.js'
import { createTestDb, waitForVectorizationJobs } from './utils.js'
import { VectorSearchResponse } from '../../src/types.js'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { chunkRichText, chunkText } from 'helpers/chunkers.js'
import { vectorSearch } from '../../src/endpoints/vectorSearch.js'

const embedFn = makeDummyEmbed(DIMS)

// Helper function to perform vector search directly
async function performVectorSearch(payload: Payload, query: any): Promise<Response> {
  const searchHandler = vectorSearch(embedFn)

  // Create a mock request object
  const mockRequest = {
    json: async () => ({ query }),
    payload,
  } as any

  return await searchHandler(mockRequest)
}

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
          collections: {
            posts: {
              fields: {
                title: { chunker: chunkText },
                content: { chunker: chunkRichText },
              },
            },
          },
          embed: makeDummyEmbed(DIMS),
          embeddingVersion: testEmbeddingVersion,
        }),
      ],
    })
    payload = await getPayload({ config })
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
    const docs = await payload.find({
      collection: 'embeddings',
    })
    console.log(docs)
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
          fieldPath: 'title',
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
})
