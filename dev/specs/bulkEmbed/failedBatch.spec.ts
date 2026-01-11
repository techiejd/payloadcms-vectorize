import type { Payload } from 'payload'
import { beforeAll, describe, expect, test } from 'vitest'
import { BULK_EMBEDDINGS_RUNS_SLUG } from '../../../src/collections/bulkEmbeddingsRuns.js'
import { BULK_EMBEDDINGS_BATCHES_SLUG } from '../../../src/collections/bulkEmbeddingsBatches.js'
import { BULK_EMBEDDINGS_INPUT_METADATA_SLUG } from '../../../src/collections/bulkEmbeddingInputMetadata.js'
import type { VectorizedPayload } from '../../../src/types.js'
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
const dbName = `bulk_failed_${Date.now()}`

describe('Bulk embed - failed batch', () => {
  let payload: VectorizedPayload<'default'>

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
              bulkEmbeddingsFns: createMockBulkEmbeddings({ statusSequence: ['failed'] }),
            },
          },
        },
        bulkQueueNames: BULK_QUEUE_NAMES,
      },
      secret: 'test-secret',
      dims: DIMS,
      key: `failed-${Date.now()}`,
    })
    payload = built.payload as VectorizedPayload<'default'>
  })

  test('failed batch marks entire run as failed', async () => {
    const post = await payload.create({ collection: 'posts', data: { title: 'Fail' } as any })

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

    const runDoc = (
      await (payload as any).find({
        collection: BULK_EMBEDDINGS_RUNS_SLUG,
        where: { id: { equals: String(run.id) } },
      })
    ).docs[0]
    expect(runDoc.status).toBe('failed')

    const embeds = await payload.find({
      collection: 'default',
      where: { docId: { equals: String(post.id) } },
    })
    expect(embeds.totalDocs).toBe(0)
  })

  test('metadata table is cleaned after failed run (no partial writes)', async () => {
    await payload.create({ collection: 'posts', data: { title: 'FailCleanup' } as any })

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

    const metadata = await payload.find({
      collection: BULK_EMBEDDINGS_INPUT_METADATA_SLUG,
      where: { run: { exists: true } },
    })
    expect(metadata.totalDocs).toBe(0)
  })

  test('cannot retry batch while run is still running', async () => {
    // Create a run in 'running' status
    const run = await (payload as any).create({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      data: {
        pool: 'default',
        embeddingVersion: testEmbeddingVersion,
        status: 'running',
      },
    })

    // Create a failed batch for this running run
    const batch = await (payload as any).create({
      collection: BULK_EMBEDDINGS_BATCHES_SLUG,
      data: {
        run: run.id,
        batchIndex: 0,
        providerBatchId: `mock-failed-lock-test-${Date.now()}`,
        status: 'failed',
        inputCount: 1,
        error: 'Test error for lock test',
      },
    })

    // Try to retry the batch while run is running - should be rejected
    const result = await payload.retryFailedBatch({ batchId: String(batch.id) })

    expect('error' in result).toBe(true)
    expect('conflict' in result && result.conflict).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain('Cannot retry batch while run is running')
    }

    // Cleanup: mark the run as failed so the batch can be retried in the future
    await (payload as any).update({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      id: run.id,
      data: {
        status: 'failed',
        completedAt: new Date().toISOString(),
      },
    })
  })
})
