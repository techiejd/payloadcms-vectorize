import { CollectionSlug, Payload, TaskConfig, TaskHandlerResult } from 'payload'
import {
  CollectionVectorizeOption,
  DEFAULT_EMBEDDINGS_COLLECTION,
  FieldVectorizeOption,
  isPostgresPayload,
  PayloadcmsVectorizeConfig,
  PostgresPayload,
  StaticIntegrationConfig,
} from '../types.js'

type VectorizeTaskInput = {
  doc: Record<string, any>
  collection: string
  collections: Partial<Record<CollectionSlug, CollectionVectorizeOption>>
}
type VectorizeTaskOutput = {
  success: boolean
}
type VectorizeTaskInputOutput = {
  input: VectorizeTaskInput
  output: VectorizeTaskOutput
}

export const createVectorizeTask = ({
  integrationConfig,
  opts,
  collections,
}: {
  integrationConfig: StaticIntegrationConfig
  opts: PayloadcmsVectorizeConfig & {
    embeddingsCollectionSlug?: string
  }
  collections: Partial<Record<CollectionSlug, CollectionVectorizeOption>>
}) => {
  /**
   * Vectorize Task Configuration
   * @description Scheduled task that vectorizes on data change.
   * Runs every 5 seconds to call the embedding function.
   */
  const processVectorizationTask: TaskConfig<VectorizeTaskInputOutput> = {
    slug: 'payloadcms-vectorize:vectorize',
    handler: async ({ input, req }): Promise<TaskHandlerResult<VectorizeTaskInputOutput>> => {
      if (!input.collection) {
        throw new Error('[payloadcms-vectorize] collection is required')
      }
      if (!collections[input.collection]) {
        throw new Error('[payloadcms-vectorize] collection is required')
      }
      const fieldsConfig = (collections[input.collection] as CollectionVectorizeOption).fields
      await runVectorizeTask({
        payload: req.payload,
        pluginOptions: { ...opts, ...integrationConfig },
        job: { doc: input.doc, collection: input.collection, fieldsConfig },
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
  pluginOptions: PayloadcmsVectorizeConfig & StaticIntegrationConfig
  job: {
    doc: Record<string, any>
    collection: string
    fieldsConfig: Record<string, FieldVectorizeOption>
  }
}) {
  const { payload, pluginOptions, job } = args
  const embeddingsSlug = pluginOptions.embeddingsSlugOverride || DEFAULT_EMBEDDINGS_COLLECTION
  const embeddingVersion = pluginOptions.embeddingVersion
  const sourceDoc = job.doc
  const collection = job.collection
  const fieldsConfig = job.fieldsConfig

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

  const inputs: { chunkText: string; fieldPath: string; chunkIndex: number }[] = []
  for (const [fieldPath, fieldCfg] of Object.entries(fieldsConfig)) {
    // Delete existing embeddings for this doc/field combination to keep one set per doc/field
    // The embeddingVersion is stored in each document and can be updated by re-vectorizing
    await payload.delete({
      collection: embeddingsSlug,
      where: {
        and: [
          { sourceCollection: { equals: collection } },
          { docId: { equals: String(sourceDoc.id) } },
          { fieldPath: { equals: fieldPath } },
        ],
      },
    })
    const value = getByPath(sourceDoc, fieldPath)
    const chunker = fieldCfg.chunker
    const chunks = await chunker(value, payload)
    inputs.push(
      ...chunks.map((chunk, index) => ({ chunkText: chunk, fieldPath, chunkIndex: index })),
    )
  }
  const chunkTexts = inputs.map((input) => input.chunkText)
  const vectors = await pluginOptions.embed(chunkTexts)
  await Promise.all(
    vectors.map(async (vector, index) => {
      const { fieldPath, chunkIndex, chunkText } = inputs[index]
      const created = await payload.create({
        collection: embeddingsSlug,
        data: {
          sourceCollection: collection,
          docId: String(sourceDoc.id),
          fieldPath,
          chunkIndex,
          chunkText,
          embeddingVersion,
          embedding: Array.isArray(vector) ? vector : Array.from(vector),
        },
      })

      const id = String(created.id)
      const literal = `[${Array.from(vector).join(',')}]`
      const sql = `UPDATE "${embeddingsSlug}" SET embedding = $1 WHERE id = $2` as string
      try {
        await runSQL(sql, [literal, id])
      } catch (e) {
        payload.logger.error('[payloadcms-vectorize] Failed to persist vector column', e as Error)
        throw new Error(`[payloadcms-vectorize] Failed to persist vector column: ${e}`)
      }
    }),
  )
}

function getByPath(obj: any, path: string): any {
  if (!obj) return undefined
  return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj)
}
