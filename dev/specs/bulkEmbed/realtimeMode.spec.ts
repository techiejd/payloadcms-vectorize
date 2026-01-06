import type { Payload } from 'payload'
import { beforeAll, describe, expect, test, vi } from 'vitest'
import { createVectorizeTask } from '../../../src/tasks/vectorize.js'
import {
  BULK_QUEUE_NAMES,
  DEFAULT_DIMS,
  buildPayloadWithIntegration,
  createMockBulkEmbeddings,
  createTestDb,
} from '../utils.js'
import { makeDummyEmbedDocs, makeDummyEmbedQuery, testEmbeddingVersion } from 'helpers/embed.js'

const DIMS = DEFAULT_DIMS
const dbName = `bulk_realtime_${Date.now()}`

describe('Bulk embed - realtime mode', () => {
  let payload: Payload
  let realtimeOptions: any

  beforeAll(async () => {
    realtimeOptions = {
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
      secret: 'test-secret',
      dims: DIMS,
      key: `realtime-${Date.now()}`,
    })
    payload = built.payload
  })

  test('realtime mode queues vectorize jobs when realTimeIngestionFn is provided', async () => {
    const post = await payload.create({
      collection: 'posts',
      data: { title: 'Realtime Test' } as any,
    })

    const vectorizeTask = createVectorizeTask({
      knowledgePools: realtimeOptions.knowledgePools,
    })
    const vectorizeHandler = vectorizeTask.handler as any

    await vectorizeHandler({
      input: { doc: post, collection: 'posts', knowledgePool: 'default' } as any,
      req: { payload } as any,
      inlineTask: vi.fn(),
      tasks: {} as any,
      job: {} as any,
    })

    const embeds = await payload.find({
      collection: 'default',
      where: { docId: { equals: String(post.id) } },
    })
    expect(embeds.totalDocs).toBeGreaterThan(0)
  })
})
