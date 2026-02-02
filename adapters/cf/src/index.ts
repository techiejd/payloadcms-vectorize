import type { DbAdapter } from 'payloadcms-vectorize'
import type { CloudflareVectorizeBindings, KnowledgePoolsConfig } from './types'
import embed from './embed'
import search from './search'

/**
 * Create a Cloudflare Vectorize integration for payloadcms-vectorize
 *
 * @param config Configuration for knowledge pools
 * @param bindings Cloudflare bindings (Vectorize)
 * @returns Object containing the DbAdapter instance
 *
 * @example
 * ```typescript
 * import { createCloudflareVectorizeIntegration } from '@payloadcms-vectorize/cf'
 *
 * const { adapter } = createCloudflareVectorizeIntegration(
 *   {
 *     mainKnowledgePool: {
 *       dims: 384,
 *     },
 *   },
 *   {
 *     vectorize: env.VECTORIZE,
 *   }
 * )
 * ```
 */
export const createCloudflareVectorizeIntegration = (
  config: KnowledgePoolsConfig,
  bindings: CloudflareVectorizeBindings,
): { adapter: DbAdapter } => {
  if (!bindings.vectorize) {
    throw new Error('[@payloadcms-vectorize/cf] Cloudflare Vectorize binding is required')
  }

  const adapter: DbAdapter = {
    getConfigExtension: () => {
      return {
        custom: {
          _cfVectorizeAdapter: true,
          _poolConfigs: config,
        },
      }
    },

    // Store bindings in request context for embed and search functions
    search: async (payload, queryEmbedding, poolName, limit, where) => {
      // Inject bindings into context
      if (!payload.context) {
        payload.context = {}
      }
      payload.context.vectorize = bindings.vectorize

      return search(payload, queryEmbedding, poolName, limit, where)
    },

    storeEmbedding: async (payload, poolName, id, embedding) => {
      // Inject bindings into context
      if (!payload.context) {
        payload.context = {}
      }
      payload.context.vectorize = bindings.vectorize

      return embed(payload, poolName, id, embedding)
    },

    deleteEmbeddings: async (payload, poolName, sourceCollection, docId) => {
      // Inject bindings into context
      if (!payload.context) {
        payload.context = {}
      }
      payload.context.vectorize = bindings.vectorize

      // Delete all embeddings for this document from Cloudflare Vectorize
      // First, query to find all matching IDs
      const vectorizeBinding = bindings.vectorize
      try {
        const results = await vectorizeBinding.query(new Array(384).fill(0), {
          topK: 10000,
          returnMetadata: true,
          where: {
            and: [
              { key: 'sourceCollection', value: sourceCollection },
              { key: 'docId', value: docId },
            ],
          },
        })

        const idsToDelete = (results.matches || []).map((match: any) => match.id)

        if (idsToDelete.length > 0) {
          await vectorizeBinding.delete(idsToDelete)
        }
      } catch (error) {
        const errorMessage = (error as Error).message || (error as any).toString()
        payload.logger.error(
          `[@payloadcms-vectorize/cf] Failed to delete embeddings: ${errorMessage}`,
        )
        throw new Error(`[@payloadcms-vectorize/cf] Failed to delete embeddings: ${errorMessage}`)
      }
    },
  }

  return { adapter }
}

export type { CloudflareVectorizeBindings, KnowledgePoolsConfig }
export type { KnowledgePoolsConfig as KnowledgePoolConfig }
