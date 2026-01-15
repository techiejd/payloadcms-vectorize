import type { Payload } from 'payload'
import { beforeAll, describe, expect, test } from 'vitest'
import {
  BULK_QUEUE_NAMES,
  DEFAULT_DIMS,
  buildPayloadWithIntegration,
  createMockBulkEmbeddings,
  createTestDb,
  waitForBulkJobs,
} from '../utils.js'
import { makeDummyEmbedQuery, testEmbeddingVersion } from 'helpers/embed.js'
import { getVectorizedPayload } from 'payloadcms-vectorize'
import { expectGoodResult } from '../utils.vitest.js'

const DIMS = DEFAULT_DIMS
const dbName = `bulk_multichunk_${Date.now()}`

describe('Bulk embed - multiple chunks with extension fields', () => {
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
                toKnowledgePool: async () => [
                  { chunk: 'Chunk 1', category: 'a', priority: 1 },
                  { chunk: 'Chunk 2', category: 'b', priority: 2 },
                ],
              },
            },
            extensionFields: [
              { name: 'category', type: 'text' },
              { name: 'priority', type: 'number' },
            ],
            embeddingConfig: {
              version: testEmbeddingVersion,
              queryFn: makeDummyEmbedQuery(DIMS),
              bulkEmbeddingsFns: createMockBulkEmbeddings({ statusSequence: ['succeeded'] }),
            },
          },
        },
        bulkQueueNames: BULK_QUEUE_NAMES,
      },
      secret: 'test-secret',
      dims: DIMS,
      key: `multichunk-${Date.now()}`,
    })
    payload = built.payload
  })

  test('multiple chunks keep their respective extension fields', async () => {
    const post = await payload.create({
      collection: 'posts',
      data: { title: 'Two' } as any,
    })

    const vectorizedPayload = getVectorizedPayload(payload)
    const result = await vectorizedPayload?.bulkEmbed({ knowledgePool: 'default' })
    expectGoodResult(result)

    await waitForBulkJobs(payload)

    const embeds = await payload.find({
      collection: 'default',
      where: { docId: { equals: String(post.id) } },
      sort: 'chunkIndex',
    })
    expect(embeds.totalDocs).toBe(2)
    expect(embeds.docs[0]).toMatchObject({ category: 'a', priority: 1, chunkIndex: 0 })
    expect(embeds.docs[1]).toMatchObject({ category: 'b', priority: 2, chunkIndex: 1 })
  })
})
