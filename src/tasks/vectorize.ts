import type { Payload, TaskConfig, TaskHandlerResult } from 'payload'

import type {
  DbAdapter,
  KnowledgePoolDynamicConfig,
  KnowledgePoolName,
  ToKnowledgePoolFn,
} from '../types.js'
import { TASK_SLUG_VECTORIZE } from '../constants.js'
import { validateChunkData } from '../utils/validateChunkData.js'
import { deleteDocumentEmbeddings } from '../utils/deleteDocumentEmbeddings.js'

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

  // Delete all existing embeddings for this document before creating new ones
  // This ensures we replace old embeddings (potentially with a different embeddingVersion)
  // and prevents duplicates when a document is updated
  await deleteDocumentEmbeddings({
    payload,
    poolName,
    collection,
    docId: String(sourceDoc.id),
    adapter,
  })

  // Get chunks from toKnowledgePoolFn
  const chunkData = await toKnowledgePoolFn(sourceDoc, payload)

  validateChunkData(chunkData, String(sourceDoc.id), collection)

  // Extract chunk texts for embedding
  const chunkTexts = chunkData.map((item) => item.chunk)
  const vectors = await dynamicConfig.embeddingConfig.realTimeIngestionFn!(chunkTexts)

  // Create embedding documents with extension field values
  await Promise.all(
    vectors.map(async (vector, index) => {
      const { chunk, ...extensionFields } = chunkData[index]
      const created = await payload.create({
        collection: poolName,
        data: {
          chunkIndex: index,
          chunkText: chunk,
          docId: String(sourceDoc.id),
          embeddingVersion,
          sourceCollection: collection,
          ...extensionFields,
          embedding: Array.isArray(vector) ? vector : Array.from(vector),
        },
      })

      const id = String(created.id)

      await adapter.storeEmbedding(payload, poolName, collection, String(sourceDoc.id), id, vector)
    }),
  )
}
