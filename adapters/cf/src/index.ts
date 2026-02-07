import type { DbAdapter } from 'payloadcms-vectorize'
import type { CloudflareVectorizeBinding, KnowledgePoolsConfig } from './types.js'
import embed from './embed.js'
import search from './search.js'

/**
 * Configuration for Cloudflare Vectorize integration
 */
interface CloudflareVectorizeConfig {
  /** Knowledge pools configuration with their dimensions */
  config: KnowledgePoolsConfig
  /** Cloudflare Vectorize binding for vector storage */
  binding: CloudflareVectorizeBinding
}

/**
 * Create a Cloudflare Vectorize integration for payloadcms-vectorize
 *
 * @param options Configuration object with knowledge pools and Vectorize binding
 * @returns Object containing the DbAdapter instance
 *
 * @example
 * ```typescript
 * import { createCloudflareVectorizeIntegration } from '@payloadcms-vectorize/cf'
 *
 * const { adapter } = createCloudflareVectorizeIntegration({
 *   config: {
 *     default: {
 *       dims: 384,
 *     },
 *   },
 *   binding: env.VECTORIZE,
 * })
 * ```
 */
export const createCloudflareVectorizeIntegration = (
  options: CloudflareVectorizeConfig,
): { adapter: DbAdapter } => {
  if (!options.binding) {
    throw new Error('[@payloadcms-vectorize/cf] Cloudflare Vectorize binding is required')
  }

  const poolConfig = options.config

  const adapter: DbAdapter = {
    getConfigExtension: () => {
      return {
        custom: {
          _cfVectorizeAdapter: true,
          _poolConfigs: poolConfig,
          _vectorizeBinding: options.binding,
        },
      }
    },

    search: async (payload, queryEmbedding, poolName, limit, where) => {
      return search(payload, queryEmbedding, poolName, limit, where)
    },

    storeEmbedding: async (payload, poolName, id, embedding) => {
      return embed(payload, poolName, id, embedding)
    },

    deleteEmbeddings: async (payload, poolName, sourceCollection, docId) => {
      // Delete all embeddings for this document from Cloudflare Vectorize
      // First, query to find all matching IDs
      const vectorizeBinding = options.binding
      const dims = poolConfig[poolName]?.dims || 384
      try {
        const results = await vectorizeBinding.query(new Array(dims).fill(0), {
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

export type { CloudflareVectorizeBinding, KnowledgePoolsConfig }
export type { KnowledgePoolsConfig as KnowledgePoolConfig }
