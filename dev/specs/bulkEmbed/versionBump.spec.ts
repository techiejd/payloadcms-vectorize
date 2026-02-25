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
    // STEP 1: Build payload0 with old-version and run bulk embed
    const payload0 = await test.step('create payload0 and embed with old-version', async () => {
      const p = (
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
      payloadsToDestroy.push(p)

      post = await p.create({ collection: 'posts', data: { title: 'Old' } as any })

      const vectorizedPayload0 = getVectorizedPayload(p)
      const result0 = await vectorizedPayload0?.bulkEmbed({ knowledgePool: 'default' })
      expectGoodResult(result0)

      await waitForBulkJobs(p, 30000)
      return p
    })

    // STEP 2: Verify payload0's embeddings before proceeding
    await test.step('verify old-version embedding exists', async () => {
      const embeds0 = await payload0.find({
        collection: 'default',
        where: { docId: { equals: String(post.id) } },
      })
      expect(embeds0.totalDocs).toBe(1)
      expect(embeds0.docs[0].embeddingVersion).toBe('old-version')
    })

    // STEP 3: Build payload1 with new-version and run bulk embed
    const payload1 = await test.step('create payload1 and embed with new-version', async () => {
      const p = (
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
      payloadsToDestroy.push(p)

      const vectorizedPayload1 = getVectorizedPayload(p)
      const result1 = await vectorizedPayload1?.bulkEmbed({ knowledgePool: 'default' })
      expectGoodResult(result1)

      await waitForBulkJobs(p, 30000)
      return p
    })

    // STEP 4: Verify new-version replaced old-version
    await test.step('verify new-version embedding replaced old', async () => {
      const embeds1 = await payload1.find({
        collection: 'default',
        where: { docId: { equals: String(post.id) } },
      })
      expect(embeds1.totalDocs).toBe(1)
      expect(embeds1.docs[0].embeddingVersion).toBe('new-version')
    })
  })
})
