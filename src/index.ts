import type { Config, Payload, PayloadRequest } from 'payload'
import { customType } from '@payloadcms/db-postgres/drizzle/pg-core'

import { createEmbeddingsCollection } from './collections/embeddings.js'
import type {
  PayloadcmsVectorizeConfig,
  PostgresPayload,
  KnowledgePoolName,
  KnowledgePoolStaticConfig,
  KnowledgePoolDynamicConfig,
  VectorizedPayload,
  VectorSearchQuery,
} from './types.js'
import { isPostgresPayload } from './types.js'
import type { PostgresAdapterArgs } from '@payloadcms/db-postgres'
import { createVectorizeTask } from './tasks/vectorize.js'
import { createVectorSearchHandlers } from './endpoints/vectorSearch.js'
import { clearEmbeddingsTables, registerEmbeddingsTable } from './drizzle/tables.js'
import toSnakeCase from 'to-snake-case'

export type * from './types.js'

async function ensurePgvectorArtifacts(args: {
  payload: Payload
  tableName: string
  dims: number
  ivfflatLists: number
}): Promise<void> {
  const { payload, tableName, dims, ivfflatLists } = args

  if (!isPostgresPayload(payload)) {
    throw new Error(
      '[payloadcms-vectorize] This plugin requires the Postgres adapter. Please configure @payloadcms/db-postgres.',
    )
  }

  // Now payload is typed as PostgresPayload
  const postgresPayload = payload as PostgresPayload
  const schemaName = postgresPayload.db.schemaName || 'public'

  const sqls: string[] = [
    `CREATE EXTENSION IF NOT EXISTS vector;`,
    `ALTER TABLE "${schemaName}"."${tableName}" ADD COLUMN IF NOT EXISTS embedding vector(${dims});`,
    `CREATE INDEX IF NOT EXISTS ${tableName}_embedding_ivfflat ON "${schemaName}"."${tableName}" USING ivfflat (embedding vector_cosine_ops) WITH (lists = ${ivfflatLists});`,
  ]

  try {
    if (postgresPayload.db.pool?.query) {
      for (const sql of sqls) {
        await postgresPayload.db.pool.query(sql)
      }
    } else if (postgresPayload.db.drizzle?.execute) {
      for (const sql of sqls) {
        await postgresPayload.db.drizzle.execute(sql)
      }
    }
    postgresPayload.logger.info('[payloadcms-vectorize] pgvector extension/columns/index ensured')
  } catch (err) {
    postgresPayload.logger.error(
      '[payloadcms-vectorize] Failed ensuring pgvector artifacts',
      err as Error,
    )
    throw new Error(`[payloadcms-vectorize] Failed ensuring pgvector artifacts: ${err}`)
  }
}

// ==================
// Plugin entry point
// ==================

