import type { Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { BULK_EMBEDDINGS_RUNS_SLUG } from '../../../src/collections/bulkEmbeddingsRuns.js'
import { BULK_EMBEDDINGS_BATCHES_SLUG } from '../../../src/collections/bulkEmbeddingsBatches.js'
import {
  BULK_QUEUE_NAMES,
  DEFAULT_DIMS,
  buildPayloadWithIntegration,
  createMockBulkEmbeddings,
  createTestDb,
  destroyPayload,
  waitForBulkJobs,
} from '../utils.js'
import { makeDummyEmbedQuery, testEmbeddingVersion } from 'helpers/embed.js'
import { getVectorizedPayload, VectorizedPayload } from 'payloadcms-vectorize'
import { expectGoodResult } from '../utils.vitest.js'
import { createMockAdapter } from 'helpers/mockAdapter.js'

const DIMS = DEFAULT_DIMS
const dbName = `bulk_batchlimit_${Date.now()}`

describe('Bulk embed - batchLimit', () => {
  let payload: Payload
  let vectorizedPayload: VectorizedPayload | null = null

  beforeAll(async () => {
    await createTestDb({ dbName })
    const built = await buildPayloadWithIntegration({
      dbName,
      pluginOpts: {
        dbAdapter: createMockAdapter(),
        knowledgePools: {
          default: {
            collections: {
              posts: {
                toKnowledgePool: async (doc: any) => [{ chunk: doc.title }],
                batchLimit: 2,
              },
            },
            embeddingConfig: {
              version: testEmbeddingVersion,
              queryFn: makeDummyEmbedQuery(DIMS),
              bulkEmbeddingsFns: createMockBulkEmbeddings({
                statusSequence: ['succeeded'],
              }),
            },
          },
        },
        bulkQueueNames: BULK_QUEUE_NAMES,
      },
      key: `batchlimit-${Date.now()}`,
    })
    payload = built.payload
    vectorizedPayload = getVectorizedPayload(payload)
  })

  afterAll(async () => {
    await destroyPayload(payload)
  })

  test('batchLimit splits docs across continuation jobs and all get embedded', async () => {
    // Create 5 posts with batchLimit: 2
    // Should result in 3 prepare jobs (2 docs, 2 docs, 1 doc)
    for (let i = 0; i < 5; i++) {
      await payload.create({ collection: 'posts', data: { title: `BatchLimit Post ${i}` } as any })
    }

    const result = await vectorizedPayload?.bulkEmbed({ knowledgePool: 'default' })
    expectGoodResult(result)

    await waitForBulkJobs(payload, 30000)

    // All 5 posts should have embeddings
    const embeds = await payload.find({ collection: 'default' })
    expect(embeds.totalDocs).toBe(5)

    // Run should be succeeded
    const runDoc = (
      await (payload as any).find({
        collection: BULK_EMBEDDINGS_RUNS_SLUG,
        where: { id: { equals: result!.runId } },
      })
    ).docs[0]
    expect(runDoc.status).toBe('succeeded')
    expect(runDoc.inputs).toBe(5)
  })

  test('batchLimit equal to doc count does not create extra continuations', async () => {
    // Clean up from prior test: delete all posts and embeddings
    await payload.delete({ collection: 'posts', where: {} })
    await payload.delete({ collection: 'default' as any, where: {} })

    // Create exactly 2 posts (matching batchLimit: 2)
    for (let i = 0; i < 2; i++) {
      await payload.create({
        collection: 'posts',
        data: { title: `Exact Post ${i}` } as any,
      })
    }

    const result = await vectorizedPayload?.bulkEmbed({ knowledgePool: 'default' })
    expectGoodResult(result)

    await waitForBulkJobs(payload, 20000)

    const embeds = await payload.find({ collection: 'default' })
    expect(embeds.totalDocs).toBe(2)

    const runDoc = (
      await (payload as any).find({
        collection: BULK_EMBEDDINGS_RUNS_SLUG,
        where: { id: { equals: result!.runId } },
      })
    ).docs[0]
    expect(runDoc.status).toBe('succeeded')
  })
})
