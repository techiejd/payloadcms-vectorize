import type { Payload } from 'payload'
import { beforeAll, describe, expect, test } from 'vitest'
import {
  BULK_QUEUE_NAMES,
  DEFAULT_DIMS,
  buildPayloadWithIntegration,
  createMockBulkEmbeddings,
  createTestDb,
  expectGoodResult,
  waitForBulkJobs,
} from '../utils.js'
import { makeDummyEmbedQuery, testEmbeddingVersion } from 'helpers/embed.js'
import { getVectorizedPayload, VectorizedPayload } from 'payloadcms-vectorize'

const DIMS = DEFAULT_DIMS
const dbName = `bulk_canceled_${Date.now()}`

// Right now, we only test if the batch was canceled outside of the bulk embed process.
// TODO(techiejd): Add a way to cancel a batch and/or a run inside the bulk embed process.

describe('Bulk embed - canceled batch', () => {
  let payload: Payload
  let vectorizedPayload: VectorizedPayload | null = null

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
              bulkEmbeddingsFns: createMockBulkEmbeddings({ statusSequence: ['canceled'] }),
            },
          },
        },
        bulkQueueNames: BULK_QUEUE_NAMES,
      },
      secret: 'test-secret',
      dims: DIMS,
      key: `canceled-${Date.now()}`,
    })
    payload = built.payload
    vectorizedPayload = getVectorizedPayload(payload)
  })

  test('canceled batch marks entire run as failed', async () => {
    const post = await payload.create({ collection: 'posts', data: { title: 'Cancel' } as any })
    const result = await vectorizedPayload?.bulkEmbed({ knowledgePool: 'default' })
    expectGoodResult(result)

    await waitForBulkJobs(payload)

    const embeds = await payload.find({
      collection: 'default',
      where: { docId: { equals: String(post.id) } },
    })
    expect(embeds.totalDocs).toBe(0)
  })
})