export const createVectorizeIntegration = <TPoolNames extends KnowledgePoolName>(
  staticConfigs: Record<TPoolNames, KnowledgePoolStaticConfig>,
): {
  afterSchemaInitHook: Required<PostgresAdapterArgs>['afterSchemaInit'][number]
  payloadcmsVectorize: (
    pluginOptions: PayloadcmsVectorizeConfig<TPoolNames>,
  ) => (config: Config) => Config
} => {
  // Augment the generated schema so push/migrations are aware of our custom columns
  const afterSchemaInitHook: Required<PostgresAdapterArgs>['afterSchemaInit'][number] = async ({
    schema,
    extendTable,
  }) => {
    // Ensure registry reflects the latest schema
    clearEmbeddingsTables()

    // Extend schema for each knowledge pool
    for (const poolName in staticConfigs) {
      const staticConfig = staticConfigs[poolName]
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
          `[payloadcms-vectorize] Embeddings table "${poolName}" (table: "${tableName}") not found during schema initialization. Ensure the collection has been registered.`,
        )
      }

      if (typeof extendTable === 'function') {
        extendTable({
          table,
          columns: {
            embedding: vectorType('embedding'),
          },
        })
      }

      registerEmbeddingsTable(poolName as KnowledgePoolName, table)
    }

    return schema
  }
  const payloadcmsVectorize =
    (pluginOptions: PayloadcmsVectorizeConfig<TPoolNames>) =>
    (config: Config): Config => {
      // Ensure collections array exists
      config.collections = [...(config.collections || [])]

      // Validate static/dynamic configs share the same pool names
      for (const poolName in pluginOptions.knowledgePools) {
        if (!staticConfigs[poolName]) {
          throw new Error(
            `[payloadcms-vectorize] Knowledge pool "${poolName}" not found in static configs`,
          )
        }
      }

      const unusedStaticPools: TPoolNames[] = []
      for (const poolName in staticConfigs) {
        if (!pluginOptions.knowledgePools[poolName]) {
          unusedStaticPools.push(poolName)
        }
      }
      if (unusedStaticPools.length > 0) {
        throw new Error(
          `[payloadcms-vectorize] Static knowledge pool(s) ${unusedStaticPools.join(', ')} lack dynamic configuration`,
        )
      }

      // Build reverse mapping: collectionSlug -> KnowledgePoolName[]
      const collectionToPools = new Map<
        string,
        Array<{
          pool: KnowledgePoolName
          dynamic: KnowledgePoolDynamicConfig
        }>
      >()

      // Process each knowledge pool
      for (const poolName in pluginOptions.knowledgePools) {
        const dynamicConfig = pluginOptions.knowledgePools[poolName]

        // Add the embeddings collection for this knowledge pool with extensionFields
        const embeddingsCollection = createEmbeddingsCollection(
          poolName,
          dynamicConfig.extensionFields,
        )
        if (!config.collections.find((c) => c.slug === poolName)) {
          config.collections.push(embeddingsCollection)
        }

        // Build reverse mapping for hooks
        for (const collectionSlug of Object.keys(dynamicConfig.collections)) {
          if (!collectionToPools.has(collectionSlug)) {
            collectionToPools.set(collectionSlug, [])
          }
          collectionToPools.get(collectionSlug)!.push({ pool: poolName, dynamic: dynamicConfig })
        }
      }

      // Exit early if disabled, but keep embeddings collections present for migrations
      if (pluginOptions.disabled) return config

      // Register a single task using Payload Jobs that can handle any knowledge pool
      const incomingJobs = config.jobs || { tasks: [] }
      const tasks = [...(config.jobs?.tasks || [])]

      const vectorizeTask = createVectorizeTask({
        knowledgePools: pluginOptions.knowledgePools,
      })
      tasks.push(vectorizeTask)

      config.jobs = {
        ...incomingJobs,
        tasks,
      }

      const collectionToEmbedQueue = new Map<
        string,
        (doc: any, payload: Payload, req?: PayloadRequest) => Promise<void>
      >()

      // Extend configured collections with hooks
      for (const [collectionSlug, pools] of collectionToPools.entries()) {
        const collection = config.collections.find((c) => c.slug === collectionSlug)
        if (!collection) {
          throw new Error(`[payloadcms-vectorize] Collection ${collectionSlug} not found`)
        }

        const embedQueue = async (doc: any, payload: Payload, req?: PayloadRequest) => {
          // Queue vectorization jobs for ALL knowledge pools containing this collection
          for (const { pool, dynamic } of pools) {
            const collectionConfig = dynamic.collections[collectionSlug]
            if (!collectionConfig) continue

            await payload.jobs.queue<'payloadcms-vectorize:vectorize'>({
              task: 'payloadcms-vectorize:vectorize',
              input: {
                doc,
                collection: collectionSlug,
                knowledgePool: pool,
              },
              req: req,
              ...(pluginOptions.queueName ? { queue: pluginOptions.queueName } : {}),
            })
          }
        }

        collectionToEmbedQueue.set(collectionSlug, embedQueue)

        collection.hooks = {
          ...(collection.hooks || {}),
          afterChange: [
            ...((collection.hooks?.afterChange as any[]) || []),
            async (args) => {
              const { doc, req } = args
              const payload = req.payload

              return embedQueue(doc, payload, req)
            },
          ],
          afterDelete: [
            ...((collection.hooks?.afterDelete as any[]) || []),
            async ({ id, payload: pld, req }: any) => {
              const payload = (pld as any) || (req as any)?.payload

              // Delete from ALL knowledge pools containing this collection
              for (const { pool } of pools) {
                try {
                  await payload.delete({
                    collection: pool,
                    where: {
                      and: [
                        { sourceCollection: { equals: collectionSlug } },
                        { docId: { equals: String(id) } },
                      ],
                    },
                  })
                } catch (e) {
                  payload?.logger?.warn?.(
                    `[payloadcms-vectorize] Failed to delete from knowledge pool ${pool}`,
                    e as Error,
                  )
                }
              }
            },
          ],
        }
      }

      const incomingOnInit = config.onInit
      const vectorSearchHandlers = createVectorSearchHandlers(pluginOptions.knowledgePools)
      config.onInit = async (payload) => {
        if (incomingOnInit) await incomingOnInit(payload)
        ;(payload as VectorizedPayload<TPoolNames>).search = (
          params: VectorSearchQuery<TPoolNames>,
        ) =>
          vectorSearchHandlers.vectorSearch(
            payload,
            params.query,
            params.knowledgePool,
            params.limit,
            params.where,
          )
        ;(payload as VectorizedPayload<TPoolNames>).queueEmbed = async (
          params:
            | {
                collection: string
                docId: string
              }
            | {
                collection: string
                doc: Record<string, any>
              },
        ) => {
          const collection = params.collection
          let doc: Record<string, any>
          if ('docId' in params && params.docId) {
            doc = await payload.findByID({
              collection: collection as any,
              id: params.docId,
            })
          } else if ('doc' in params && params.doc) {
            doc = params.doc
          } else {
            throw new Error(
              `[payloadcms-vectorize] queueEmbed requires either docId or doc parameter`,
            )
          }
          const embedQueue = collectionToEmbedQueue.get(collection)
          if (!embedQueue) {
            throw new Error(
              `[payloadcms-vectorize] Collection "${collection}" is not configured for vectorization`,
            )
          }
          return embedQueue(doc, payload)
        }
        // Ensure pgvector artifacts for each knowledge pool
        for (const poolName in staticConfigs) {
          const staticConfig = staticConfigs[poolName]
          await ensurePgvectorArtifacts({
            payload,
            // Drizzle converts camelCase collection slugs to snake_case table names
            tableName: toSnakeCase(poolName),
            dims: staticConfig.dims,
            ivfflatLists: staticConfig.ivfflatLists,
          })
        }
      }

      if (pluginOptions.endpointOverrides?.enabled !== false) {
        const path = pluginOptions.endpointOverrides?.path || '/vector-search'
        const inputEndpoints = config.endpoints || []
        config.endpoints = [
          ...inputEndpoints,
          {
            path,
            method: 'post',
            handler: vectorSearchHandlers.requestHandler,
          },
        ]
      }

      return config
    }
  return {
    afterSchemaInitHook,
    payloadcmsVectorize,
  }
}
