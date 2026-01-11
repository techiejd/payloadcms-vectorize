import type { Payload, PayloadHandler } from 'payload'
import { BULK_EMBEDDINGS_BATCHES_SLUG } from '../collections/bulkEmbeddingsBatches.js'
import { BULK_EMBEDDINGS_RUNS_SLUG } from '../collections/bulkEmbeddingsRuns.js'
import type {
  KnowledgePoolDynamicConfig,
  KnowledgePoolName,
  RetryFailedBatchResult,
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

  // Verify batch has failed status
  if (batch.status !== 'failed') {
    return {
      error: `Batch "${batchId}" is not in failed status. Current status: ${batch.status}`,
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

  // Reset the batch status to queued
  await payload.update({
    collection: BULK_EMBEDDINGS_BATCHES_SLUG,
    id: batchId,
    data: {
      status: 'queued',
      error: null,
      completedAt: null,
      succeededCount: 0,
      failedCount: 0,
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
    runId: String(runId),
    status: 'queued',
    message: 'Failed batch has been re-queued for processing',
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
