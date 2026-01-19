import type { Config, Payload, PayloadRequest } from 'payload'
import { customType } from '@payloadcms/db-postgres/drizzle/pg-core'
import toSnakeCase from 'to-snake-case'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

import { createEmbeddingsCollection } from './collections/embeddings.js'
import type {
  PayloadcmsVectorizeConfig,
  PostgresPayload,
  KnowledgePoolName,
  KnowledgePoolStaticConfig,
  KnowledgePoolDynamicConfig,
  VectorizedPayload,
  VectorSearchQuery,
  BulkEmbedResult,
  RetryFailedBatchResult,
} from './types.js'
import { isPostgresPayload } from './types.js'
import type { PostgresAdapterArgs } from '@payloadcms/db-postgres'
import { createVectorizeTask } from './tasks/vectorize.js'
import { createVectorSearchHandlers } from './endpoints/vectorSearch.js'
import { clearEmbeddingsTables, registerEmbeddingsTable } from './drizzle/tables.js'
import {
  createBulkEmbeddingsRunsCollection,
  BULK_EMBEDDINGS_RUNS_SLUG,
} from './collections/bulkEmbeddingsRuns.js'
import {
  BULK_EMBEDDINGS_INPUT_METADATA_SLUG,
  createBulkEmbeddingInputMetadataCollection,
} from './collections/bulkEmbeddingInputMetadata.js'
import {
  createBulkEmbeddingsBatchesCollection,
  BULK_EMBEDDINGS_BATCHES_SLUG,
} from './collections/bulkEmbeddingsBatches.js'
import {
  createPrepareBulkEmbeddingTask,
  createPollOrCompleteBulkEmbeddingTask,
} from './tasks/bulkEmbedAll.js'
import { createBulkEmbedHandler, startBulkEmbed } from './endpoints/bulkEmbed.js'
import { createRetryFailedBatchHandler, retryBatch } from './endpoints/retryFailedBatch.js'

export type {
  KnowledgePoolStaticConfig,
  PayloadcmsVectorizeConfig,

  // PayloadcmsVectorizeConfig
  KnowledgePoolDynamicConfig,
  KnowledgePoolName,

  // KnowledgePoolDynamicConfig,
  CollectionVectorizeOption,
  EmbeddingConfig,

  // CollectionVectorizeOption
  ToKnowledgePoolFn,

  // EmbeddingConfig
  EmbedQueryFn,
  EmbedDocsFn,
  BulkEmbeddingsFns,

  // BulkEmbeddingsFns
  AddChunkArgs,
  BatchSubmission,
  PollOrCompleteBatchArgs,
  PollBulkEmbeddingsResult,
  BulkEmbeddingOutput,
  OnBulkErrorArgs,

  // AddChunkArgs
  BulkEmbeddingInput,

  // PollBulkEmbeddingsResult
  BulkEmbeddingRunStatus,
  VectorizedPayload,
} from './types.js'

