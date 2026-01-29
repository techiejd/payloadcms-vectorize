import type { Payload } from 'payload'

import { postgresAdapter } from '@payloadcms/db-postgres'
import { makeDummyEmbedDocs, makeDummyEmbedQuery, testEmbeddingVersion } from 'helpers/embed.js'
import { Client } from 'pg'
import { beforeAll, describe, expect, test } from 'vitest'

import type { PostgresPayload } from '../../src/types.js'

import { buildDummyConfig, DIMS, integration, plugin } from './constants.js'
import {
  createTestDb,
  waitForVectorizationJobs,
} from './utils.js'
import { getPayload } from 'payload'
import { createVectorSearchHandlers } from '../../src/endpoints/vectorSearch.js'
import type { KnowledgePoolDynamicConfig } from 'payloadcms-vectorize'
const CUSTOM_SCHEMA = 'custom'

describe('Custom schemaName support', () => {
  let payload: Payload
  const dbName = 'schema_name_test'

  beforeAll(async () => {
    await createTestDb({ dbName })

    // Create the custom schema before Payload initializes
    const client = new Client({
      connectionString: `postgresql://postgres:password@localhost:5433/${dbName}`,
    })
    await client.connect()
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${CUSTOM_SCHEMA}`)
    await client.end()

    const config = await buildDummyConfig({
      collections: [
        {
          slug: 'posts',
          fields: [
            { name: 'title', type: 'text' },
            { name: 'content', type: 'text' },
          ],
        },
      ],
      db: postgresAdapter({
        afterSchemaInit: [integration.afterSchemaInitHook],
        extensions: ['vector'],
        pool: {
          connectionString: `postgresql://postgres:password@localhost:5433/${dbName}`,
        },
        schemaName: CUSTOM_SCHEMA,
      }),
      jobs: {
        autoRun: [
          {
            cron: '*/5 * * * * *',
            limit: 10,
          },
        ],
        tasks: [],
      },
      plugins: [
        plugin({
          knowledgePools: {
            default: {
              collections: {
                posts: {
                  toKnowledgePool: async (doc) => {
                    const chunks: Array<{ chunk: string }> = []
                    if (doc.title) {
                      chunks.push({ chunk: doc.title })
                    }
                    if (doc.content) {
                      chunks.push({ chunk: doc.content })
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
      key: `schema-name-test-${Date.now()}`,
      cron: true,
    })
  })

  test('embeddings table is created in custom schema', async () => {
    const db = (payload as PostgresPayload).db
    const tablesRes = await db.pool?.query(
      `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = '${CUSTOM_SCHEMA}'
          AND table_name = 'default'
      `,
    )

    expect(tablesRes?.rowCount).toBe(1)
    expect(tablesRes?.rows[0].table_name).toBe('default')
  })

  test('embedding column exists in custom schema table', async () => {
    const db = (payload as PostgresPayload).db
    const columnsRes = await db.pool?.query(
      `
        SELECT column_name, udt_name
        FROM information_schema.columns
        WHERE table_schema = '${CUSTOM_SCHEMA}'
          AND table_name = 'default'
          AND column_name = 'embedding'
      `,
    )

    expect(columnsRes?.rowCount).toBe(1)
    expect(columnsRes?.rows[0].udt_name).toBe('vector')
  })

  test('vectorization writes embeddings to custom schema', async () => {
    // Create a document that triggers vectorization
    const post = await payload.create({
      collection: 'posts',
      data: {
        content: 'Test post content for vectorization',
        title: 'Test Post Title',
      },
    })

    // Wait for vectorization jobs to complete
    await waitForVectorizationJobs(payload)

    // Query the custom schema table directly to verify embeddings exist
    const db = (payload as PostgresPayload).db
    const embeddingsRes = await db.pool?.query(
      `
        SELECT id, doc_id, chunk_text, embedding
        FROM "${CUSTOM_SCHEMA}"."default"
        WHERE doc_id = $1
      `,
      [String(post.id)],
    )

    // Should have embeddings for title and content
    expect(embeddingsRes?.rowCount).toBeGreaterThanOrEqual(1)

    // Verify embedding column is NOT NULL
    embeddingsRes?.rows.forEach((row: { embedding: unknown }) => {
      expect(row.embedding).not.toBeNull()
      expect(row.embedding).toBeDefined()
    })
  })

  test('vector search queries embeddings from custom schema', async () => {
    // Create a document that triggers vectorization
    const post = await payload.create({
      collection: 'posts',
      data: {
        title: 'Test Post Title',
        content: 'Test post content for vectorization',
      },
    })

    // Wait for vectorization jobs to complete
    await waitForVectorizationJobs(payload)

    // Perform vector search using the search handler
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
    const searchHandler = createVectorSearchHandlers(knowledgePools).requestHandler

    const mockRequest = {
      json: async () => ({
        query: 'Test Post Title',
        knowledgePool: 'default',
      }),
      payload,
    } as any

    const response = await searchHandler(mockRequest)
    const json = await response.json()

    // Verify search works and returns results from custom schema
    expect(response.status).toBe(200)
    expect(json).toHaveProperty('results')
    expect(Array.isArray(json.results)).toBe(true)
    expect(json.results.length).toBeGreaterThan(0)

    // Verify the results match what we created
    expect(json.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceCollection: 'posts',
          docId: String(post.id),
          chunkText: 'Test Post Title',
          embeddingVersion: testEmbeddingVersion,
        }),
      ]),
    )
  })
})
