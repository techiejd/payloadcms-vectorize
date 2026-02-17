import type { Payload, PayloadHandler } from 'payload'
import { BULK_EMBEDDINGS_RUNS_SLUG } from '../collections/bulkEmbeddingsRuns.js'
import type { BulkEmbedResult, KnowledgePoolDynamicConfig, KnowledgePoolName } from '../types.js'
import { TASK_SLUG_PREPARE_BULK_EMBEDDING } from '../constants.js'

/**
 * Core logic for starting a bulk embed run.
 * Used by both the HTTP handler and VectorizedPayload.bulkEmbed method.
 */
export async function startBulkEmbed<
  TPoolNames extends KnowledgePoolName = KnowledgePoolName,
>(args: {
  payload: Payload
  knowledgePool: TPoolNames
  knowledgePools: Record<TPoolNames, KnowledgePoolDynamicConfig>
  queueName?: string
}): Promise<BulkEmbedResult> {
  const { payload, knowledgePool, knowledgePools, queueName } = args

  const poolConfig = knowledgePools[knowledgePool]
  if (!poolConfig) {
    throw new Error(`[payloadcms-vectorize] Knowledge pool "${knowledgePool}" not found`)
  }
  if (!poolConfig.embeddingConfig.bulkEmbeddingsFns) {
    throw new Error(
      `[payloadcms-vectorize] Knowledge pool "${knowledgePool}" does not have bulk embedding configured`,
    )
  }

  // Check for existing non-terminal run for this pool
  const existingActiveRun = await payload.find({
    collection: BULK_EMBEDDINGS_RUNS_SLUG,
    where: {
      and: [{ pool: { equals: knowledgePool } }, { status: { in: ['queued', 'running'] } }],
    },
    limit: 1,
  })

  if (existingActiveRun.totalDocs > 0) {
    const existing = existingActiveRun.docs[0] as any
    return {
      runId: String(existing.id),
      status: existing.status,
      message: `A bulk embedding run is already ${existing.status} for this knowledge pool. Wait for it to complete or cancel it first.`,
      conflict: true,
    }
  }

  const run = await payload.create({
    collection: BULK_EMBEDDINGS_RUNS_SLUG,
    data: {
      pool: knowledgePool,
      embeddingVersion: poolConfig.embeddingConfig.version,
      status: 'queued',
    },
  })

  await payload.jobs.queue<typeof TASK_SLUG_PREPARE_BULK_EMBEDDING>({
    task: TASK_SLUG_PREPARE_BULK_EMBEDDING,
    input: { runId: String(run.id) },
    ...(queueName ? { queue: queueName } : {}),
  })

  return {
    runId: String(run.id),
    status: 'queued',
  }
}

export const createBulkEmbedHandler = (
  knowledgePools: Record<KnowledgePoolName, KnowledgePoolDynamicConfig>,
  queueName?: string,
): PayloadHandler => {
  const handler: PayloadHandler = async (req) => {
    if (!req || !req.json) {
      return Response.json({ error: 'Request is required' }, { status: 400 })
    }
    try {
      const body = await req.json()
      const knowledgePool = body?.knowledgePool as KnowledgePoolName
      if (!knowledgePool) {
        return Response.json(
          { error: 'knowledgePool is required and must be a string' },
          { status: 400 },
        )
      }

      const result = await startBulkEmbed({
        payload: req.payload,
        knowledgePool,
        knowledgePools,
        queueName,
      })

      if ('conflict' in result && result.conflict) {
        return Response.json(result, { status: 409 })
      }

      return Response.json(result, { status: 202 })
    } catch (error) {
      const errorMessage = (error as Error).message || String(error)
      req.payload.logger.error(
        `[payloadcms-vectorize] Failed to queue bulk embed run: ${errorMessage}`,
      )
      return Response.json(
        {
          error: 'Failed to queue bulk embed run',
          details: errorMessage,
        },
        { status: 500 },
      )
    }
  }
  return handler
}