export { getVectorizedPayload } from './types.js'

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

      // Ensure bulk runs collection exists once
      const bulkRunsCollection = createBulkEmbeddingsRunsCollection()
      if (!config.collections.find((c) => c.slug === BULK_EMBEDDINGS_RUNS_SLUG)) {
        config.collections.push(bulkRunsCollection)
      }
      // Ensure bulk input metadata collection exists once
      const bulkInputMetadataCollection = createBulkEmbeddingInputMetadataCollection()
      if (!config.collections.find((c) => c.slug === BULK_EMBEDDINGS_INPUT_METADATA_SLUG)) {
        config.collections.push(bulkInputMetadataCollection)
      }
      // Ensure bulk batches collection exists once
      const bulkBatchesCollection = createBulkEmbeddingsBatchesCollection()
      if (!config.collections.find((c) => c.slug === BULK_EMBEDDINGS_BATCHES_SLUG)) {
        config.collections.push(bulkBatchesCollection)
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
        const collectionSlugs = Object.keys(dynamicConfig.collections)
        for (const collectionSlug of collectionSlugs) {
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
        if (dynamicConfig.embeddingConfig.bulkEmbeddingsFns) {
          bulkIngestEnabled = true
          break
        }
      }
      if (bulkIngestEnabled && !pluginOptions.bulkQueueNames) {
        throw new Error(
          '[payloadcms-vectorize] bulkQueueNames is required when any knowledge pool has bulk embedding configured (embeddingConfig.bulkEmbeddingsFns).',
        )
      }

      // Exit early if disabled, but keep embeddings collections present for migrations
      if (pluginOptions.disabled) {
        return config
      }

      // Register tasks using Payload Jobs
      const incomingJobs = config.jobs || { tasks: [] }
      const tasks = [...(config.jobs?.tasks || [])]

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

            // Only queue real-time vectorization if realTimeIngestionFn is provided
            if (!dynamic.embeddingConfig.realTimeIngestionFn) continue
            // If no realTimeIngestionFn, nothing happens on doc change
            // User must trigger bulk embedding manually

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

              // Also clean up any pending bulk embedding metadata for this document
              // This prevents embedding a document that was deleted during a bulk run
              try {
                await payload.delete({
                  collection: BULK_EMBEDDINGS_INPUT_METADATA_SLUG,
                  where: {
                    and: [
                      { sourceCollection: { equals: collectionSlug } },
                      { docId: { equals: String(id) } },
                    ],
                  },
                })
              } catch (e) {
                payload?.logger?.warn?.(
                  `[payloadcms-vectorize] Failed to delete bulk embedding metadata for ${collectionSlug}:${id}`,
                  e as Error,
                )
              }
            },
          ],
        }
      }

      const vectorSearchHandlers = createVectorSearchHandlers(pluginOptions.knowledgePools)

      // Create vectorized payload object factory that creates methods bound to a payload instance
      const createVectorizedPayloadObject = (payload: Payload): VectorizedPayload<TPoolNames> => {
        return {
          _isBulkEmbedEnabled: (knowledgePool: TPoolNames): boolean => {
            const poolConfig = pluginOptions.knowledgePools[knowledgePool]
            return !!poolConfig?.embeddingConfig?.bulkEmbeddingsFns
          },
          _staticConfigs: staticConfigs,
          search: (params: VectorSearchQuery<TPoolNames>) =>
            vectorSearchHandlers.vectorSearch(
              payload,
              params.query,
              params.knowledgePool,
              params.limit,
              params.where,
            ),
          queueEmbed: async (
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
          },
          bulkEmbed: (params: { knowledgePool: TPoolNames }): Promise<BulkEmbedResult> =>
            startBulkEmbed({
              payload,
              knowledgePool: params.knowledgePool,
              knowledgePools: pluginOptions.knowledgePools,
              queueName: pluginOptions.bulkQueueNames?.prepareBulkEmbedQueueName,
            }),
          retryFailedBatch: (params: { batchId: string }): Promise<RetryFailedBatchResult> =>
            retryBatch({
              payload,
              batchId: params.batchId,
              knowledgePools: pluginOptions.knowledgePools,
              queueName: pluginOptions.bulkQueueNames?.pollOrCompleteQueueName,
            }),
        } as VectorizedPayload<TPoolNames>
      }

      // Store factory in config.custom
      config.custom = {
        ...(config.custom || {}),
        createVectorizedPayloadObject,
      }

      // Register bin script for migration helper
      const __filename = fileURLToPath(import.meta.url)
      const __dirname = dirname(__filename)
      const binScriptPath = resolve(__dirname, 'bin/vectorize-migrate.js')
      config.bin = [
        ...(config.bin || []),
        {
          key: 'vectorize:migrate',
          scriptPath: binScriptPath,
        },
      ]

      if (pluginOptions.endpointOverrides?.enabled !== false) {
        const path = pluginOptions.endpointOverrides?.path || '/vector-search'
        const inputEndpoints = config.endpoints || []
        const endpoints = [
          ...inputEndpoints,
          {
            path,
            method: 'post' as const,
            handler: vectorSearchHandlers.requestHandler,
          },
          {
            path: '/vector-bulk-embed',
            method: 'post' as const,
            handler: createBulkEmbedHandler(
              pluginOptions.knowledgePools,
              pluginOptions.bulkQueueNames?.prepareBulkEmbedQueueName,
            ),
          },
          {
            path: '/vector-retry-failed-batch',
            method: 'post' as const,
            handler: createRetryFailedBatchHandler(
              pluginOptions.knowledgePools,
              pluginOptions.bulkQueueNames?.pollOrCompleteQueueName,
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
