import type { Payload } from 'payload'
import { beforeAll, describe, expect, test } from 'vitest'
import {
  BULK_QUEUE_NAMES,
  DEFAULT_DIMS,
  buildPayloadWithIntegration,
  createMockBulkEmbeddings,
  createTestDb,
  waitForVectorizationJobs,
} from '../utils.js'
import { makeDummyEmbedDocs, makeDummyEmbedQuery, testEmbeddingVersion } from 'helpers/embed.js'
import { createMockAdapter } from 'helpers/mockAdapter.js'

const DIMS = DEFAULT_DIMS
const dbName = `bulk_realtime_${Date.now()}`

describe('Bulk embed - realtime mode', () => {
  let payload: Payload
  let realtimeOptions: any

  beforeAll(async () => {
    realtimeOptions = {
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
            realTimeIngestionFn: makeDummyEmbedDocs(DIMS),
            bulkEmbeddingsFns: createMockBulkEmbeddings({ statusSequence: ['succeeded'] }),
          },
        },
      },
      bulkQueueNames: BULK_QUEUE_NAMES,
    }

    await createTestDb({ dbName })
    const built = await buildPayloadWithIntegration({
      dbName,
      pluginOpts: realtimeOptions,
      key: `realtime-${Date.now()}`,
    })
    payload = built.payload
  })

  test('realtime mode queues vectorize jobs when realTimeIngestionFn is provided', async () => {
    const post = await payload.create({
      collection: 'posts',
      data: { title: 'Realtime Test' } as any,
    })

    await waitForVectorizationJobs(payload)

    const embeds = await payload.find({
      collection: 'default',
      where: { docId: { equals: String(post.id) } },
    })
    expect(embeds.totalDocs).toBeGreaterThan(0)
  })
})
