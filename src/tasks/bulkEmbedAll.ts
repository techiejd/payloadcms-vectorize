import { Payload, TaskConfig, TaskHandlerResult } from 'payload'
import {
  BulkEmbeddingInput,
  BulkEmbeddingsConfig,
  KnowledgePoolDynamicConfig,
  KnowledgePoolName,
} from '../types.js'
import { BULK_EMBEDDINGS_RUNS_SLUG } from '../collections/bulkEmbeddingsRuns.js'
import { isPostgresPayload, PostgresPayload } from '../types.js'

type PrepareBulkEmbeddingTaskInput = {
  runId: string
}

type PrepareBulkEmbeddingTaskOutput = {
  runId: string
  status: string
}

type PrepareBulkEmbeddingTaskInputOutput = {
  input: PrepareBulkEmbeddingTaskInput
  output: PrepareBulkEmbeddingTaskOutput
}

type PollOrCompleteBulkEmbeddingTaskInput = {
  runId: string
}

type PollOrCompleteBulkEmbeddingTaskOutput = {
  runId: string
  status: string
}

type PollOrCompleteBulkEmbeddingTaskInputOutput = {
  input: PollOrCompleteBulkEmbeddingTaskInput
  output: PollOrCompleteBulkEmbeddingTaskOutput
}

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'canceled'])

// Helper to load and validate run + config
async function loadRunAndConfig({
  payload,
  runId,
  knowledgePools,
}: {
  payload: Payload
  runId: string
  knowledgePools: Record<KnowledgePoolName, KnowledgePoolDynamicConfig>
}) {
  const run = await payload.findByID({
    collection: BULK_EMBEDDINGS_RUNS_SLUG,
    id: runId,
  })
  const poolName = (run as any)?.pool as KnowledgePoolName
  if (!poolName) {
    throw new Error(`[payloadcms-vectorize] bulk embed run ${runId} missing pool`)
  }
  const dynamicConfig = knowledgePools[poolName]
  if (!dynamicConfig) {
    throw new Error(
      `[payloadcms-vectorize] knowledgePool "${poolName}" not found for bulk embed run ${runId}`,
    )
  }
  if (!dynamicConfig.bulkEmbeddings) {
    throw new Error(
      `[payloadcms-vectorize] knowledgePool "${poolName}" does not have bulkEmbeddings configured`,
    )
  }
  return { run, poolName, dynamicConfig }
}

export const createPrepareBulkEmbeddingTask = ({
  knowledgePools,
  bulkQueueName,
}: {
  knowledgePools: Record<KnowledgePoolName, KnowledgePoolDynamicConfig>
  bulkQueueName?: string
}): TaskConfig<PrepareBulkEmbeddingTaskInputOutput> => {
  const task: TaskConfig<PrepareBulkEmbeddingTaskInputOutput> = {
    slug: 'payloadcms-vectorize:prepare-bulk-embedding',
    handler: async ({
      input,
      req,
    }): Promise<TaskHandlerResult<PrepareBulkEmbeddingTaskInputOutput>> => {
      if (!input?.runId) {
        throw new Error('[payloadcms-vectorize] bulk embed runId is required')
      }
      const payload = req.payload
      const { run, poolName, dynamicConfig } = await loadRunAndConfig({
        payload,
        runId: input.runId,
        knowledgePools,
      })

      const callbacks = dynamicConfig.bulkEmbeddings!
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

      // Queue the poll task
      await payload.jobs.queue<'payloadcms-vectorize:poll-or-complete-bulk-embedding'>({
        task: 'payloadcms-vectorize:poll-or-complete-bulk-embedding',
        input: { runId: input.runId },
        req,
        ...(bulkQueueName ? { queue: bulkQueueName } : {}),
      })

      return { output: { runId: input.runId, status: 'prepared' } }
    },
  }

  return task
}

export const createPollOrCompleteBulkEmbeddingTask = ({
  knowledgePools,
  bulkQueueName,
}: {
  knowledgePools: Record<KnowledgePoolName, KnowledgePoolDynamicConfig>
  bulkQueueName?: string
}): TaskConfig<PollOrCompleteBulkEmbeddingTaskInputOutput> => {
  const task: TaskConfig<PollOrCompleteBulkEmbeddingTaskInputOutput> = {
    slug: 'payloadcms-vectorize:poll-or-complete-bulk-embedding',
    handler: async ({
      input,
      req,
    }): Promise<TaskHandlerResult<PollOrCompleteBulkEmbeddingTaskInputOutput>> => {
      if (!input?.runId) {
        throw new Error('[payloadcms-vectorize] bulk embed runId is required')
      }
      const payload = req.payload
      const { run, poolName, dynamicConfig } = await loadRunAndConfig({
        payload,
        runId: input.runId,
        knowledgePools,
      })

      const callbacks = dynamicConfig.bulkEmbeddings!
      const providerBatchId = (run as any).providerBatchId
      const embeddingVersion = dynamicConfig.embeddingVersion

      // Check if already terminal
      const currentStatus = (run as any).status
      if (TERMINAL_STATUSES.has(currentStatus)) {
        return { output: { runId: input.runId, status: currentStatus } }
      }

      // Poll once
      const pollResult = await callbacks.pollBulkEmbeddings({
        payload,
        knowledgePool: poolName,
        providerBatchId,
      })

      const newStatus = pollResult.status
      await payload.update({
        id: input.runId,
        collection: BULK_EMBEDDINGS_RUNS_SLUG,
        data: {
          status: newStatus,
          inputs: pollResult.counts?.inputs,
          succeeded: pollResult.counts?.succeeded,
          failed: pollResult.counts?.failed,
          error: pollResult.error,
        },
      })

      // If still not terminal, requeue this task
      if (!TERMINAL_STATUSES.has(newStatus)) {
        await payload.jobs.queue<'payloadcms-vectorize:poll-or-complete-bulk-embedding'>({
          task: 'payloadcms-vectorize:poll-or-complete-bulk-embedding',
          input: { runId: input.runId },
          req,
          ...(bulkQueueName ? { queue: bulkQueueName } : {}),
        })
        return { output: { runId: input.runId, status: 'polling' } }
      }

      // Terminal - handle success vs failure
      if (newStatus !== 'succeeded') {
        await payload.update({
          id: input.runId,
          collection: BULK_EMBEDDINGS_RUNS_SLUG,
          data: {
            completedAt: new Date().toISOString(),
          },
        })
        return { output: { runId: input.runId, status: newStatus } }
      }

      // Success - complete the embeddings
      const completion = (await callbacks.completeBulkEmbeddings({
        payload,
        knowledgePool: poolName,
        providerBatchId,
      })) || { status: newStatus, outputs: [] }

      const outputs = completion.outputs || []

      // Re-collect inputs to match outputs (in case they changed during polling)
      const inputs = await collectMissingEmbeddings({
        payload,
        poolName,
        dynamicConfig,
        embeddingVersion,
      })
      const inputsById = new Map(inputs.map((input) => [input.id, input]))
      const successfulOutputs = outputs.filter((o) => !o.error && o.embedding)
      const failedCount = completion.counts?.failed ?? outputs.length - successfulOutputs.length

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
          inputs: completion.counts?.inputs ?? outputs.length,
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
