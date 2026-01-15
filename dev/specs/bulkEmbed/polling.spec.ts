import type { Payload } from 'payload'
import { beforeAll, describe, expect, test, vi } from 'vitest'
import { BULK_EMBEDDINGS_RUNS_SLUG } from '../../../src/collections/bulkEmbeddingsRuns.js'
import {
  BULK_QUEUE_NAMES,
  DEFAULT_DIMS,
  buildPayloadWithIntegration,
  createMockBulkEmbeddings,
  createTestDb,
  expectGoodResult,
  waitForBulkJobs,
} from '../utils.js'
import { getVectorizedPayload } from 'payloadcms-vectorize'
import { makeDummyEmbedQuery, testEmbeddingVersion } from 'helpers/embed.js'

const DIMS = DEFAULT_DIMS
const dbName = `bulk_polling_${Date.now()}`

describe('Bulk embed - polling requeue', () => {
  let payload: Payload

  beforeAll(async () => {
    await createTestDb({ dbName })
    const built = await buildPayloadWithIntegration({
      dbName,
      pluginOpts: {
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
                statusSequence: ['running', 'succeeded'],
              }),
            },
          },
        },
        bulkQueueNames: BULK_QUEUE_NAMES,
      },
      secret: 'test-secret',
      dims: DIMS,
      key: `polling-${Date.now()}`,
    })
    payload = built.payload
  })

  test('polling requeues when non-terminal then succeeds', async () => {
    const post = await payload.create({ collection: 'posts', data: { title: 'Loop' } as any })
    const queueSpy = vi.spyOn(payload.jobs, 'queue')
    const vectorizedPayload = getVectorizedPayload(payload)
    const result = await vectorizedPayload?.bulkEmbed({ knowledgePool: 'default' })
    expectGoodResult(result)

    await waitForBulkJobs(payload, 15000)

    expect(queueSpy).toHaveBeenNthCalledWith(
      2, // 2nd call
      expect.objectContaining({ task: 'payloadcms-vectorize:poll-or-complete-bulk-embedding' }),
    )
    expect(queueSpy).toHaveBeenNthCalledWith(
      3, // 3rd call
      expect.objectContaining({ task: 'payloadcms-vectorize:poll-or-complete-bulk-embedding' }),
    )

    const embeds = await payload.find({
      collection: 'default',
      where: { docId: { equals: String(post.id) } },
    })
    expect(embeds.totalDocs).toBe(1)
  })
})
