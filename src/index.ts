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
      console.log('[payloadcms-vectorize] payloadcmsVectorize: Plugin initialization started')
      console.log(
        `[payloadcms-vectorize] payloadcmsVectorize: Processing ${Object.keys(pluginOptions.knowledgePools).length} knowledge pool(s)`,
      )

      // Ensure collections array exists
      config.collections = [...(config.collections || [])]
      console.log(
        `[payloadcms-vectorize] payloadcmsVectorize: Initial collections count: ${config.collections.length}`,
      )

      // Ensure bulk runs collection exists once
      console.log('[payloadcms-vectorize] payloadcmsVectorize: Adding bulk runs collection...')
      const bulkRunsCollection = createBulkEmbeddingsRunsCollection()
      if (!config.collections.find((c) => c.slug === BULK_EMBEDDINGS_RUNS_SLUG)) {
        config.collections.push(bulkRunsCollection)
        console.log('[payloadcms-vectorize] payloadcmsVectorize: Bulk runs collection added')
      } else {
        console.log(
          '[payloadcms-vectorize] payloadcmsVectorize: Bulk runs collection already exists',
        )
      }
      // Ensure bulk input metadata collection exists once
      console.log(
        '[payloadcms-vectorize] payloadcmsVectorize: Adding bulk input metadata collection...',
      )
      const bulkInputMetadataCollection = createBulkEmbeddingInputMetadataCollection()
      if (!config.collections.find((c) => c.slug === BULK_EMBEDDINGS_INPUT_METADATA_SLUG)) {
        config.collections.push(bulkInputMetadataCollection)
        console.log(
          '[payloadcms-vectorize] payloadcmsVectorize: Bulk input metadata collection added',
        )
      } else {
        console.log(
          '[payloadcms-vectorize] payloadcmsVectorize: Bulk input metadata collection already exists',
        )
      }
      // Ensure bulk batches collection exists once
      console.log('[payloadcms-vectorize] payloadcmsVectorize: Adding bulk batches collection...')
      const bulkBatchesCollection = createBulkEmbeddingsBatchesCollection()
      if (!config.collections.find((c) => c.slug === BULK_EMBEDDINGS_BATCHES_SLUG)) {
        config.collections.push(bulkBatchesCollection)
        console.log('[payloadcms-vectorize] payloadcmsVectorize: Bulk batches collection added')
      } else {
        console.log(
          '[payloadcms-vectorize] payloadcmsVectorize: Bulk batches collection already exists',
        )
      }

      // Validate static/dynamic configs share the same pool names
      console.log(
        '[payloadcms-vectorize] payloadcmsVectorize: Validating static/dynamic config alignment...',
      )
      for (const poolName in pluginOptions.knowledgePools) {
        if (!staticConfigs[poolName]) {
          console.error(
            `[payloadcms-vectorize] payloadcmsVectorize: Knowledge pool "${poolName}" not found in static configs`,
          )
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
        console.error(
          `[payloadcms-vectorize] payloadcmsVectorize: Static pools without dynamic config: ${unusedStaticPools.join(', ')}`,
        )
        throw new Error(
          `[payloadcms-vectorize] Static knowledge pool(s) ${unusedStaticPools.join(', ')} lack dynamic configuration`,
        )
      }
      console.log(
        '[payloadcms-vectorize] payloadcmsVectorize: Static/dynamic config validation passed',
      )

      // Build reverse mapping: collectionSlug -> KnowledgePoolName[]
      const collectionToPools = new Map<
        string,
        Array<{
          pool: KnowledgePoolName
          dynamic: KnowledgePoolDynamicConfig
        }>
      >()

      // Process each knowledge pool
      console.log('[payloadcms-vectorize] payloadcmsVectorize: Processing knowledge pools...')
      for (const poolName in pluginOptions.knowledgePools) {
        console.log(`[payloadcms-vectorize] payloadcmsVectorize: Processing pool "${poolName}"...`)
        const dynamicConfig = pluginOptions.knowledgePools[poolName]

        // Add the embeddings collection for this knowledge pool with extensionFields
        console.log(
          `[payloadcms-vectorize] payloadcmsVectorize: Creating embeddings collection for pool "${poolName}"...`,
        )
        const embeddingsCollection = createEmbeddingsCollection(
          poolName,
          dynamicConfig.extensionFields,
        )
        if (!config.collections.find((c) => c.slug === poolName)) {
          config.collections.push(embeddingsCollection)
          console.log(
            `[payloadcms-vectorize] payloadcmsVectorize: Embeddings collection "${poolName}" added`,
          )
        } else {
          console.log(
            `[payloadcms-vectorize] payloadcmsVectorize: Embeddings collection "${poolName}" already exists`,
          )
        }

        // Build reverse mapping for hooks
        const collectionSlugs = Object.keys(dynamicConfig.collections)
        console.log(
          `[payloadcms-vectorize] payloadcmsVectorize: Pool "${poolName}" maps to ${collectionSlugs.length} collection(s): ${collectionSlugs.join(', ')}`,
        )
        for (const collectionSlug of collectionSlugs) {
          if (!collectionToPools.has(collectionSlug)) {
            collectionToPools.set(collectionSlug, [])
          }
          collectionToPools.get(collectionSlug)!.push({ pool: poolName, dynamic: dynamicConfig })
        }
        console.log(
          `[payloadcms-vectorize] payloadcmsVectorize: Pool "${poolName}" processing complete`,
        )
      }
      console.log(
        `[payloadcms-vectorize] payloadcmsVectorize: Knowledge pools processed. Total collections: ${config.collections.length}`,
      )

      // Validate bulk queue requirements
      console.log(
        '[payloadcms-vectorize] payloadcmsVectorize: Validating bulk queue requirements...',
      )
      let bulkIngestEnabled = false
      for (const poolName in pluginOptions.knowledgePools) {
        const dynamicConfig = pluginOptions.knowledgePools[poolName]
        if (dynamicConfig.embeddingConfig.bulkEmbeddingsFns) {
          bulkIngestEnabled = true
          console.log(
            `[payloadcms-vectorize] payloadcmsVectorize: Pool "${poolName}" has bulk embedding enabled`,
          )
          break
        }
      }
      if (bulkIngestEnabled && !pluginOptions.bulkQueueNames) {
        console.error(
          '[payloadcms-vectorize] payloadcmsVectorize: bulkQueueNames required but not provided',
        )
        throw new Error(
          '[payloadcms-vectorize] bulkQueueNames is required when any knowledge pool has bulk embedding configured (embeddingConfig.bulkEmbeddingsFns).',
        )
      }
      console.log(
        `[payloadcms-vectorize] payloadcmsVectorize: Bulk queue validation passed (enabled: ${bulkIngestEnabled})`,
      )

      // Exit early if disabled, but keep embeddings collections present for migrations
      if (pluginOptions.disabled) {
        console.log('[payloadcms-vectorize] payloadcmsVectorize: Plugin disabled, exiting early')
        return config
      }

      // Register a single task using Payload Jobs that can handle any knowledge pool
      console.log('[payloadcms-vectorize] payloadcmsVectorize: Registering Payload Jobs tasks...')
      const incomingJobs = config.jobs || { tasks: [] }
      const tasks = [...(config.jobs?.tasks || [])]
      console.log(
        `[payloadcms-vectorize] payloadcmsVectorize: Existing tasks count: ${tasks.length}`,
      )

      console.log('[payloadcms-vectorize] payloadcmsVectorize: Creating vectorize task...')
      const vectorizeTask = createVectorizeTask({
        knowledgePools: pluginOptions.knowledgePools,
      })
      tasks.push(vectorizeTask)
      console.log('[payloadcms-vectorize] payloadcmsVectorize: Vectorize task added')

      console.log('[payloadcms-vectorize] payloadcmsVectorize: Creating prepare bulk embed task...')
      const prepareBulkEmbedTask = createPrepareBulkEmbeddingTask({
        knowledgePools: pluginOptions.knowledgePools,
        pollOrCompleteQueueName: pluginOptions.bulkQueueNames?.pollOrCompleteQueueName,
      })
      tasks.push(prepareBulkEmbedTask)
      console.log('[payloadcms-vectorize] payloadcmsVectorize: Prepare bulk embed task added')

      console.log(
        '[payloadcms-vectorize] payloadcmsVectorize: Creating poll or complete bulk embed task...',
      )
      const pollOrCompleteBulkEmbedTask = createPollOrCompleteBulkEmbeddingTask({
        knowledgePools: pluginOptions.knowledgePools,
        pollOrCompleteQueueName: pluginOptions.bulkQueueNames?.pollOrCompleteQueueName,
      })
      tasks.push(pollOrCompleteBulkEmbedTask)
      console.log(
        '[payloadcms-vectorize] payloadcmsVectorize: Poll or complete bulk embed task added',
      )

      config.jobs = {
        ...incomingJobs,
        tasks,
      }
      console.log(
        `[payloadcms-vectorize] payloadcmsVectorize: Jobs configured. Total tasks: ${tasks.length}`,
      )

      const collectionToEmbedQueue = new Map<
        string,
        (doc: any, payload: Payload, req?: PayloadRequest) => Promise<void>
      >()

      // Extend configured collections with hooks
      console.log(
        `[payloadcms-vectorize] payloadcmsVectorize: Setting up hooks for ${collectionToPools.size} collection(s)...`,
      )
      for (const [collectionSlug, pools] of collectionToPools.entries()) {
        console.log(
          `[payloadcms-vectorize] payloadcmsVectorize: Setting up hooks for collection "${collectionSlug}" (${pools.length} pool(s))...`,
        )
        const collection = config.collections.find((c) => c.slug === collectionSlug)
        if (!collection) {
          console.error(
            `[payloadcms-vectorize] payloadcmsVectorize: Collection "${collectionSlug}" not found`,
          )
          throw new Error(`[payloadcms-vectorize] Collection ${collectionSlug} not found`)
        }
        console.log(
          `[payloadcms-vectorize] payloadcmsVectorize: Collection "${collectionSlug}" found, adding hooks...`,
        )

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
        console.log(
          `[payloadcms-vectorize] payloadcmsVectorize: Embed queue function registered for "${collectionSlug}"`,
        )

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
        console.log(
          `[payloadcms-vectorize] payloadcmsVectorize: Hooks configured for collection "${collectionSlug}"`,
        )
      }
      console.log('[payloadcms-vectorize] payloadcmsVectorize: All collection hooks configured')

      console.log('[payloadcms-vectorize] payloadcmsVectorize: Creating vector search handlers...')
      const vectorSearchHandlers = createVectorSearchHandlers(pluginOptions.knowledgePools)
      console.log('[payloadcms-vectorize] payloadcmsVectorize: Vector search handlers created')

      // Create vectorized payload object factory that creates methods bound to a payload instance
      console.log(
        '[payloadcms-vectorize] payloadcmsVectorize: Creating vectorized payload object factory...',
      )
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
      console.log(
        '[payloadcms-vectorize] payloadcmsVectorize: Storing vectorized payload factory in config.custom...',
      )
      config.custom = {
        ...(config.custom || {}),
        createVectorizedPayloadObject,
      }
      console.log('[payloadcms-vectorize] payloadcmsVectorize: Factory stored in config.custom')

      // Register bin script for migration helper
      console.log('[payloadcms-vectorize] payloadcmsVectorize: Registering bin script...')
      const __filename = fileURLToPath(import.meta.url)
      const __dirname = dirname(__filename)
      const binScriptPath = resolve(__dirname, 'bin/vectorize-migrate.js')
      console.log(`[payloadcms-vectorize] payloadcmsVectorize: Bin script path: ${binScriptPath}`)
      config.bin = [
        ...(config.bin || []),
        {
          key: 'vectorize:migrate',
          scriptPath: binScriptPath,
        },
      ]
      console.log('[payloadcms-vectorize] payloadcmsVectorize: Bin script registered')

      if (pluginOptions.endpointOverrides?.enabled !== false) {
        console.log(
          '[payloadcms-vectorize] payloadcmsVectorize: Setting up vector search endpoint...',
        )
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
        console.log(
          `[payloadcms-vectorize] payloadcmsVectorize: Vector search endpoint registered at "${path}"`,
        )
      } else {
        console.log('[payloadcms-vectorize] payloadcmsVectorize: Vector search endpoint disabled')
      }

      console.log('[payloadcms-vectorize] payloadcmsVectorize: Plugin initialization complete')
      console.log(
        `[payloadcms-vectorize] payloadcmsVectorize: Final collections count: ${config.collections.length}`,
      )
      return config
    }
  return {
    afterSchemaInitHook,
    payloadcmsVectorize,
  }
}
