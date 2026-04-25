import type { DbAdapter } from 'payloadcms-vectorize'
import { getMongoClient } from './client.js'
import storeChunk from './embed.js'
import search from './search.js'
import {
  resolvePoolConfig,
  type MongoVectorIntegrationConfig,
  type ResolvedPoolConfig,
} from './types.js'

export type {
  MongoPoolConfig,
  MongoVectorIntegrationConfig,
  Similarity,
} from './types.js'

export const createMongoVectorIntegration = (
  options: MongoVectorIntegrationConfig,
): { adapter: DbAdapter } => {
  if (!options.uri) {
    throw new Error('[@payloadcms-vectorize/mongodb] `uri` is required')
  }
  if (!options.dbName) {
    throw new Error('[@payloadcms-vectorize/mongodb] `dbName` is required')
  }
  if (!options.pools || Object.keys(options.pools).length === 0) {
    throw new Error('[@payloadcms-vectorize/mongodb] `pools` must contain at least one pool')
  }

  const resolvedPools: Record<string, ResolvedPoolConfig> = {}
  for (const [name, p] of Object.entries(options.pools)) {
    if (typeof p.dimensions !== 'number' || p.dimensions <= 0) {
      throw new Error(
        `[@payloadcms-vectorize/mongodb] pool "${name}" requires a positive numeric \`dimensions\``,
      )
    }
    resolvedPools[name] = resolvePoolConfig(name, p)
  }

  const adapter: DbAdapter = {
    getConfigExtension: () => ({
      custom: {
        _mongoConfig: {
          uri: options.uri,
          dbName: options.dbName,
          pools: resolvedPools,
        },
      },
    }),

    storeChunk,

    deleteChunks: async (payload, poolName, sourceCollection, docId) => {
      const cfg = resolvedPools[poolName]
      if (!cfg) {
        throw new Error(
          `[@payloadcms-vectorize/mongodb] Unknown pool "${poolName}"`,
        )
      }
      const client = await getMongoClient(options.uri)
      await client
        .db(options.dbName)
        .collection(cfg.collectionName)
        .deleteMany({ sourceCollection, docId: String(docId) })
    },

    hasEmbeddingVersion: async (
      payload,
      poolName,
      sourceCollection,
      docId,
      embeddingVersion,
    ) => {
      const cfg = resolvedPools[poolName]
      if (!cfg) {
        throw new Error(
          `[@payloadcms-vectorize/mongodb] Unknown pool "${poolName}"`,
        )
      }
      const client = await getMongoClient(options.uri)
      const count = await client
        .db(options.dbName)
        .collection(cfg.collectionName)
        .countDocuments(
          { sourceCollection, docId: String(docId), embeddingVersion },
          { limit: 1 },
        )
      return count > 0
    },

    search,
  }

  return { adapter }
}
