import type { Payload } from 'payload'
import { beforeAll, describe, expect, test } from 'vitest'
import { BULK_EMBEDDINGS_RUNS_SLUG } from '../../../src/collections/bulkEmbeddingsRuns.js'
import { BULK_EMBEDDINGS_BATCHES_SLUG } from '../../../src/collections/bulkEmbeddingsBatches.js'
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
const dbName = `bulk_ingestion_failure_${Date.now()}`

describe('Bulk embed - ingestion validation failures', () => {
  let payload: Payload

  beforeAll(async () => {
    await createTestDb({ dbName })
  })

  test('malformed chunk entry fails the bulk embedding run', async () => {
    // Use unique version to ensure this test only processes its own data
    const testVersion = `${testEmbeddingVersion}-ingestion-fail-${Date.now()}`

    const built = await buildPayloadWithIntegration({
      dbName,
      pluginOpts: {
        knowledgePools: {
          default: {
            collections: {
              posts: {
                // Malformed: second entry missing required "chunk" string
                toKnowledgePool: async () => [{ chunk: 'ok chunk' }, { bad: 'oops' } as any],
              },
            },
            embeddingConfig: {
              version: testVersion,
              queryFn: makeDummyEmbedQuery(DIMS),
              bulkEmbeddingsFns: createMockBulkEmbeddings({
                statusSequence: ['succeeded'],
              }),
            },
          },
        },
        bulkQueueNames: BULK_QUEUE_NAMES,
      },
      key: `ingestion-failure-${Date.now()}-${Math.random()}`,
    })
    payload = built.payload

    // Create a post
    await payload.create({
      collection: 'posts',
      data: { title: 'bad chunks' } as any,
    })

    const vectorizedPayload = getVectorizedPayload(payload)
    const result = await vectorizedPayload?.bulkEmbed({ knowledgePool: 'default' })
    expectGoodResult(result)

    // Wait for bulk jobs to finish (or fail)
    await waitForBulkJobs(payload, 15000)

    // Check the run status - should be failed
    const run = await payload.findByID({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      id: result!.runId,
    })

    expect(run.status).toBe('failed')

    // Check the prepare-bulk-embedding job failed with validation error
    const res = await payload.find({
      collection: 'payload-jobs',
      where: {
        and: [{ taskSlug: { equals: 'payloadcms-vectorize:prepare-bulk-embedding' } }],
      },
      limit: 1,
      sort: '-createdAt',
    })
    const failedJob = (res as any)?.docs?.[0]
    expect(failedJob.hasError).toBe(true)
    const errMsg = failedJob.error.message
    expect(errMsg).toMatch(/chunk/i)
    expect(errMsg).toMatch(/Invalid indices: 1/)

    // Ensure no embeddings were created (all-or-nothing validation)
    const embeddingsCount = await payload.count({ collection: 'default' })
    expect(embeddingsCount.totalDocs).toBe(0)

    // Ensure no batches were created (validation happens before batching)
    const batchesCount = await payload.count({ collection: BULK_EMBEDDINGS_BATCHES_SLUG })
    expect(batchesCount.totalDocs).toBe(0)
  })
})
