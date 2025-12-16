import { Payload, TaskConfig, TaskHandlerResult } from 'payload'
import {
  BulkEmbeddingInput,
  BulkEmbeddingsConfig,
  KnowledgePoolDynamicConfig,
  KnowledgePoolName,
} from '../types.js'
import { BULK_EMBEDDINGS_RUNS_SLUG } from '../collections/bulkEmbeddingsRuns.js'
import { isPostgresPayload, PostgresPayload } from '../types.js'

type BulkEmbedAllTaskInput = {
  runId: string
}

type BulkEmbedAllTaskOutput = {
  runId: string
  status: string
}

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'canceled'])
const fallbackInputsCache = new Map<string, BulkEmbeddingInput[]>()

export function createFallbackBulkCallbacks(
  dynamicConfig: KnowledgePoolDynamicConfig,
): BulkEmbeddingsConfig {
  return {
    prepareBulkEmbeddings: async ({ inputs }) => {
      const providerBatchId = `local-${Date.now()}-${Math.random().toString(16).slice(2)}`
      fallbackInputsCache.set(providerBatchId, inputs)
      return {
        providerBatchId,
        status: 'queued',
        counts: { inputs: inputs.length },
      }
    },
    pollBulkEmbeddings: async ({ providerBatchId }) => {
      if (!fallbackInputsCache.has(providerBatchId)) {
        return { status: 'failed', error: 'Unknown local batch' }
      }
      return {
        status: 'succeeded',
        counts: { inputs: fallbackInputsCache.get(providerBatchId)?.length },
      }
    },
    completeBulkEmbeddings: async ({ providerBatchId }) => {
      const inputs = fallbackInputsCache.get(providerBatchId) || []
      const embeddings = await dynamicConfig.embedDocs(inputs.map((i) => i.text))
      const outputs = embeddings.map((vector, idx) => {
        const input = inputs[idx]
        return {
          id: input?.id ?? String(idx),
          embedding: Array.isArray(vector) ? vector : Array.from(vector),
        }
      })
      fallbackInputsCache.delete(providerBatchId)
      return {
        status: 'succeeded',
        outputs,
        counts: {
          inputs: inputs.length,
          succeeded: outputs.length,
          failed: inputs.length - outputs.length,
        },
      }
    },
  }
}

