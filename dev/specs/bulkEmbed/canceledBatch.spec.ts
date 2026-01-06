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

const DIMS = DEFAULT_DIMS
const dbName = `bulk_canceled_${Date.now()}`

describe('Bulk embed - canceled batch', () => {
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
  })

  test('canceled batch marks entire run as failed', async () => {
    const post = await payload.create({ collection: 'posts', data: { title: 'Cancel' } as any })

    const run = await payload.create({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      data: { pool: 'default', embeddingVersion: testEmbeddingVersion, status: 'queued' },
    })

    await payload.jobs.queue<'payloadcms-vectorize:prepare-bulk-embedding'>({
      task: 'payloadcms-vectorize:prepare-bulk-embedding',
      input: { runId: String(run.id) },
      req: { payload } as any,
      ...(BULK_QUEUE_NAMES.prepareBulkEmbedQueueName
        ? { queue: BULK_QUEUE_NAMES.prepareBulkEmbedQueueName }
        : {}),
    })

    await waitForBulkJobs(payload)

    const embeds = await payload.find({
      collection: 'default',
      where: { docId: { equals: String(post.id) } },
    })
    expect(embeds.totalDocs).toBe(0)
  })
})

