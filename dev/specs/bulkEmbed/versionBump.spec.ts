import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  BULK_QUEUE_NAMES,
  DEFAULT_DIMS,
  buildPayloadWithIntegration,
  createMockBulkEmbeddings,
  createTestDb,
  destroyPayload,
  waitForBulkJobs,
} from '../utils.js'
import { makeDummyEmbedQuery } from 'helpers/embed.js'
import { getVectorizedPayload } from '../../../src/types.js'
import { expectGoodResult } from '../utils.vitest.js'
import { createMockAdapter } from 'helpers/mockAdapter.js'

const DIMS = DEFAULT_DIMS
const dbName = `bulk_version_${Date.now()}`

// Use distinct queue names per payload instance so that each instance's
// cron worker only processes its own jobs and doesn't interfere with the other.
const QUEUE_NAMES_0 = {
  realtimeQueueName: 'vectorize-realtime-v0',
  bulkQueueNames: BULK_QUEUE_NAMES,
}
const QUEUE_NAMES_1 = {
  realtimeQueueName: 'vectorize-realtime-v1',
  bulkQueueNames: {
    prepareBulkEmbedQueueName: `${BULK_QUEUE_NAMES.prepareBulkEmbedQueueName}-v2`,
    pollOrCompleteQueueName: `${BULK_QUEUE_NAMES.pollOrCompleteQueueName}-v2`,
  },
}

describe('Bulk embed - version bump', () => {
  let post: any
  const payloadsToDestroy: any[] = []
  beforeAll(async () => {
    await createTestDb({ dbName })
  })

  afterAll(async () => {
    for (const p of payloadsToDestroy) {
      await destroyPayload(p)
    }
  })

  test('version bump re-embeds all even without updates', async () => {
    const payload0 = (
      await buildPayloadWithIntegration({
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
                version: 'old-version',
                queryFn: makeDummyEmbedQuery(DIMS),
                bulkEmbeddingsFns: createMockBulkEmbeddings({ statusSequence: ['succeeded'] }),
              },
            },
          },
          realtimeQueueName: QUEUE_NAMES_0.realtimeQueueName,
          bulkQueueNames: QUEUE_NAMES_0.bulkQueueNames,
        },
        key: `payload0-${Date.now()}`,
      })
    ).payload

    payloadsToDestroy.push(payload0)

    post = await payload0.create({ collection: 'posts', data: { title: 'Old' } as any })

    const vectorizedPayload0 = getVectorizedPayload(payload0)
    const result0 = await vectorizedPayload0?.bulkEmbed({ knowledgePool: 'default' })
    expectGoodResult(result0)

    await waitForBulkJobs(payload0)

    const embeds0 = await payload0.find({
      collection: 'default',
      where: { docId: { equals: String(post.id) } },
    })
    expect(embeds0.totalDocs).toBe(1)
    expect(embeds0.docs[0].embeddingVersion).toBe('old-version')

    const payload1 = (
      await buildPayloadWithIntegration({
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
                version: 'new-version',
                queryFn: makeDummyEmbedQuery(DIMS),
                bulkEmbeddingsFns: createMockBulkEmbeddings({ statusSequence: ['succeeded'] }),
              },
            },
          },
          realtimeQueueName: QUEUE_NAMES_1.realtimeQueueName,
          bulkQueueNames: QUEUE_NAMES_1.bulkQueueNames,
        },
        key: `payload1-${Date.now()}`,
        skipMigrations: true,
      })
    ).payload

    payloadsToDestroy.push(payload1)

    const vectorizedPayload1 = getVectorizedPayload(payload1)
    const result1 = await vectorizedPayload1?.bulkEmbed({ knowledgePool: 'default' })
    expectGoodResult(result1)

    await waitForBulkJobs(payload1)

    const embeds1 = await payload1.find({
      collection: 'default',
      where: { docId: { equals: String(post.id) } },
    })

    expect(embeds1.totalDocs).toBe(1)
    expect(embeds1.docs[0].embeddingVersion).toBe('new-version')
  })
})
