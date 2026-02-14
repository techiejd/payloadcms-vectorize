import type { CollectionSlug } from 'payload'
import type { DbAdapter } from 'payloadcms-vectorize'
import type { CloudflareVectorizeBinding, KnowledgePoolsConfig } from './types.js'
import cfMappingsCollection, { CF_MAPPINGS_SLUG } from './collections/cfMappings.js'
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
        collections: {
          [CF_MAPPINGS_SLUG]: cfMappingsCollection,
        },
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

    storeEmbedding: async (payload, poolName, sourceCollection, sourceDocId, id, embedding) => {
      return embed(payload, poolName, sourceCollection, sourceDocId, id, embedding)
    },

    deleteEmbeddings: async (payload, poolName, sourceCollection, docId) => {
      const vectorizeBinding = options.binding

      try {
        // Paginate through all mapping rows for this document+pool
        const allVectorIds: string[] = []
        let page = 1
        let hasNextPage = true

        while (hasNextPage) {
          const mappings = await payload.find({
            collection: CF_MAPPINGS_SLUG as CollectionSlug,
            where: {
              and: [
                { poolName: { equals: poolName } },
                { sourceCollection: { equals: sourceCollection } },
                { docId: { equals: docId } },
              ],
            },
            page,
          })

          for (const mapping of mappings.docs) {
            allVectorIds.push((mapping as Record<string, unknown>).vectorId as string)
          }

          hasNextPage = mappings.hasNextPage
          page++
        }

        if (allVectorIds.length === 0) {
          return
        }
        // Delete vectors from Cloudflare Vectorize
        await vectorizeBinding.deleteByIds(allVectorIds)
        // Delete mapping rows
        await payload.delete({
          collection: CF_MAPPINGS_SLUG as CollectionSlug,
          where: {
            and: [
              { poolName: { equals: poolName } },
              { sourceCollection: { equals: sourceCollection } },
              { docId: { equals: docId } },
            ],
          },
        })
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        payload.logger.error(
          `[@payloadcms-vectorize/cf] Failed to delete embeddings: ${errorMessage}`,
        )
        throw new Error(`[@payloadcms-vectorize/cf] Failed to delete embeddings: ${errorMessage}`)
      }
    },
  }

  return { adapter }
}

export { CF_MAPPINGS_SLUG } from './collections/cfMappings.js'
export type { CloudflareVectorizeBinding, KnowledgePoolsConfig }
export type { KnowledgePoolsConfig as KnowledgePoolConfig }
