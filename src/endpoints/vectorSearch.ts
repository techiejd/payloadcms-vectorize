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
  ) => {
    const poolConfig = knowledgePools[knowledgePool]
    // Generate embedding for the query using pool-specific embedQuery
    const queryEmbedding = await (async () => {
      const qE = await poolConfig.embeddingConfig.queryFn(query)
      return Array.isArray(qE) ? qE : Array.from(qE)
    })()

    // Perform cosine similarity search using Drizzle
    return await adapter.search(payload, queryEmbedding, knowledgePool, limit, where)
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

      const results = await vectorSearch(payload, query, knowledgePool, limit, where)

      return Response.json({ results })
    } catch (error) {
      return Response.json({ error: `Internal server error: ${error}` }, { status: 500 })
    }
  }
  return { vectorSearch, requestHandler }
}
