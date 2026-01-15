import type { Payload, PayloadHandler } from 'payload'
import { BULK_EMBEDDINGS_BATCHES_SLUG } from '../collections/bulkEmbeddingsBatches.js'
import { BULK_EMBEDDINGS_RUNS_SLUG } from '../collections/bulkEmbeddingsRuns.js'
import { BULK_EMBEDDINGS_INPUT_METADATA_SLUG } from '../collections/bulkEmbeddingInputMetadata.js'
import type {
  KnowledgePoolDynamicConfig,
  KnowledgePoolName,
  RetryFailedBatchResult,
  BulkEmbeddingInput,
} from '../types.js'

/**
 * Core logic for retrying a failed batch.
 * Used by both the HTTP handler and VectorizedPayload.retryFailedBatch method.
 */
export async function retryBatch<TPoolNames extends KnowledgePoolName = KnowledgePoolName>(args: {
  payload: Payload
  batchId: string
  knowledgePools: Record<TPoolNames, KnowledgePoolDynamicConfig>
  queueName?: string
}): Promise<RetryFailedBatchResult> {
  const { payload, batchId, knowledgePools, queueName } = args

  // Find the batch
  let batch: any
  try {
    batch = await payload.findByID({
      collection: BULK_EMBEDDINGS_BATCHES_SLUG,
      id: batchId,
    })
  } catch {
    return { error: `Batch "${batchId}" not found` }
  }

  if (!batch) {
    return { error: `Batch "${batchId}" not found` }
  }

  // Check if batch is already retried - if so, return the retried batch
  if (batch.status === 'retried' && batch.retriedBatch) {
    const retriedBatchId =
      typeof batch.retriedBatch === 'object'
        ? String(batch.retriedBatch.id)
        : String(batch.retriedBatch)
    return {
      batchId,
      newBatchId: retriedBatchId,
      runId: String(batch.run && typeof batch.run === 'object' ? batch.run.id : batch.run),
      status: 'queued',
      message: 'Batch was already retried. Returning the retry batch.',
    }
  }

  // Verify batch has failed or retried status (retried batches can be retried again)
  if (batch.status !== 'failed' && batch.status !== 'retried') {
    return {
      error: `Batch "${batchId}" is not in failed or retried status. Current status: ${batch.status}`,
    }
  }

  // Get the parent run
  const runId = typeof batch.run === 'object' ? batch.run.id : batch.run
  const run = await payload.findByID({
    collection: BULK_EMBEDDINGS_RUNS_SLUG,
    id: String(runId),
  })

  if (!run) {
    return { error: `Parent run not found for batch "${batchId}"` }
  }

  // Only allow retry when run is in a terminal state
  const runStatus = (run as any).status
  if (runStatus === 'running' || runStatus === 'queued') {
    return {
      error: `Cannot retry batch while run is ${runStatus}. Wait for the run to complete first.`,
      conflict: true,
    }
  }

  const poolName = (run as any).pool as TPoolNames
  const poolConfig = knowledgePools[poolName]

  if (!poolConfig) {
    return { error: `Knowledge pool "${poolName}" not found` }
  }

  if (!poolConfig.embeddingConfig.bulkEmbeddingsFns) {
    return {
      error: `Knowledge pool "${poolName}" does not have bulk embedding configured`,
    }
  }

  const callbacks = poolConfig.embeddingConfig.bulkEmbeddingsFns
  const batchIdNum = parseInt(batchId, 10)
  const runIdNum = parseInt(String(runId), 10)

  // Load all metadata for this batch to reconstruct chunks (with pagination)
  const metadataDocs: any[] = []
  let metadataPage = 1
  const metadataLimit = 1000 // Process in pages to avoid memory issues

  while (true) {
    const metadataResult = await payload.find({
      collection: BULK_EMBEDDINGS_INPUT_METADATA_SLUG,
      where: { batch: { equals: batchIdNum } },
      limit: metadataLimit,
      page: metadataPage,
    })

    const pageDocs = (metadataResult as any)?.docs || []
    metadataDocs.push(...pageDocs)

    const totalPages = (metadataResult as any)?.totalPages ?? metadataPage
    if (metadataPage >= totalPages || pageDocs.length === 0) break
    metadataPage++
  }

  if (metadataDocs.length === 0) {
    return {
      error: `No metadata found for batch "${batchId}". Cannot retry without chunk data.`,
    }
  }

  // Reconstruct chunks from metadata (only id and text for addChunk)
  const chunks: BulkEmbeddingInput[] = metadataDocs.map((meta: any) => ({
    id: meta.inputId,
    text: meta.text,
  }))

  // Find the highest batchIndex for this run to determine the new batch index
  const existingBatchesResult = await payload.find({
    collection: BULK_EMBEDDINGS_BATCHES_SLUG,
    where: { run: { equals: runIdNum } },
    limit: 1000,
    sort: '-batchIndex',
  })
  const existingBatches = (existingBatchesResult as any)?.docs || []
  const maxBatchIndex = existingBatches.length > 0 ? (existingBatches[0].batchIndex as number) : -1
  const newBatchIndex = maxBatchIndex + 1

  // Resubmit chunks via addChunk to get a new providerBatchId
  // Submit all chunks - addChunk will accumulate and return a BatchSubmission when ready
  let submission: { providerBatchId: string } | null = null
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    const isLastChunk = i === chunks.length - 1

    const result = await callbacks.addChunk({
      chunk,
      isLastChunk,
    })

    if (result) {
      submission = result
      break // Batch was submitted
    }
  }

  if (!submission) {
    return {
      error: 'Failed to resubmit batch - no providerBatchId was returned from addChunk',
    }
  }

  // Create the new batch
  const newBatch = await payload.create({
    collection: BULK_EMBEDDINGS_BATCHES_SLUG,
    data: {
      run: runIdNum,
      batchIndex: newBatchIndex,
      providerBatchId: submission.providerBatchId,
      status: 'queued',
      inputCount: chunks.length,
      succeededCount: 0,
      failedCount: 0,
      submittedAt: new Date().toISOString(),
    },
  })

  // Update metadata to point to the new batch
  await payload.update({
    collection: BULK_EMBEDDINGS_INPUT_METADATA_SLUG,
    where: { batch: { equals: batchIdNum } },
    data: {
      batch: newBatch.id,
    },
  })

  // Update the old batch to point to the new batch and set status to 'retried'
  await payload.update({
    collection: BULK_EMBEDDINGS_BATCHES_SLUG,
    id: batchId,
    data: {
      status: 'retried',
      retriedBatch: newBatch.id,
    },
  })

  // If the parent run is in failed/succeeded status, reset it to running
  if (runStatus === 'failed' || runStatus === 'succeeded') {
    await payload.update({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      id: String(runId),
      data: {
        status: 'running',
        completedAt: null,
      },
    })
  }

  // Queue the poll-or-complete task
  await payload.jobs.queue<'payloadcms-vectorize:poll-or-complete-bulk-embedding'>({
    task: 'payloadcms-vectorize:poll-or-complete-bulk-embedding',
    input: { runId: String(runId) },
    ...(queueName ? { queue: queueName } : {}),
  })

  return {
    batchId,
    newBatchId: String(newBatch.id),
    runId: String(runId),
    status: 'queued',
    message: 'Failed batch has been resubmitted and re-queued for processing',
  }
}

