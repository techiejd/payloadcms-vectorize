import type { Payload } from 'payload'
import { beforeAll, describe, expect, test } from 'vitest'
import { BULK_EMBEDDINGS_RUNS_SLUG } from '../../../src/collections/bulkEmbeddingsRuns.js'
import { BULK_EMBEDDINGS_BATCHES_SLUG } from '../../../src/collections/bulkEmbeddingsBatches.js'
import {
  BULK_QUEUE_NAMES,
  DEFAULT_DIMS,
  buildPayloadWithIntegration,
  createMockBulkEmbeddings,
  createTestDb,
  waitForBulkJobs,
} from '../utils.js'
import { makeDummyEmbedQuery, testEmbeddingVersion } from 'helpers/embed.js'
import { getVectorizedPayload, VectorizedPayload } from 'payloadcms-vectorize'
import { expectGoodResult } from '../utils.vitest.js'
import { createMockAdapter } from 'helpers/mockAdapter.js'

const DIMS = DEFAULT_DIMS
const dbName = `bulk_multibatch_${Date.now()}`

describe('Bulk embed - multiple batches', () => {
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
              },
            },
            embeddingConfig: {
              version: testEmbeddingVersion,
              queryFn: makeDummyEmbedQuery(DIMS),
              bulkEmbeddingsFns: createMockBulkEmbeddings({
                statusSequence: ['succeeded'],
                flushAfterChunks: 2,
              }),
            },
          },
        },
        bulkQueueNames: BULK_QUEUE_NAMES,
      },
      key: `multibatch-${Date.now()}`,
    })
    payload = built.payload
    vectorizedPayload = getVectorizedPayload(payload)
  })

  test('multiple batches are created when flushing after N chunks', async () => {
    // Create 5 posts (should result in 3 batches: 2, 2, 1)
    for (let i = 0; i < 5; i++) {
      await payload.create({ collection: 'posts', data: { title: `Post ${i}` } as any })
    }

    const result = await vectorizedPayload?.bulkEmbed({ knowledgePool: 'default' })
    expectGoodResult(result)

    await waitForBulkJobs(payload, 20000)

    const batches = await payload.find({
      collection: BULK_EMBEDDINGS_BATCHES_SLUG as any,
      where: { run: { equals: result!.runId } },
      sort: 'batchIndex',
    })
    expect(batches.totalDocs).toBe(3)
    expect(batches.docs[0]).toHaveProperty('batchIndex', 0)
    expect(batches.docs[1]).toHaveProperty('batchIndex', 1)
    expect(batches.docs[2]).toHaveProperty('batchIndex', 2)

    const embeds = await payload.find({
      collection: 'default',
    })
    expect(embeds.totalDocs).toBe(5)

    const runDoc = (
      await (payload as any).find({
        collection: BULK_EMBEDDINGS_RUNS_SLUG,
        where: { id: { equals: result!.runId } },
      })
    ).docs[0]
    expect(runDoc.totalBatches).toBe(3)
    expect(runDoc.status).toBe('succeeded')
  })
})
