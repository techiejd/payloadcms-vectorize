import { Payload, TaskConfig, TaskHandlerResult } from 'payload'
import {
  isPostgresPayload,
  PostgresPayload,
  KnowledgePoolName,
  KnowledgePoolDynamicConfig,
  ToKnowledgePoolFn,
} from '../types.js'

type VectorizeTaskInput = {
  doc: Record<string, any>
  collection: string
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
  knowledgePools,
}: {
  knowledgePools: Record<KnowledgePoolName, KnowledgePoolDynamicConfig>
}) => {
  /**
   * Vectorize Task Configuration
   * @description Scheduled task that vectorizes on data change.
   * Runs every 5 seconds to call the embedding function.
   */
  const processVectorizationTask: TaskConfig<VectorizeTaskInputOutput> = {
    slug: 'payloadcms-vectorize:vectorize',
    handler: async ({ input, req }): Promise<TaskHandlerResult<VectorizeTaskInputOutput>> => {
      if (!input.collection) throw new Error('[payloadcms-vectorize] collection is required')
      if (!input.knowledgePool) throw new Error('[payloadcms-vectorize] knowledgePool is required')

      const dynamicConfig = knowledgePools[input.knowledgePool]
      if (!dynamicConfig) {
        throw new Error(
          `[payloadcms-vectorize] knowledgePool "${input.knowledgePool}" not found in dynamic configs`,
        )
      }

      await runVectorizeTask({
        payload: req.payload,
        poolName: input.knowledgePool,
        dynamicConfig,
        job: {
          doc: input.doc,
          collection: input.collection,
        },
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
  payload: Payload
  poolName: KnowledgePoolName
  dynamicConfig: KnowledgePoolDynamicConfig
  job: {
    doc: Record<string, any>
    collection: string
  }
}) {
  const { payload, poolName, dynamicConfig, job } = args
  const embeddingVersion = dynamicConfig.embeddingVersion
  const sourceDoc = job.doc
  const collection = job.collection
  const collectionConfig = dynamicConfig.collections[collection]
  if (!collectionConfig) {
    throw new Error(
      `[payloadcms-vectorize] collection "${collection}" not configured in knowledge pool "${poolName}"`,
    )
  }
  const toKnowledgePoolFn: ToKnowledgePoolFn = collectionConfig.toKnowledgePool

  const isPostgres = isPostgresPayload(payload)
  if (!isPostgres) {
    throw new Error('[payloadcms-vectorize] Only works with Postgres')
  }
  const runSQL = async (sql: string, params?: any[]) => {
    const postgresPayload = payload as PostgresPayload
    if (postgresPayload.db.pool?.query) return postgresPayload.db.pool.query(sql, params)
    if (postgresPayload.db.drizzle?.execute) return postgresPayload.db.drizzle.execute(sql)
    throw new Error('[payloadcms-vectorize] Failed to persist vector column')
  }

  // Delete all existing embeddings for this document before creating new ones
  // This ensures we replace old embeddings (potentially with a different embeddingVersion)
  // and prevents duplicates when a document is updated
  await payload.delete({
    collection: poolName,
    where: {
      and: [
        { sourceCollection: { equals: collection } },
        { docId: { equals: String(sourceDoc.id) } },
      ],
    },
  })

  // Get chunks from toKnowledgePoolFn
  const chunkData = await toKnowledgePoolFn(sourceDoc, payload)

  if (!Array.isArray(chunkData)) {
    throw new Error(
      `[payloadcms-vectorize] toKnowledgePool for collection "${collection}" must return an array of entries with a required "chunk" string`,
    )
  }

  const invalidEntries = chunkData
    .map((entry, idx) => {
      if (!entry || typeof entry !== 'object') return idx
      if (typeof entry.chunk !== 'string') return idx
      return null
    })
    .filter((idx): idx is number => idx !== null)

  if (invalidEntries.length > 0) {
    throw new Error(
      `[payloadcms-vectorize] toKnowledgePool returned ${invalidEntries.length} invalid entr${
        invalidEntries.length === 1 ? 'y' : 'ies'
      } for document ${sourceDoc.id} in collection "${collection}". Each entry must be an object with a "chunk" string. Invalid indices: ${invalidEntries.join(
        ', ',
      )}`,
    )
  }

  // Extract chunk texts for embedding
  const chunkTexts = chunkData.map((item) => item.chunk)
  const vectors = await dynamicConfig.embedDocs(chunkTexts)

  // Create embedding documents with extension field values
  await Promise.all(
    vectors.map(async (vector, index) => {
      const { chunk, ...extensionFields } = chunkData[index]
      const created = await payload.create({
        collection: poolName,
        data: {
          sourceCollection: collection,
          docId: String(sourceDoc.id),
          chunkIndex: index,
          chunkText: chunk,
          embeddingVersion,
          ...extensionFields,
          embedding: Array.isArray(vector) ? vector : Array.from(vector),
        },
      })

      const id = String(created.id)
      const literal = `[${Array.from(vector).join(',')}]`
      const postgresPayload = payload as PostgresPayload
      const schemaName = postgresPayload.db.schemaName || 'public'
      const sql = `UPDATE "${schemaName}"."${poolName}" SET embedding = $1 WHERE id = $2` as string
      try {
        await runSQL(sql, [literal, id])
      } catch (e) {
        const errorMessage = (e as Error).message || (e as any).toString()
        payload.logger.error(
          `[payloadcms-vectorize] Failed to persist vector column: ${errorMessage}`,
        )
        throw new Error(`[payloadcms-vectorize] Failed to persist vector column: ${e}`)
      }
    }),
  )
}
