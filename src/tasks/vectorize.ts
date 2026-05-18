import type { Payload, TaskConfig, TaskHandlerResult } from 'payload'

import type {
  DbAdapter,
  KnowledgePoolDynamicConfig,
  KnowledgePoolName,
  ToKnowledgePoolFn,
} from '../types.js'
import { TASK_SLUG_VECTORIZE } from '../constants.js'
import { validateChunkData } from '../utils/validateChunkData.js'

type VectorizeTaskInput = {
  collection: string
  doc: Record<string, any>
  knowledgePool: KnowledgePoolName
}
type VectorizeTaskOutput = {
  success: boolean
}
type VectorizeTaskInputOutput = {
  input: VectorizeTaskInput
  output: VectorizeTaskOutput
}

export const createVectorizeTask = ({
  adapter,
  knowledgePools,
}: {
  adapter: DbAdapter
  knowledgePools: Record<KnowledgePoolName, KnowledgePoolDynamicConfig>
}) => {
  /**
   * Vectorize Task Configuration
   * @description Scheduled task that vectorizes on data change.
   */
  const processVectorizationTask: TaskConfig<VectorizeTaskInputOutput> = {
    slug: TASK_SLUG_VECTORIZE,
    handler: async ({ input, req }): Promise<TaskHandlerResult<VectorizeTaskInputOutput>> => {
      if (!input.collection) {
        throw new Error('[payloadcms-vectorize] collection is required')
      }
      if (!input.knowledgePool) {
        throw new Error('[payloadcms-vectorize] knowledgePool is required')
      }

      const dynamicConfig = knowledgePools[input.knowledgePool]
      if (!dynamicConfig) {
        throw new Error(
          `[payloadcms-vectorize] knowledgePool "${input.knowledgePool}" not found in dynamic configs`,
        )
      }

      await runVectorizeTask({
        adapter,
        dynamicConfig,
        job: {
          collection: input.collection,
          doc: input.doc,
        },
        payload: req.payload,
        poolName: input.knowledgePool,
      })
      return {
        output: {
          success: true,
        },
      }
    },
  }
  return processVectorizationTask
}

async function runVectorizeTask(args: {
  adapter: DbAdapter
  dynamicConfig: KnowledgePoolDynamicConfig
  job: {
    collection: string
    doc: Record<string, any>
  }
  payload: Payload
  poolName: KnowledgePoolName
}) {
  const { adapter, dynamicConfig, job, payload, poolName } = args
  const embeddingVersion = dynamicConfig.embeddingConfig.version
  const sourceDoc = job.doc
  const collection = job.collection
  const collectionConfig = dynamicConfig.collections[collection]
  if (!collectionConfig) {
    throw new Error(
      `[payloadcms-vectorize] collection "${collection}" not configured in knowledge pool "${poolName}"`,
    )
  }
  const toKnowledgePoolFn: ToKnowledgePoolFn = collectionConfig.toKnowledgePool

  // Get chunks from toKnowledgePoolFn
  const chunkData = await toKnowledgePoolFn(sourceDoc, payload)

  validateChunkData(chunkData, String(sourceDoc.id), collection)

  // Extract chunk texts for embedding
  const chunkTexts = chunkData.map((item) => item.chunk)
  const vectors = await dynamicConfig.embeddingConfig.realTimeIngestionFn!(chunkTexts)

  // Delete existing embeddings only after we have valid vectors ready to insert.
  // If toKnowledgePool, validation, or the embedding API fails above, the doc's
  // existing chunks remain intact for the next retry.
  await adapter.deleteChunks(payload, poolName, collection, String(sourceDoc.id))

  // Create embedding documents with extension field values
  await Promise.all(
    vectors.map(async (vector, index) => {
      const { chunk, ...extensionFields } = chunkData[index]
      await adapter.storeChunk(payload, poolName, {
        sourceCollection: collection,
        docId: String(sourceDoc.id),
        chunkIndex: index,
        chunkText: chunk,
        embeddingVersion,
        embedding: vector,
        extensionFields,
      })
    }),
  )
}
