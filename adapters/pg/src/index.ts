import { KnowledgePoolsConfig } from './types.js'
import type { PostgresAdapterArgs } from '@payloadcms/db-postgres'
import { clearEmbeddingsTables, registerEmbeddingsTable } from './drizzle.js'
import { customType, index } from '@payloadcms/db-postgres/drizzle/pg-core'
import toSnakeCase from 'to-snake-case'
import type { DbAdapter } from 'payloadcms-vectorize'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import embed from './embed.js'
import search from './search.js'

export type { KnowledgePoolsConfig as KnowledgePoolConfig }

export const createPostgresVectorIntegration = (
  config: KnowledgePoolsConfig,
): {
  afterSchemaInitHook: Required<PostgresAdapterArgs>['afterSchemaInit'][number]
  adapter: DbAdapter
} => {
  // Augment the generated schema so push/migrations are aware of our custom columns
  const afterSchemaInitHook: Required<PostgresAdapterArgs>['afterSchemaInit'][number] = async ({
    schema,
    extendTable,
  }) => {
    // Ensure registry reflects the latest schema
    clearEmbeddingsTables()

    // Extend schema for each knowledge pool
    for (const poolName in config) {
      const staticConfig = config[poolName]
      const dims = staticConfig.dims

      const vectorType = customType({
        dataType() {
          return `vector(${dims})`
        },
      })

      // Drizzle converts camelCase collection slugs to snake_case table names
      const tableName = toSnakeCase(poolName)
      const table = schema?.tables?.[tableName]
      if (!table) {
        throw new Error(
          `[@payloadcms-vectorize/pg] Embeddings table "${poolName}" (table: "${tableName}") not found during schema initialization. Ensure the collection has been registered.`,
        )
      }

      if (typeof extendTable === 'function') {
        extendTable({
          table,
          columns: {
            embedding: vectorType('embedding'),
          },
          extraConfig: (cols) => ({
            embeddingIvfflatIndex: index(`${tableName}_embedding_ivfflat`)
              .using('ivfflat', cols.embedding.op('vector_cosine_ops'))
              .with({ lists: staticConfig.ivfflatLists }),
          }),
        })
      }

      registerEmbeddingsTable(poolName, table)
    }

    return schema
  }

  const adapter: DbAdapter = {
    getConfigExtension: () => {
      // Register bin script for migration helper
      const __filename = fileURLToPath(import.meta.url)
      const __dirname = dirname(__filename)
      const binScriptPath = resolve(__dirname, 'bin-vectorize-migrate.js')

      return {
        bins: [
          {
            // Register bin script for migration helper
            key: 'vectorize:migrate',
            scriptPath: binScriptPath,
          },
        ],
        custom: {
          _staticConfigs: config,
        },
      }
    },
    search,
    storeEmbedding: embed,
  }

  return { afterSchemaInitHook, adapter }
}
