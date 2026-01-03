import { Payload, TaskConfig, TaskHandlerResult } from 'payload'
import {
  BulkEmbeddingInput,
  BulkEmbeddingsFns,
  CollectedEmbeddingInput,
  KnowledgePoolDynamicConfig,
  KnowledgePoolName,
} from '../types.js'
import { BULK_EMBEDDINGS_RUNS_SLUG } from '../collections/bulkEmbeddingsRuns.js'
import { BULK_EMBEDDINGS_INPUT_METADATA_SLUG } from '../collections/bulkEmbeddingInputMetadata.js'
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
  pollOrCompleteQueueName,
}: {
  knowledgePools: Record<KnowledgePoolName, KnowledgePoolDynamicConfig>
  pollOrCompleteQueueName?: string
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

      const latestSucceededRun = await payload.find({
        collection: BULK_EMBEDDINGS_RUNS_SLUG,
        where: {
          and: [
            { pool: { equals: poolName } },
            { status: { equals: 'succeeded' } },
            { completedAt: { exists: true } },
          ],
        },
        limit: 1,
        sort: '-completedAt',
      })

      const baselineRun = (latestSucceededRun as any)?.docs?.[0]
      const baselineVersion: string | undefined = baselineRun?.embeddingVersion
      const lastBulkCompletedAt: string | undefined = baselineRun?.completedAt
      const currentEmbeddingVersion = embeddingVersion
      const versionMismatch =
        baselineVersion !== undefined && baselineVersion !== currentEmbeddingVersion

      const inputsWithMetadata = await collectMissingEmbeddings({
        payload,
        poolName,
        dynamicConfig,
        embeddingVersion: currentEmbeddingVersion,
        lastBulkCompletedAt,
        versionMismatch,
        hasBaseline: Boolean(baselineRun),
      })

      const inputsCount = inputsWithMetadata.length
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

      // Persist metadata for this run so we can rebuild embeddings later
      await Promise.all(
        inputsWithMetadata.map((inputWithMeta) =>
          payload.create({
            collection: BULK_EMBEDDINGS_INPUT_METADATA_SLUG,
            data: {
              run: (run as any).id,
              inputId: inputWithMeta.id,
              text: inputWithMeta.text,
              sourceCollection: inputWithMeta.metadata.sourceCollection,
              docId: inputWithMeta.metadata.docId,
              chunkIndex: inputWithMeta.metadata.chunkIndex,
              embeddingVersion: inputWithMeta.metadata.embeddingVersion,
              extensionFields: inputWithMeta.metadata.extensionFields,
            },
          }),
        ),
      )

      const providerInputs: BulkEmbeddingInput[] = inputsWithMetadata.map(({ id, text }) => ({
        id,
        text,
      }))

      const prepare = (await callbacks.prepareBulkEmbeddings({
        payload,
        knowledgePool: poolName,
        embeddingVersion,
        inputs: providerInputs,
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
        ...(pollOrCompleteQueueName ? { queue: pollOrCompleteQueueName } : {}),
      })

      return { output: { runId: input.runId, status: 'prepared' } }
    },
  }

  return task
}

