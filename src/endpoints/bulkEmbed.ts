import type { PayloadHandler } from 'payload'
import { BULK_EMBEDDINGS_RUNS_SLUG } from '../collections/bulkEmbeddingsRuns.js'
import type { KnowledgePoolDynamicConfig, KnowledgePoolName } from '../types.js'

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
      const poolConfig = knowledgePools[knowledgePool]
      if (!poolConfig) {
        return Response.json(
          { error: `Knowledge pool "${knowledgePool}" not found` },
          { status: 400 },
        )
      }

      const payload = req.payload
      const run = await payload.create({
        collection: BULK_EMBEDDINGS_RUNS_SLUG,
        data: {
          pool: knowledgePool,
          embeddingVersion: poolConfig.embeddingVersion,
          status: 'queued',
        },
      })

      await payload.jobs.queue<'payloadcms-vectorize:prepare-bulk-embedding'>({
        task: 'payloadcms-vectorize:prepare-bulk-embedding',
        input: {
          runId: String(run.id),
        },
        req,
        ...(queueName ? { queue: queueName } : {}),
      })

      return Response.json(
        {
          runId: String(run.id),
          status: 'queued',
        },
        { status: 202 },
      )
    } catch (error) {
      return Response.json({ error: 'Failed to queue bulk embed run' }, { status: 500 })
    }
  }
  return handler
}
