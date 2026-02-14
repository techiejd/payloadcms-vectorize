import { BasePayload, CollectionSlug, Where } from 'payload'
import { KnowledgePoolName, VectorSearchResult, getVectorizedPayload } from 'payloadcms-vectorize'
import type { CloudflareVectorizeBinding } from './types.js'

/**
 * Search for similar vectors in Cloudflare Vectorize
 */
export default async (
  payload: BasePayload,
  queryEmbedding: number[],
  poolName: KnowledgePoolName,
  limit: number = 10,
  where?: Where,
): Promise<Array<VectorSearchResult>> => {
  // Get Cloudflare binding from config
  const vectorizeBinding = getVectorizedPayload(payload)?.getDbAdapterCustom()?._vectorizeBinding as
    | CloudflareVectorizeBinding
    | undefined
  if (!vectorizeBinding) {
    throw new Error('[@payloadcms-vectorize/cf] Cloudflare Vectorize binding not found')
  }

  try {
    // Query Cloudflare Vectorize
    // The query returns the top-k most similar vectors
    const results = await vectorizeBinding.query(queryEmbedding, {
      topK: limit,
      returnMetadata: true,
    })

    if (!results.matches) {
      return []
    }

    // Fetch full documents from Payload for metadata
    const searchResults: VectorSearchResult[] = []

    for (const match of results.matches) {
      try {
        const doc = await payload.findByID({
          collection: poolName as CollectionSlug,
          id: match.id,
        })

        if (doc && (!where || matchesWhere(doc as Record<string, unknown>, where))) {
          // Extract fields excluding internal ones
          const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...docFields } =
            doc as Record<string, unknown>

          searchResults.push({
            id: match.id,
            score: match.score || 0,
            ...docFields, // Includes sourceCollection, docId, chunkText, embeddingVersion, extension fields
          } as VectorSearchResult)
        }
      } catch (_e) {
        // Document not found or error fetching, skip
      }
    }

    return searchResults
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e)
    payload.logger.error(`[@payloadcms-vectorize/cf] Search failed: ${errorMessage}`)
    throw new Error(`[@payloadcms-vectorize/cf] Search failed: ${errorMessage}`)
  }
}

/**
 * Simple WHERE clause matcher for basic filtering.
 * Supports: equals, in, exists, and, or
 */
function matchesWhere(doc: Record<string, unknown>, where: Where): boolean {
  if (!where || Object.keys(where).length === 0) return true

  // Handle 'and' operator
  if ('and' in where && Array.isArray(where.and)) {
    return where.and.every((clause: Where) => matchesWhere(doc, clause))
  }

  // Handle 'or' operator
  if ('or' in where && Array.isArray(where.or)) {
    return where.or.some((clause: Where) => matchesWhere(doc, clause))
  }

  // Handle field-level conditions
  for (const [field, condition] of Object.entries(where)) {
    if (field === 'and' || field === 'or') continue

    const value = doc[field]

    if (typeof condition === 'object' && condition !== null) {
      if ('equals' in condition && value !== condition.equals) {
        return false
      }
      if ('in' in condition && Array.isArray(condition.in) && !condition.in.includes(value)) {
        return false
      }
      if ('exists' in condition) {
        const exists = value !== undefined && value !== null
        if (condition.exists !== exists) return false
      }
    }
  }

  return true
}
