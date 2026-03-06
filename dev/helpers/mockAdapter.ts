import type { DbAdapter, KnowledgePoolName, StoreChunkData, VectorSearchResult } from 'payloadcms-vectorize'
import type { CollectionSlug, Payload, BasePayload, Where, Config } from 'payload'

type StoredEmbedding = {
  poolName: string
  id: string
  embedding: number[]
}

type MockAdapterOptions = {
  /** Custom bins to return from getConfigExtension */
  bins?: { key: string; scriptPath: string }[]
  /** Custom data to return from getConfigExtension */
  custom?: Record<string, any>
}

/**
 * Cosine similarity between two vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`)
  }
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/**
 * Creates a mock DbAdapter for testing that stores embeddings in memory.
 * This allows testing the core plugin without requiring a database.
 */
export const createMockAdapter = (options: MockAdapterOptions = {}): DbAdapter => {
  const { bins = [], custom = {} } = options
  // In-memory storage for embeddings, keyed by `${poolName}:${id}`
  const storage = new Map<string, StoredEmbedding>()

  return {
    getConfigExtension: (_config: Config) => ({
      bins,
      custom: { _isMockAdapter: true, ...custom },
    }),

    storeChunk: async (
      payload: Payload,
      poolName: KnowledgePoolName,
      data: StoreChunkData,
    ): Promise<void> => {
      const embeddingArray = Array.isArray(data.embedding) ? data.embedding : Array.from(data.embedding)

      const created = await payload.create({
        collection: poolName as CollectionSlug,
        data: {
          sourceCollection: data.sourceCollection,
          docId: data.docId,
          chunkIndex: data.chunkIndex,
          chunkText: data.chunkText,
          embeddingVersion: data.embeddingVersion,
          embedding: embeddingArray,
          ...data.extensionFields,
        },
      })

      const key = `${poolName}:${created.id}`
      storage.set(key, {
        poolName,
        id: String(created.id),
        embedding: embeddingArray,
      })
    },

    deleteChunks: async (
      payload: Payload,
      poolName: KnowledgePoolName,
      sourceCollection: string,
      docId: string,
    ): Promise<void> => {
      for (const [key, stored] of storage) {
        if (stored.poolName === poolName) {
          try {
            const doc = await payload.findByID({
              collection: poolName as CollectionSlug,
              id: stored.id,
            })
            if (doc && (doc as any).sourceCollection === sourceCollection && (doc as any).docId === docId) {
              storage.delete(key)
            }
          } catch (_e) {}
        }
      }

      await payload.delete({
        collection: poolName as CollectionSlug,
        where: {
          and: [
            { sourceCollection: { equals: sourceCollection } },
            { docId: { equals: docId } },
          ],
        },
      })
    },

    hasEmbeddingVersion: async (
      payload: Payload,
      poolName: KnowledgePoolName,
      sourceCollection: string,
      docId: string,
      embeddingVersion: string,
    ): Promise<boolean> => {
      const result = await payload.find({
        collection: poolName as CollectionSlug,
        where: {
          and: [
            { sourceCollection: { equals: sourceCollection } },
            { docId: { equals: docId } },
            { embeddingVersion: { equals: embeddingVersion } },
          ],
        },
        limit: 1,
      })
      return result.totalDocs > 0
    },

    search: async (
      payload: BasePayload,
      queryEmbedding: number[],
      poolName: string,
      limit: number = 10,
      where?: Where,
    ): Promise<VectorSearchResult[]> => {
      const results: Array<VectorSearchResult & { _score: number }> = []

      // Find all embeddings for this pool
      for (const [_key, stored] of storage) {
        if (stored.poolName !== poolName) continue

        // Calculate score using cosine similarity
        const score = cosineSimilarity(queryEmbedding, stored.embedding)

        // Fetch the document from Payload to get metadata
        try {
          const doc = await payload.findByID({
            collection: poolName as any,
            id: stored.id,
          })

          if (doc) {
            // Apply basic where filtering if provided
            if (where && !matchesWhere(doc, where)) {
              continue
            }

            // Extract all fields except internal ones, including extension fields
            const {
              id: _id,
              createdAt: _createdAt,
              updatedAt: _updatedAt,
              embedding: _embedding,
              ...docFields
            } = doc as any

            results.push({
              id: stored.id,
              score,
              _score: score, // For sorting
              ...docFields, // Includes sourceCollection, docId, chunkText, embeddingVersion, AND extension fields
            })
          }
        } catch (_e) {
          // Document not found, skip
        }
      }

      // Sort by score descending and apply limit
      return results
        .sort((a, b) => b._score - a._score)
        .slice(0, limit)
        .map(({ _score, ...rest }) => rest)
    },
  }
}

/**
 * Simple WHERE clause matcher for basic filtering
 * Supports: equals, in, exists, and, or
 */
function matchesWhere(doc: Record<string, any>, where: Where): boolean {
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