export const createBulkEmbedAllTask = ({
  knowledgePools,
}: {
  knowledgePools: Record<KnowledgePoolName, KnowledgePoolDynamicConfig>
}): TaskConfig<BulkEmbedAllTaskInput> => {
  const task: TaskConfig<BulkEmbedAllTaskInput> = {
    slug: 'payloadcms-vectorize:bulk-embed-all',
    handler: async ({ input, req }): Promise<TaskHandlerResult<BulkEmbedAllTaskOutput>> => {
      if (!input?.runId) {
        throw new Error('[payloadcms-vectorize] bulk embed runId is required')
      }
      const payload = req.payload
      const run = await payload.findByID({
        collection: BULK_EMBEDDINGS_RUNS_SLUG,
        id: input.runId,
      })
      const poolName = (run as any)?.pool as KnowledgePoolName
      if (!poolName) {
        throw new Error(`[payloadcms-vectorize] bulk embed run ${input.runId} missing pool`)
      }
      const dynamicConfig = knowledgePools[poolName]
      if (!dynamicConfig) {
        throw new Error(
          `[payloadcms-vectorize] knowledgePool "${poolName}" not found for bulk embed run ${input.runId}`,
        )
      }

      const callbacks = dynamicConfig.bulkEmbeddings || createFallbackBulkCallbacks(dynamicConfig)
      const embeddingVersion = dynamicConfig.embeddingVersion

      const inputs = await collectMissingEmbeddings({
        payload,
        poolName,
        dynamicConfig,
        embeddingVersion,
      })

      const inputsCount = inputs.length
      if (inputsCount === 0) {
        await payload.update({
          id: input.runId,
          collection: BULK_EMBEDDINGS_RUNS_SLUG,
          data: {
            status: 'succeeded',
            inputs: 0,
            succeeded: 0,
            failed: 0,
            completedAt: new Date().toISOString(),
          },
        })
        return { output: { runId: input.runId, status: 'succeeded' } }
      }

      const prepare = (await callbacks.prepareBulkEmbeddings({
        payload,
        knowledgePool: poolName,
        embeddingVersion,
        inputs,
      })) || { providerBatchId: `local-${Date.now()}` }

      const providerBatchId = prepare.providerBatchId
      let status = prepare.status ?? 'running'
      await payload.update({
        id: input.runId,
        collection: BULK_EMBEDDINGS_RUNS_SLUG,
        data: {
          providerBatchId,
          inputFileRef: prepare.inputFileRef,
          status,
          inputs: prepare.counts?.inputs ?? inputsCount,
          submittedAt: new Date().toISOString(),
        },
      })

      // Poll until terminal
      let pollResult: any = null
      const maxPolls = 10
      let polls = 0
      while (!TERMINAL_STATUSES.has(status) && polls < maxPolls) {
        pollResult = await callbacks.pollBulkEmbeddings({
          payload,
          knowledgePool: poolName,
          providerBatchId,
        })
        status = pollResult.status
        await payload.update({
          id: input.runId,
          collection: BULK_EMBEDDINGS_RUNS_SLUG,
          data: {
            status,
            inputs: pollResult.counts?.inputs ?? inputsCount,
            succeeded: pollResult.counts?.succeeded,
            failed: pollResult.counts?.failed,
            error: pollResult.error,
          },
        })
        if (TERMINAL_STATUSES.has(status)) break
        polls += 1
        const delay = pollResult.nextPollMs ?? 1000
        await new Promise((resolve) => setTimeout(resolve, delay))
      }

      if (status !== 'succeeded') {
        await payload.update({
          id: input.runId,
          collection: BULK_EMBEDDINGS_RUNS_SLUG,
          data: {
            status,
            error: pollResult?.error,
            completedAt: new Date().toISOString(),
          },
        })
        return { output: { runId: input.runId, status } }
      }

      const completion = (await callbacks.completeBulkEmbeddings({
        payload,
        knowledgePool: poolName,
        providerBatchId,
      })) || { status, outputs: [] }

      const outputs = completion.outputs || []
      const inputsById = new Map(inputs.map((input) => [input.id, input]))
      const successfulOutputs = outputs.filter((o) => !o.error && o.embedding)
      const failedCount = completion.counts?.failed ?? inputsCount - successfulOutputs.length

      // Remove existing embeddings for successful doc ids before writing new vectors
      const docKeys = new Set<string>()
      for (const output of successfulOutputs) {
        const inputMeta = inputsById.get(output.id)?.metadata
        if (!inputMeta) continue
        docKeys.add(`${inputMeta.sourceCollection}:${inputMeta.docId}`)
      }
      for (const key of docKeys) {
        const [sourceCollection, docId] = key.split(':')
        await payload.delete({
          collection: poolName,
          where: {
            and: [
              { sourceCollection: { equals: sourceCollection } },
              { docId: { equals: String(docId) } },
            ],
          },
        })
      }

      for (const output of successfulOutputs) {
        const input = inputsById.get(output.id)
        if (!input || !output.embedding) continue

        const embeddingArray = Array.isArray(output.embedding)
          ? output.embedding
          : Array.from(output.embedding)

        const {
          chunkIndex,
          sourceCollection,
          docId,
          embeddingVersion: version,
          ...rest
        } = input.metadata
        const chunkText = input.text

        const created = await payload.create({
          collection: poolName,
          data: {
            sourceCollection,
            docId: String(docId),
            chunkIndex,
            chunkText,
            embeddingVersion: version,
            ...rest,
            embedding: embeddingArray,
          } as any,
        })
        await persistVectorColumn({
          payload,
          poolName,
          vector: embeddingArray,
          id: String((created as any)?.id ?? ''),
        })
      }

      await payload.update({
        id: input.runId,
        collection: BULK_EMBEDDINGS_RUNS_SLUG,
        data: {
          status: completion.status ?? 'succeeded',
          inputs: completion.counts?.inputs ?? inputsCount,
          succeeded: completion.counts?.succeeded ?? successfulOutputs.length,
          failed: failedCount,
          error: completion.error,
          completedAt: new Date().toISOString(),
        },
      })

      return {
        output: {
          runId: input.runId,
          status: completion.status ?? 'succeeded',
        },
      }
    },
  }

  return task
}

