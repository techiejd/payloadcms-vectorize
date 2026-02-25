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

// Use distinct bulk queue names per payload instance so that
// the second payload's cron worker handles its own bulk runs,
// instead of the first payload instance continuing to process them.
const BULK_QUEUE_NAMES_0 = BULK_QUEUE_NAMES
const BULK_QUEUE_NAMES_1 = {
  prepareBulkEmbedQueueName: `${BULK_QUEUE_NAMES.prepareBulkEmbedQueueName}-v2`,
  pollOrCompleteQueueName: `${BULK_QUEUE_NAMES.pollOrCompleteQueueName}-v2`,
}

describe('Bulk embed - version bump', () => {
  let post: any
  let payload1: any = null
  beforeAll(async () => {
    await createTestDb({ dbName })
  })

  afterAll(async () => {
    await destroyPayload(payload1)
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
          bulkQueueNames: BULK_QUEUE_NAMES_0,
        },
        key: `payload0`,
      })
    ).payload

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

    // Destroy payload0 before creating payload1 to prevent cron worker interference
    await destroyPayload(payload0)

    payload1 = (
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
          bulkQueueNames: BULK_QUEUE_NAMES_1,
        },
        key: `payload1`,
        skipMigrations: true,
      })
    ).payload

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
