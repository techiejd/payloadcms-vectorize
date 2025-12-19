import type { Config, Payload } from 'payload'
import { customType } from '@payloadcms/db-postgres/drizzle/pg-core'

import { createEmbeddingsCollection } from './collections/embeddings.js'
import type {
  PayloadcmsVectorizeConfig,
  PostgresPayload,
  KnowledgePoolName,
  KnowledgePoolStaticConfig,
  KnowledgePoolDynamicConfig,
} from './types.js'
import { isPostgresPayload } from './types.js'
import type { PostgresAdapterArgs } from '@payloadcms/db-postgres'
import { createVectorizeTask } from './tasks/vectorize.js'
import { createVectorSearchHandler } from './endpoints/vectorSearch.js'
import { clearEmbeddingsTables, registerEmbeddingsTable } from './drizzle/tables.js'
import {
  createBulkEmbeddingsRunsCollection,
  BULK_EMBEDDINGS_RUNS_SLUG,
} from './collections/bulkEmbeddingsRuns.js'
import {
  createPrepareBulkEmbeddingTask,
  createPollOrCompleteBulkEmbeddingTask,
} from './tasks/bulkEmbedAll.js'
import { createBulkEmbedHandler } from './endpoints/bulkEmbed.js'

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

      const table = schema?.tables?.[poolName]
      if (!table) {
        throw new Error(
          `[payloadcms-vectorize] Embeddings table "${poolName}" not found during schema initialization. Ensure the collection has been registered.`,
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

      // Ensure bulk runs collection exists once
      const bulkRunsCollection = createBulkEmbeddingsRunsCollection()
      if (!config.collections.find((c) => c.slug === BULK_EMBEDDINGS_RUNS_SLUG)) {
        config.collections.push(bulkRunsCollection)
      }

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

      // Validate bulk queue requirements
      let bulkIngestEnabled = false
      for (const poolName in pluginOptions.knowledgePools) {
        const dynamicConfig = pluginOptions.knowledgePools[poolName]
        if ((dynamicConfig.bulkEmbeddings?.ingestMode || 'realtime') === 'bulk') {
          bulkIngestEnabled = true
          break
        }
      }
      if (bulkIngestEnabled && !pluginOptions.bulkQueueNames) {
        throw new Error(
          '[payloadcms-vectorize] bulkQueueNames is required when any knowledge pool uses bulk ingest mode (bulkEmbeddings.ingestMode === \"bulk\").',
        )
      }

      // Exit early if disabled, but keep embeddings collections present for migrations
      if (pluginOptions.disabled) return config

      // Register a single task using Payload Jobs that can handle any knowledge pool
      const incomingJobs = config.jobs || { tasks: [] }
      const tasks = [...incomingJobs.tasks]

      const vectorizeTask = createVectorizeTask({
        knowledgePools: pluginOptions.knowledgePools,
      })
      tasks.push(vectorizeTask)
      const prepareBulkEmbedTask = createPrepareBulkEmbeddingTask({
        knowledgePools: pluginOptions.knowledgePools,
        pollOrCompleteQueueName: pluginOptions.bulkQueueNames?.pollOrCompleteQueueName,
      })
      tasks.push(prepareBulkEmbedTask)
      const pollOrCompleteBulkEmbedTask = createPollOrCompleteBulkEmbeddingTask({
        knowledgePools: pluginOptions.knowledgePools,
        pollOrCompleteQueueName: pluginOptions.bulkQueueNames?.pollOrCompleteQueueName,
      })
      tasks.push(pollOrCompleteBulkEmbedTask)

      config.jobs = {
        ...incomingJobs,
        tasks,
      }

      // Extend configured collections with hooks
      for (const [collectionSlug, pools] of collectionToPools.entries()) {
        const collection = config.collections.find((c) => c.slug === collectionSlug)
        if (!collection) {
          throw new Error(`[payloadcms-vectorize] Collection ${collectionSlug} not found`)
        }

        collection.hooks = {
          ...(collection.hooks || {}),
          afterChange: [
            ...((collection.hooks?.afterChange as any[]) || []),
            async (args) => {
              const { doc, req } = args
              const payload = req.payload

              // Queue vectorization jobs for ALL knowledge pools containing this collection
              for (const { pool, dynamic } of pools) {
                const collectionConfig = dynamic.collections[collectionSlug]
                if (!collectionConfig) continue

                if ((dynamic.bulkEmbeddings?.ingestMode || 'realtime') === 'bulk') {
                  // In bulk mode, queue a bulk run and let poll/completion handle deletes
                  const run = await payload.create({
                    collection: BULK_EMBEDDINGS_RUNS_SLUG,
                    data: {
                      pool,
                      embeddingVersion: dynamic.embeddingVersion,
                      status: 'queued',
                    },
                  })

                  await payload.jobs.queue<'payloadcms-vectorize:prepare-bulk-embedding'>({
                    task: 'payloadcms-vectorize:prepare-bulk-embedding',
                    input: { runId: String(run.id) },
                    req,
                    ...(pluginOptions.bulkQueueNames?.prepareBulkEmbedQueueName
                      ? { queue: pluginOptions.bulkQueueNames.prepareBulkEmbedQueueName }
                      : {}),
                  })
                  continue
                }

                await payload.jobs.queue<'payloadcms-vectorize:vectorize'>({
                  task: 'payloadcms-vectorize:vectorize',
                  input: {
                    doc,
                    collection: collectionSlug,
                    knowledgePool: pool,
                  },
                  req: req,
                  ...(pluginOptions.realtimeQueueName
                    ? { queue: pluginOptions.realtimeQueueName }
                    : {}),
                })
              }
              return
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
      config.onInit = async (payload) => {
        if (incomingOnInit) await incomingOnInit(payload)

        // Ensure pgvector artifacts for each knowledge pool
        for (const poolName in staticConfigs) {
          const staticConfig = staticConfigs[poolName]
          await ensurePgvectorArtifacts({
            payload,
            tableName: poolName,
            dims: staticConfig.dims,
            ivfflatLists: staticConfig.ivfflatLists,
          })

          // If bulk ingest is configured for this pool, ensure a baseline run exists and is queued
          const dynamicConfig = pluginOptions.knowledgePools?.[poolName]
          if (
            dynamicConfig?.bulkEmbeddings &&
            dynamicConfig.bulkEmbeddings.ingestMode !== 'realtime'
          ) {
            const existingSucceeded = await payload.find({
              collection: BULK_EMBEDDINGS_RUNS_SLUG,
              where: {
                and: [{ pool: { equals: poolName } }, { status: { equals: 'succeeded' } }],
              },
              limit: 1,
              sort: '-completedAt',
            })
            if (!existingSucceeded.totalDocs) {
              const run = await payload.create({
                collection: BULK_EMBEDDINGS_RUNS_SLUG,
                data: {
                  pool: poolName,
                  embeddingVersion: dynamicConfig.embeddingVersion,
                  status: 'queued',
                },
              })
              await payload.jobs.queue<'payloadcms-vectorize:prepare-bulk-embedding'>({
                task: 'payloadcms-vectorize:prepare-bulk-embedding',
                input: { runId: String(run.id) },
                req: { payload } as any,
                ...(pluginOptions.bulkQueueNames?.prepareBulkEmbedQueueName
                  ? { queue: pluginOptions.bulkQueueNames.prepareBulkEmbedQueueName }
                  : {}),
              })
            }
          }
        }
      }

      if (pluginOptions.endpointOverrides?.enabled !== false) {
        const path = pluginOptions.endpointOverrides?.path || '/vector-search'
        const inputEndpoints = config.endpoints || []
        const endpoints = [
          ...inputEndpoints,
          {
            path,
            method: 'post' as const,
            handler: createVectorSearchHandler(pluginOptions.knowledgePools),
          },
          {
            path: '/vector-bulk-embed',
            method: 'post' as const,
            handler: createBulkEmbedHandler(
              pluginOptions.knowledgePools,
              pluginOptions.bulkQueueNames?.prepareBulkEmbedQueueName,
            ),
          },
        ]
        config.endpoints = endpoints
      }

      return config
    }
  return {
    afterSchemaInitHook,
    payloadcmsVectorize,
  }
}
