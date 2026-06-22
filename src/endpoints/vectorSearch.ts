import type { BasePayload, PayloadHandler, Where } from 'payload'

import type {
  KnowledgePoolName,
  KnowledgePoolDynamicConfig,
  VectorSearchQuery,
  DbAdapter,
} from '../types.js'

export const createVectorSearchHandlers = (
  knowledgePools: Record<KnowledgePoolName, KnowledgePoolDynamicConfig>,
  adapter: DbAdapter,
) => {
  const vectorSearch = async (
    payload: BasePayload,
    query: string,
    knowledgePool: KnowledgePoolName,
    limit?: number,
    where?: Where,
    populateEmbedding?: boolean,
  ) => {
    const poolConfig = knowledgePools[knowledgePool]
    const queryEmbedding = await (async () => {
      const qE = await poolConfig.embeddingConfig.queryFn(query)
      return Array.isArray(qE) ? qE : Array.from(qE)
    })()

    const rerank = poolConfig.embeddingConfig.rerank

    if (!rerank) {
      return adapter.search(payload, queryEmbedding, knowledgePool, limit, where, populateEmbedding)
    }

    const effectiveLimit = limit ?? 10
    const fetchLimit = Math.floor(effectiveLimit * rerank.multiplier)

    const candidates = await adapter.search(
      payload,
      queryEmbedding,
      knowledgePool,
      fetchLimit,
      where,
      populateEmbedding,
    )

    const reranked = await rerank.callback(query, candidates)
    return reranked.slice(0, effectiveLimit)
  }

  const searchByEmbedding = async (
    payload: BasePayload,
    embedding: number[],
    knowledgePool: KnowledgePoolName,
    limit?: number,
    where?: Where,
    populateEmbedding?: boolean,
  ) => {
    return adapter.search(payload, embedding, knowledgePool, limit, where, populateEmbedding)
  }

  const requestHandler: PayloadHandler = async (req) => {
    if (!req || !req.json) {
      return Response.json({ error: 'Request is required' }, { status: 400 })
    }
    try {
      const { query, knowledgePool, where, limit = 10 }: VectorSearchQuery = await req.json()
      if (!query || typeof query !== 'string') {
        return Response.json({ error: 'Query is required and must be a string' }, { status: 400 })
      }
      if (!knowledgePool || typeof knowledgePool !== 'string') {
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

      // populateEmbedding is intentionally not exposed over HTTP — it's a programmatic-only
      // option, kept out of the REST response to avoid shipping large vectors over the wire.
      const results = await vectorSearch(payload, query, knowledgePool, limit, where)

      return Response.json({ results })
    } catch (error) {
      return Response.json({ error: `Internal server error: ${error}` }, { status: 500 })
    }
  }
  return { vectorSearch, searchByEmbedding, requestHandler }
}