export const createPollOrCompleteBulkEmbeddingTask = ({
  knowledgePools,
  pollOrCompleteQueueName,
}: {
  knowledgePools: Record<KnowledgePoolName, KnowledgePoolDynamicConfig>
  pollOrCompleteQueueName?: string
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
          ...(pollOrCompleteQueueName ? { queue: pollOrCompleteQueueName } : {}),
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

      // Load stored metadata for this run
      const metadataById = await loadInputMetadataByRun({
        payload,
        runId: String((run as any).id),
      })

      const successfulOutputs = outputs.filter((o) => !o.error && o.embedding)
      const failedCount = completion.counts?.failed ?? outputs.length - successfulOutputs.length

      // Remove existing embeddings for successful doc ids before writing new vectors
      const docKeys = new Set<string>()
      for (const output of successfulOutputs) {
        const meta = metadataById.get(output.id)
        if (!meta) continue
        docKeys.add(`${meta.sourceCollection}:${meta.docId}`)
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
        const meta = metadataById.get(output.id)
        if (!meta || !output.embedding) continue

        const embeddingArray = Array.isArray(output.embedding)
          ? output.embedding
          : Array.from(output.embedding)

        const chunkText = meta.text

        const created = await payload.create({
          collection: poolName,
          data: {
            sourceCollection: meta.sourceCollection,
            docId: String(meta.docId),
            chunkIndex: meta.chunkIndex,
            chunkText,
            embeddingVersion: meta.embeddingVersion,
            ...(meta.extensionFields || {}),
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

      // Cleanup stored metadata for this run
      await payload.delete({
        collection: BULK_EMBEDDINGS_INPUT_METADATA_SLUG,
        where: { run: { equals: (run as any).id } },
      })

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
  lastBulkCompletedAt?: string
  versionMismatch: boolean
  hasBaseline: boolean
}): Promise<CollectedEmbeddingInput[]> {
  const {
    payload,
    poolName,
    dynamicConfig,
    embeddingVersion,
    lastBulkCompletedAt,
    versionMismatch,
    hasBaseline,
  } = args
  const inputs: CollectedEmbeddingInput[] = []

  const includeAll = versionMismatch || !hasBaseline
  const lastCompletedAtDate = lastBulkCompletedAt ? new Date(lastBulkCompletedAt) : undefined

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
        const docUpdatedAt = doc?.updatedAt ? new Date(doc.updatedAt) : undefined
        let shouldInclude = includeAll
        if (!shouldInclude) {
          const updatedAfter =
            docUpdatedAt && lastCompletedAtDate ? docUpdatedAt > lastCompletedAtDate : false
          const hasCurrentEmbedding = await docHasEmbeddingVersion({
            payload,
            poolName,
            sourceCollection: collectionSlug,
            docId: String(doc.id),
            embeddingVersion,
          })
          shouldInclude = updatedAfter || !hasCurrentEmbedding
        }
        if (!shouldInclude) continue

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
              extensionFields,
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

async function docHasEmbeddingVersion(args: {
  payload: Payload
  poolName: KnowledgePoolName
  sourceCollection: string
  docId: string
  embeddingVersion: string
}): Promise<boolean> {
  const { payload, poolName, sourceCollection, docId, embeddingVersion } = args
  const existing = await payload.find({
    collection: poolName,
    where: {
      and: [
        { sourceCollection: { equals: sourceCollection } },
        { docId: { equals: String(docId) } },
        { embeddingVersion: { equals: embeddingVersion } },
      ],
    },
    limit: 1,
  })
  return (existing as any)?.totalDocs > 0
}

async function loadInputMetadataByRun(args: { payload: Payload; runId: string }): Promise<
  Map<
    string,
    {
      text: string
      sourceCollection: string
      docId: string
      chunkIndex: number
      embeddingVersion: string
      extensionFields?: Record<string, any>
    }
  >
> {
  const { payload, runId } = args
  const map = new Map<
    string,
    {
      text: string
      sourceCollection: string
      docId: string
      chunkIndex: number
      embeddingVersion: string
      extensionFields?: Record<string, any>
    }
  >()

  let page = 1
  const limit = 100
  while (true) {
    const res = await payload.find({
      collection: BULK_EMBEDDINGS_INPUT_METADATA_SLUG,
      page,
      limit,
      where: { run: { equals: runId } },
      sort: 'inputId',
    })
    const docs = (res as any)?.docs || []
    if (!docs.length) break

    for (const doc of docs) {
      map.set(String(doc.inputId), {
        text: doc.text,
        sourceCollection: doc.sourceCollection,
        docId: String(doc.docId),
        chunkIndex: doc.chunkIndex,
        embeddingVersion: doc.embeddingVersion,
        extensionFields: doc.extensionFields || undefined,
      })
    }

    const totalPages = (res as any)?.totalPages ?? page
    page += 1
    if (page > totalPages) break
  }

  return map
}