export const createRetryFailedBatchHandler = (
  knowledgePools: Record<KnowledgePoolName, KnowledgePoolDynamicConfig>,
  pollOrCompleteQueueName?: string,
): PayloadHandler => {
  const handler: PayloadHandler = async (req) => {
    if (!req || !req.json) {
      return Response.json({ error: 'Request is required' }, { status: 400 })
    }

    try {
      const body = await req.json()
      const batchId = body?.batchId as string

      if (!batchId) {
        return Response.json({ error: 'batchId is required and must be a string' }, { status: 400 })
      }

      const result = await retryBatch({
        payload: req.payload,
        batchId,
        knowledgePools,
        queueName: pollOrCompleteQueueName,
      })

      if ('error' in result) {
        if ('conflict' in result && result.conflict) {
          return Response.json(result, { status: 409 })
        }
        // Check if it's a "not found" error
        if (result.error.includes('not found')) {
          return Response.json(result, { status: 404 })
        }
        return Response.json(result, { status: 400 })
      }

      return Response.json(result, { status: 202 })
    } catch (error) {
      const errorMessage = (error as Error).message || String(error)
      req.payload.logger.error(`[payloadcms-vectorize] Failed to retry batch: ${errorMessage}`)
      return Response.json(
        {
          error: 'Failed to retry batch',
          details: errorMessage,
        },
        { status: 500 },
      )
    }
  }

  return handler
}
