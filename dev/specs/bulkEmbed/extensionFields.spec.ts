import type { Payload } from 'payload'
import { beforeAll, describe, expect, test } from 'vitest'
import { BULK_EMBEDDINGS_RUNS_SLUG } from '../../../src/collections/bulkEmbeddingsRuns.js'
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

const DIMS = DEFAULT_DIMS
const dbName = `bulk_extfields_${Date.now()}`

describe('Bulk embed - extension fields', () => {
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
                toKnowledgePool: async (doc: any) => [
                  { chunk: doc.title, category: 'tech', priority: 3 },
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
      key: `extfields-${Date.now()}`,
    })
    payload = built.payload
    vectorizedPayload = getVectorizedPayload(payload)
  })

  test('extension fields are merged when writing embeddings', async () => {
    const post = await payload.create({
      collection: 'posts',
      data: { title: 'Ext merge' } as any,
    })
    const result = await vectorizedPayload?.bulkEmbed({ knowledgePool: 'default' })
    expectGoodResult(result)

    await waitForBulkJobs(payload)

    const embeds = await payload.find({
      collection: 'default',
      where: { docId: { equals: String(post.id) } },
    })
    expect(embeds.totalDocs).toBe(1)
    expect(embeds.docs[0]).toHaveProperty('category', 'tech')
    expect(embeds.docs[0]).toHaveProperty('priority', 3)
  })
})
