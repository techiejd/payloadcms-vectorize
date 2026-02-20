import type { Payload, SanitizedConfig } from 'payload'
import { beforeAll, describe, expect, test } from 'vitest'
import { makeDummyEmbedDocs, makeDummyEmbedQuery, testEmbeddingVersion } from 'helpers/embed.js'
import { DIMS } from './constants.js'
import { createTestDb, waitForVectorizationJobs } from './utils.js'
import { getPayload } from 'payload'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { buildConfig } from 'payload'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import payloadcmsVectorize from 'payloadcms-vectorize'
import { createMockAdapter } from 'helpers/mockAdapter.js'

const embeddingsCollection = 'default'

describe('shouldEmbedFn - real-time', () => {
  let payload: Payload
  let config: SanitizedConfig
  const dbName = `should_embed_fn_rt_${Date.now()}`
  const adapter = createMockAdapter()

  beforeAll(async () => {
    await createTestDb({ dbName })

    config = await buildConfig({
      secret: process.env.PAYLOAD_SECRET || 'test-secret',
      editor: lexicalEditor(),
      collections: [
        {
          slug: 'posts',
          fields: [{ name: 'title', type: 'text' }],
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
                  shouldEmbedFn: async (doc) => !doc.title?.startsWith('SKIP'),
                  toKnowledgePool: async (doc) => [{ chunk: doc.title }],
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
      jobs: {
        tasks: [],
        autoRun: [
          {
            cron: '*/5 * * * * *',
            limit: 10,
          },
        ],
      },
    })

    payload = await getPayload({
      config,
      key: `should-embed-fn-rt-${Date.now()}`,
      cron: true,
    })
  })

  test('shouldEmbedFn filters documents on real-time create', async () => {
    const skippedPost = await payload.create({
      collection: 'posts',
      data: { title: 'SKIP this post' } as any,
    })
    const allowedPost = await payload.create({
      collection: 'posts',
      data: { title: 'Embed this post' } as any,
    })

    await waitForVectorizationJobs(payload)

    const skippedEmbeddings = await payload.find({
      collection: embeddingsCollection,
      where: { docId: { equals: String(skippedPost.id) } },
    })
    expect(skippedEmbeddings.docs.length).toBe(0)

    const allowedEmbeddings = await payload.find({
      collection: embeddingsCollection,
      where: { docId: { equals: String(allowedPost.id) } },
    })
    expect(allowedEmbeddings.docs.length).toBeGreaterThan(0)
  })
})