async function persistVectorColumn(args: {
  payload: Payload
  poolName: KnowledgePoolName
  vector: number[] | Float32Array
  id: string
}) {
  const { payload, poolName, vector, id } = args
  if (!isPostgresPayload(payload)) {
    throw new Error('[payloadcms-vectorize] Bulk embeddings require the Postgres adapter')
  }
  const postgresPayload = payload as PostgresPayload
  const schemaName = postgresPayload.db.schemaName || 'public'
  const literal = `[${Array.from(vector).join(',')}]`
  const sql = `UPDATE "${schemaName}"."${poolName}" SET embedding = $1 WHERE id = $2`
  const runSQL = async (statement: string, params?: any[]) => {
    if (postgresPayload.db.pool?.query) return postgresPayload.db.pool.query(statement, params)
    if (postgresPayload.db.drizzle?.execute) return postgresPayload.db.drizzle.execute(statement)
    throw new Error('[payloadcms-vectorize] Failed to persist vector column')
  }
  try {
    await runSQL(sql, [literal, id])
  } catch (e) {
    payload.logger.error('[payloadcms-vectorize] Failed to persist vector column', e as Error)
    throw e
  }
}

async function collectMissingEmbeddings(args: {
  payload: Payload
  poolName: KnowledgePoolName
  dynamicConfig: KnowledgePoolDynamicConfig
  embeddingVersion: string
}): Promise<BulkEmbeddingInput[]> {
  const { payload, poolName, dynamicConfig, embeddingVersion } = args
  const inputs: BulkEmbeddingInput[] = []

  for (const collectionSlug of Object.keys(dynamicConfig.collections)) {
    const collectionConfig = dynamicConfig.collections[collectionSlug]
    if (!collectionConfig) continue
    const toKnowledgePool = collectionConfig.toKnowledgePool
    let page = 1
    const limit = 50

    // Paginate through source collection docs
    while (true) {
      const res = await payload.find({
        collection: collectionSlug,
        page,
        limit,
      })
      const docs = (res as any)?.docs || []
      if (!docs.length) break
      const totalPages = (res as any)?.totalPages ?? page

      for (const doc of docs) {
        const existing = await payload.find({
          collection: poolName,
          where: {
            and: [
              { sourceCollection: { equals: collectionSlug } },
              { docId: { equals: String(doc.id) } },
              { embeddingVersion: { equals: embeddingVersion } },
            ],
          },
          limit: 1,
        })
        if (existing.totalDocs > 0) continue

        const chunkData = await toKnowledgePool(doc, payload)
        chunkData.forEach((chunkEntry, idx) => {
          if (!chunkEntry?.chunk) return
          const { chunk, ...extensionFields } = chunkEntry
          inputs.push({
            id: `${collectionSlug}:${doc.id}:${idx}`,
            text: chunk,
            metadata: {
              sourceCollection: collectionSlug,
              docId: String(doc.id),
              chunkIndex: idx,
              embeddingVersion,
              ...extensionFields,
            },
          })
        })
      }
      page += 1
      if (page > totalPages) break
    }
  }

  return inputs
}
