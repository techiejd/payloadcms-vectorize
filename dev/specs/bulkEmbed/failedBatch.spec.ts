import type { Payload } from 'payload'
import { beforeAll, describe, expect, test } from 'vitest'
import { BULK_EMBEDDINGS_RUNS_SLUG } from '../../../src/collections/bulkEmbeddingsRuns.js'
import { BULK_EMBEDDINGS_BATCHES_SLUG } from '../../../src/collections/bulkEmbeddingsBatches.js'
import { BULK_EMBEDDINGS_INPUT_METADATA_SLUG } from '../../../src/collections/bulkEmbeddingInputMetadata.js'
import { getVectorizedPayload, VectorizedPayload } from '../../../src/types.js'
import {
  BULK_QUEUE_NAMES,
  DEFAULT_DIMS,
  buildPayloadWithIntegration,
  createMockBulkEmbeddings,
  createTestDb,
  waitForBulkJobs,
} from '../utils.js'
import { makeDummyEmbedQuery, testEmbeddingVersion } from 'helpers/embed.js'
import { expectGoodResult } from '../utils.vitest.js'
import { createMockAdapter } from 'helpers/mockAdapter.js'

const DIMS = DEFAULT_DIMS
const dbName = `bulk_failed_${Date.now()}`

describe('Bulk embed - failed batch', () => {
  let payload: Payload
  let vectorizedPayload: VectorizedPayload | null = null

  beforeAll(async () => {
    await createTestDb({ dbName })
    const built = await buildPayloadWithIntegration({
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
              version: testEmbeddingVersion,
              queryFn: makeDummyEmbedQuery(DIMS),
              bulkEmbeddingsFns: createMockBulkEmbeddings({ statusSequence: ['failed'] }),
            },
          },
        },
        bulkQueueNames: BULK_QUEUE_NAMES,
      },
      key: `failed-${Date.now()}`,
    })
    payload = built.payload
    vectorizedPayload = getVectorizedPayload(payload)
  })

  test('failed batch marks entire run as failed', async () => {
    const post = await payload.create({ collection: 'posts', data: { title: 'Fail' } as any })

    const result = await vectorizedPayload?.bulkEmbed({ knowledgePool: 'default' })
    expectGoodResult(result)

    await waitForBulkJobs(payload)

    const runDoc = (
      await (payload as any).find({
        collection: BULK_EMBEDDINGS_RUNS_SLUG,
        where: { id: { equals: String(result!.runId) } },
      })
    ).docs[0]
    expect(runDoc.status).toBe('failed')

    const embeds = await payload.find({
      collection: 'default',
      where: { docId: { equals: String(post.id) } },
    })
    expect(embeds.totalDocs).toBe(0)
  })

  test('metadata table is kept after failed run (to allow retries)', async () => {
    const post = await payload.create({
      collection: 'posts',
      data: { title: 'FailCleanup' } as any,
    })

    const result = await vectorizedPayload?.bulkEmbed({ knowledgePool: 'default' })
    expectGoodResult(result)

    await waitForBulkJobs(payload)

    const runIdNum = parseInt(String(result!.runId), 10)

    // Metadata should be kept for failed batches to allow retries
    const metadata = await payload.find({
      collection: BULK_EMBEDDINGS_INPUT_METADATA_SLUG,
      where: { run: { equals: runIdNum } as any },
    })
    expect(metadata.totalDocs).toBeGreaterThan(0)

    // Verify no partial embeddings were written (no partial writes)
    const embeds = await payload.find({
      collection: 'default',
      where: { docId: { equals: String(post.id) } },
    })
    expect(embeds.totalDocs).toBe(0)
  })

  test('cannot retry batch while run is still running', async () => {
    const vectorizedPayload = getVectorizedPayload<'default'>(payload)!
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
    const result = await vectorizedPayload.retryFailedBatch({ batchId: String(batch.id) })

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

  test('retrying a failed batch creates a new batch and marks old batch as retried', async () => {
    const vectorizedPayload = getVectorizedPayload<'default'>(payload)!
    await payload.create({ collection: 'posts', data: { title: 'RetryTest' } as any })

    const result = await vectorizedPayload?.bulkEmbed({ knowledgePool: 'default' })
    expectGoodResult(result)

    await waitForBulkJobs(payload)

    // Find the failed batch
    const batchesResult = await payload.find({
      collection: BULK_EMBEDDINGS_BATCHES_SLUG,
      where: { run: { equals: result.runId } },
    })
    const failedBatch = (batchesResult as any).docs[0]
    expect(failedBatch.status).toBe('failed')

    // Retry the batch
    const retryResult = await vectorizedPayload.retryFailedBatch({
      batchId: String(failedBatch.id),
    })

    expect('error' in retryResult).toBe(false)
    if (!('error' in retryResult)) {
      expect(retryResult.newBatchId).toBeDefined()
      expect(retryResult.status).toBe('queued')
      expect(retryResult.message).toContain('resubmitted')

      // Check that the old batch is marked as retried
      const oldBatch = await payload.findByID({
        collection: BULK_EMBEDDINGS_BATCHES_SLUG,
        id: String(failedBatch.id),
      })
      expect((oldBatch as any).status).toBe('retried')
      expect((oldBatch as any).retriedBatch).toBeDefined()

      // Check that the new batch exists and is queued
      const newBatch = await payload.findByID({
        collection: BULK_EMBEDDINGS_BATCHES_SLUG,
        id: retryResult.newBatchId!,
      })
      expect((newBatch as any).status).toBe('queued')
      expect((newBatch as any).providerBatchId).toBeDefined()
      expect((newBatch as any).providerBatchId).not.toBe(failedBatch.providerBatchId)

      // Check that metadata points to the new batch
      const runIdNum = parseInt(String(result!.runId), 10)
      const metadata = await payload.find({
        collection: BULK_EMBEDDINGS_INPUT_METADATA_SLUG,
        where: { run: { equals: runIdNum } },
      })
      expect(metadata.totalDocs).toBeGreaterThan(0)
      // All metadata should point to the new batch
      for (const meta of (metadata as any).docs) {
        const metaBatchId =
          typeof meta.batch === 'object' ? meta.batch.id : parseInt(String(meta.batch), 10)
        expect(metaBatchId).toBe(parseInt(retryResult.newBatchId!, 10))
      }
    }
  })

  test('retrying a retried batch returns the existing retry batch', async () => {
    const vectorizedPayload = getVectorizedPayload<'default'>(payload)!
    await payload.create({
      collection: 'posts',
      data: { title: 'RetryRetryTest' } as any,
    })

    const result = await vectorizedPayload?.bulkEmbed({ knowledgePool: 'default' })

    await waitForBulkJobs(payload)

    // Find the failed batch
    const batchesResult = await payload.find({
      collection: BULK_EMBEDDINGS_BATCHES_SLUG,
      where: { run: { equals: result!.runId } },
    })
    const failedBatch = (batchesResult as any).docs[0]

    // Retry the batch first time
    const firstRetryResult = await vectorizedPayload.retryFailedBatch({
      batchId: String(failedBatch.id),
    })
    expect('error' in firstRetryResult).toBe(false)
    if ('error' in firstRetryResult) return

    const firstRetryBatchId = firstRetryResult.newBatchId!

    // Retry the retried batch - should return the existing retry batch
    const secondRetryResult = await vectorizedPayload.retryFailedBatch({
      batchId: String(failedBatch.id),
    })

    expect('error' in secondRetryResult).toBe(false)
    if (!('error' in secondRetryResult)) {
      expect(secondRetryResult.newBatchId).toBe(firstRetryBatchId)
      expect(secondRetryResult.message).toContain('already retried')
    }
  })
})
