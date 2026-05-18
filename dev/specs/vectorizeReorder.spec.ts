import type { Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { buildConfig, getPayload } from 'payload'
import { lexicalEditor } from '@payloadcms/richtext-lexical'

import payloadcmsVectorize from 'payloadcms-vectorize'
import { createMockAdapter } from 'helpers/mockAdapter.js'
import { DIMS } from './constants.js'
import { createTestDb, destroyPayload, waitForVectorizationJobs } from './utils.js'

/**
 * Verifies the safety invariant of the vectorize task ordering:
 * if the embedding API fails on a re-embed, the doc's existing chunks
 * must remain in the DB. The destructive delete must not run before
 * we have valid embeddings ready to insert.
 */
describe('Vectorize task does not wipe existing chunks on embed failure', () => {
  let payload: Payload
  const dbName = 'vectorize_reorder_test'

  // Controlled embed fn that can be made to fail mid-test.
  let shouldEmbedFail = false
  const embedDocs = async (texts: string[]) => {
    if (shouldEmbedFail) {
      throw new Error('Simulated embedding provider failure')
    }
    return texts.map(() => Array(DIMS).fill(0.5))
  }
  const embedQuery = async (_text: string) => Array(DIMS).fill(0)

  beforeAll(async () => {
    await createTestDb({ dbName })

    const config = await buildConfig({
      secret: 'reorder-test-secret',
      editor: lexicalEditor(),
      jobs: {
        tasks: [],
        autoRun: [{ cron: '*/2 * * * * *', limit: 10 }],
      },
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
          dbAdapter: createMockAdapter(),
          knowledgePools: {
            default: {
              collections: {
                posts: {
                  toKnowledgePool: async (doc: any) => [{ chunk: doc.title ?? '' }],
                },
              },
              embeddingConfig: {
                version: 'reorder-test-v1',
                queryFn: embedQuery,
                realTimeIngestionFn: embedDocs,
              },
            },
          },
        }),
      ],
    })

    payload = await getPayload({
      config,
      key: `vectorize-reorder-test-${Date.now()}`,
      cron: true,
    })
  })

  afterAll(async () => {
    await destroyPayload(payload)
  })

  test('existing chunks survive when re-embed fails', async () => {
    // 1. Create a doc and let the first vectorize succeed.
    const post = await payload.create({
      collection: 'posts',
      data: { title: 'Original title' } as any,
    })
    await waitForVectorizationJobs(payload)

    const beforeFailure = await payload.find({
      collection: 'default',
      where: {
        and: [
          { sourceCollection: { equals: 'posts' } },
          { docId: { equals: String(post.id) } },
        ],
      },
    })
    expect(beforeFailure.docs.length).toBeGreaterThan(0)
    const originalIds = beforeFailure.docs.map((d: any) => d.id).sort()

    // 2. Flip the embed fn to throw, then trigger a re-vectorize.
    shouldEmbedFail = true
    try {
      await payload.update({
        collection: 'posts',
        id: post.id,
        data: { title: 'Updated title' } as any,
      })
      await waitForVectorizationJobs(payload, 15000)

      // 3. The job must have errored.
      const failedJobs = await payload.find({
        collection: 'payload-jobs',
        where: {
          and: [
            { taskSlug: { equals: 'payloadcms-vectorize:vectorize' } },
            { hasError: { equals: true } },
          ],
        },
        sort: '-createdAt',
        limit: 1,
      })
      expect(failedJobs.totalDocs).toBeGreaterThan(0)

      // 4. The existing chunks must STILL be present, with the same IDs.
      //    Before the reorder fix, deleteChunks ran first and wiped these.
      const afterFailure = await payload.find({
        collection: 'default',
        where: {
          and: [
            { sourceCollection: { equals: 'posts' } },
            { docId: { equals: String(post.id) } },
          ],
        },
      })
      const remainingIds = afterFailure.docs.map((d: any) => d.id).sort()
      expect(remainingIds).toEqual(originalIds)
    } finally {
      shouldEmbedFail = false
    }
  })
})
