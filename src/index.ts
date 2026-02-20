import type { CollectionSlug, Config, Payload, PayloadRequest } from 'payload'

import { createEmbeddingsCollection } from './collections/embeddings.js'
import type {
  PayloadcmsVectorizeConfig,
  KnowledgePoolName,
  KnowledgePoolDynamicConfig,
  VectorizedPayload,
  VectorSearchQuery,
  BulkEmbedResult,
  RetryFailedBatchResult,
  DbAdapter,
} from './types.js'
import { createVectorizeTask } from './tasks/vectorize.js'
import { TASK_SLUG_VECTORIZE } from './constants.js'
import { deleteDocumentEmbeddings } from './utils/deleteDocumentEmbeddings.js'
import { createVectorSearchHandlers } from './endpoints/vectorSearch.js'
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
  PayloadcmsVectorizeConfig,

  // PayloadcmsVectorizeConfig
  KnowledgePoolDynamicConfig,
  KnowledgePoolName,

  // KnowledgePoolDynamicConfig,
  CollectionVectorizeOption,
  EmbeddingConfig,

  // CollectionVectorizeOption
  ShouldEmbedFn,
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
  DbAdapter,

  // For adapters
  VectorSearchResult,
} from './types.js'

export { getVectorizedPayload } from './types.js'

export {
  TASK_SLUG_VECTORIZE,
  TASK_SLUG_PREPARE_BULK_EMBEDDING,
  TASK_SLUG_POLL_OR_COMPLETE_BULK_EMBEDDING,
} from './constants.js'
export { validateChunkData } from './utils/validateChunkData.js'
export { deleteDocumentEmbeddings } from './utils/deleteDocumentEmbeddings.js'

// ==================
// Plugin entry point
// ==================

export default (pluginOptions: PayloadcmsVectorizeConfig) =>
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
      adapter: pluginOptions.dbAdapter,
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
      adapter: pluginOptions.dbAdapter,
    })
    tasks.push(pollOrCompleteBulkEmbedTask)

    config.jobs = {
      ...incomingJobs,
      tasks,
    }

    const collectionToEmbedQueue = new Map<
      string,
      (doc: Record<string, unknown>, payload: Payload, req?: PayloadRequest) => Promise<void>
    >()

    // Extend configured collections with hooks
    for (const [collectionSlug, pools] of collectionToPools.entries()) {
      const collection = config.collections.find((c) => c.slug === collectionSlug)
      if (!collection) {
        throw new Error(`[payloadcms-vectorize] Collection ${collectionSlug} not found`)
      }

      const embedQueue = async (doc: Record<string, unknown>, payload: Payload, req?: PayloadRequest) => {
        // Queue vectorization jobs for ALL knowledge pools containing this collection
        for (const { pool, dynamic } of pools) {
          const collectionConfig = dynamic.collections[collectionSlug]
          if (!collectionConfig) continue

          // Only queue real-time vectorization if realTimeIngestionFn is provided
          if (!dynamic.embeddingConfig.realTimeIngestionFn) continue
          // If no realTimeIngestionFn, nothing happens on doc change
          // User must trigger bulk embedding manually

          // Check if document should be embedded
          if (collectionConfig.shouldEmbedFn) {
            const shouldEmbed = await collectionConfig.shouldEmbedFn(doc, payload)
            if (!shouldEmbed) continue
          }

          await payload.jobs.queue<typeof TASK_SLUG_VECTORIZE>({
            task: TASK_SLUG_VECTORIZE,
            input: {
              doc,
              collection: collectionSlug,
              knowledgePool: pool,
            },
            req: req,
            ...(pluginOptions.realtimeQueueName ? { queue: pluginOptions.realtimeQueueName } : {}),
          })
        }
      }

      collectionToEmbedQueue.set(collectionSlug, embedQueue)

      const adapter = pluginOptions.dbAdapter

      collection.hooks = {
        ...(collection.hooks || {}),
        afterChange: [
          ...(collection.hooks?.afterChange || []),
          async (args) => {
            const { doc, req } = args
            const payload = req.payload
            return embedQueue(doc, payload, req)
          },
        ],
        afterDelete: [
          ...(collection.hooks?.afterDelete || []),
          async ({ id, req }) => {
            const payload = req.payload

            // Delete from ALL knowledge pools containing this collection
            for (const { pool } of pools) {
              try {
                await deleteDocumentEmbeddings({
                  payload,
                  poolName: pool,
                  collection: collectionSlug,
                  docId: String(id),
                  adapter,
                })
              } catch (e) {
                payload?.logger?.warn?.(
                  `[payloadcms-vectorize] Failed to delete from knowledge pool ${pool}: ${e instanceof Error ? e.message : String(e)}`,
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
                `[payloadcms-vectorize] Failed to delete bulk embedding metadata for ${collectionSlug}:${id}: ${e instanceof Error ? e.message : String(e)}`,
              )
            }
          },
        ],
      }
    }

    const vectorSearchHandlers = createVectorSearchHandlers(
      pluginOptions.knowledgePools,
      pluginOptions.dbAdapter,
    )

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

    const configExtension = pluginOptions.dbAdapter.getConfigExtension(config)

    // Create vectorized payload object factory that creates methods bound to a payload instance
    const createVectorizedPayloadObject = (payload: Payload): VectorizedPayload => {
      return {
        _isBulkEmbedEnabled: (knowledgePool: KnowledgePoolName): boolean => {
          const poolConfig = pluginOptions.knowledgePools[knowledgePool]
          return !!poolConfig?.embeddingConfig?.bulkEmbeddingsFns
        },
        getDbAdapterCustom: () => configExtension?.custom,
        search: (params: VectorSearchQuery) =>
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
                doc: Record<string, unknown>
              },
        ) => {
          const collection = params.collection
          let doc: Record<string, unknown>
          if ('docId' in params && params.docId) {
            doc = await payload.findByID({
              collection: collection as CollectionSlug,
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
        bulkEmbed: (params: { knowledgePool: KnowledgePoolName }): Promise<BulkEmbedResult> =>
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
      } as VectorizedPayload
    }

    // Store factory and db adapter custom in config.custom
    config.custom = {
      ...(config.custom || {}),
      createVectorizedPayloadObject,
      payloadCmsVectorizeDbAdapterCustom: configExtension?.custom,
    }

    if (configExtension?.bins) {
      config.bin = [...(config.bin || []), ...configExtension.bins]
    }

    // Register adapter-provided collections
    if (configExtension?.collections) {
      for (const [_slug, collectionConfig] of Object.entries(configExtension.collections)) {
        if (!config.collections!.find((c) => c.slug === collectionConfig.slug)) {
          config.collections!.push(collectionConfig)
        }
      }
    }

    return config
  }

export const getDbAdapterCustom = (config: Config): Record<string, any> | undefined => {
  return config.custom?.payloadCmsVectorizeDbAdapterCustom
}
