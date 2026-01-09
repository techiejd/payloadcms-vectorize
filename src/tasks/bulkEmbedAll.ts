import { Payload, TaskConfig, TaskHandlerResult } from 'payload'
import {
  BatchSubmission,
  BulkEmbeddingOutput,
  CollectedEmbeddingInput,
  KnowledgePoolDynamicConfig,
  KnowledgePoolName,
} from '../types.js'
import { BULK_EMBEDDINGS_RUNS_SLUG } from '../collections/bulkEmbeddingsRuns.js'
import { BULK_EMBEDDINGS_INPUT_METADATA_SLUG } from '../collections/bulkEmbeddingInputMetadata.js'
import { BULK_EMBEDDINGS_BATCHES_SLUG } from '../collections/bulkEmbeddingsBatches.js'
import { isPostgresPayload, PostgresPayload, BulkEmbeddingInput } from '../types.js'
import toSnakeCase from 'to-snake-case'

type PrepareBulkEmbeddingTaskInput = {
  runId: string
}

type PrepareBulkEmbeddingTaskOutput = {
  runId: string
  status: string
  batchCount?: number
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
  if (!dynamicConfig.embeddingConfig.bulkEmbeddingsFns) {
    throw new Error(
      `[payloadcms-vectorize] knowledgePool "${poolName}" does not have bulkEmbeddingsFns configured`,
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

      const callbacks = dynamicConfig.embeddingConfig.bulkEmbeddingsFns!
      const embeddingVersion = dynamicConfig.embeddingConfig.version

      // Find baseline run information
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
      const versionMismatch = baselineVersion !== undefined && baselineVersion !== embeddingVersion

      // Stream missing embeddings and create batches
      const result = await streamAndBatchMissingEmbeddings({
        payload,
        runId: input.runId,
        poolName,
        dynamicConfig,
        embeddingVersion,
        lastBulkCompletedAt,
        versionMismatch,
        hasBaseline: Boolean(baselineRun),
        addChunk: callbacks.addChunk,
      })

      if (result.totalInputs === 0) {
        // No inputs to process - mark run as succeeded
        await payload.update({
          id: input.runId,
          collection: BULK_EMBEDDINGS_RUNS_SLUG,
          data: {
            status: 'succeeded',
            totalBatches: 0,
            inputs: 0,
            succeeded: 0,
            failed: 0,
            completedAt: new Date().toISOString(),
          },
        })
        return { output: { runId: input.runId, status: 'succeeded', batchCount: 0 } }
      }

      // Update run with batch count and total inputs
      await payload.update({
        id: input.runId,
        collection: BULK_EMBEDDINGS_RUNS_SLUG,
        data: {
          status: 'running',
          totalBatches: result.batchCount,
          inputs: result.totalInputs,
          submittedAt: new Date().toISOString(),
        },
      })

      // Queue the poll task to monitor all batches
      await payload.jobs.queue<'payloadcms-vectorize:poll-or-complete-bulk-embedding'>({
        task: 'payloadcms-vectorize:poll-or-complete-bulk-embedding',
        input: { runId: input.runId },
        req,
        ...(pollOrCompleteQueueName ? { queue: pollOrCompleteQueueName } : {}),
      })

      return {
        output: { runId: input.runId, status: 'prepared', batchCount: result.batchCount },
      }
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

      const callbacks = dynamicConfig.embeddingConfig.bulkEmbeddingsFns!

      // Check if run is already terminal
      const currentStatus = (run as any).status
      if (TERMINAL_STATUSES.has(currentStatus)) {
        return { output: { runId: input.runId, status: currentStatus } }
      }

      // Load all batches for this run
      // Convert runId to number for postgres relationship queries
      const runIdNum = parseInt(input.runId, 10)
      const batchesResult = await payload.find({
        collection: BULK_EMBEDDINGS_BATCHES_SLUG,
        where: { run: { equals: runIdNum } },
        limit: 1000,
        sort: 'batchIndex',
      })
      const batches = (batchesResult as any)?.docs || []

      if (batches.length === 0) {
        // No batches found - this shouldn't happen but handle gracefully
        await payload.update({
          id: input.runId,
          collection: BULK_EMBEDDINGS_RUNS_SLUG,
          data: {
            status: 'failed',
            error: 'No batches found for run',
            completedAt: new Date().toISOString(),
          },
        })
        return { output: { runId: input.runId, status: 'failed' } }
      }

      // Poll each non-terminal batch
      let allSucceeded = true
      let anyFailed = false
      let anyRunning = false

      for (const batch of batches) {
        const batchStatus = batch.status as string
        if (TERMINAL_STATUSES.has(batchStatus)) {
          if (batchStatus !== 'succeeded') {
            anyFailed = true
            allSucceeded = false
          }
          continue
        }

        // Poll this batch
        const pollResult = await callbacks.pollBatch({
          providerBatchId: batch.providerBatchId,
        })

        // Update batch status
        await payload.update({
          id: batch.id,
          collection: BULK_EMBEDDINGS_BATCHES_SLUG,
          data: {
            status: pollResult.status,
            error: pollResult.error,
            ...(TERMINAL_STATUSES.has(pollResult.status)
              ? { completedAt: new Date().toISOString() }
              : {}),
          },
        })

        if (pollResult.status === 'failed' || pollResult.status === 'canceled') {
          anyFailed = true
          allSucceeded = false
        } else if (!TERMINAL_STATUSES.has(pollResult.status)) {
          anyRunning = true
          allSucceeded = false
        }
      }

      // If any batch failed, mark the entire run as failed
      if (anyFailed) {
        await payload.update({
          id: input.runId,
          collection: BULK_EMBEDDINGS_RUNS_SLUG,
          data: {
            status: 'failed',
            error: 'One or more batches failed',
            completedAt: new Date().toISOString(),
          },
        })
        // Cleanup metadata without writing embeddings
        await payload.delete({
          collection: BULK_EMBEDDINGS_INPUT_METADATA_SLUG,
          where: { run: { equals: (run as any).id } },
        })
        // Call onError callback so user can clean up provider-side resources
        if (callbacks.onError) {
          const providerBatchIds = batches.map((b: any) => b.providerBatchId as string)
          await callbacks.onError({
            providerBatchIds,
            error: new Error('One or more batches failed'),
          })
        }
        return { output: { runId: input.runId, status: 'failed' } }
      }

      // If still running, requeue this task
      if (anyRunning) {
        await payload.jobs.queue<'payloadcms-vectorize:poll-or-complete-bulk-embedding'>({
          task: 'payloadcms-vectorize:poll-or-complete-bulk-embedding',
          input: { runId: input.runId },
          req,
          ...(pollOrCompleteQueueName ? { queue: pollOrCompleteQueueName } : {}),
        })
        return { output: { runId: input.runId, status: 'polling' } }
      }

      // All batches succeeded - complete the embeddings atomically
      if (allSucceeded) {
        const completionResult = await completeAllBatchesAtomically({
          payload,
          runId: input.runId,
          poolName,
          batches,
          callbacks,
        })

        await payload.update({
          id: input.runId,
          collection: BULK_EMBEDDINGS_RUNS_SLUG,
          data: {
            status: completionResult.success ? 'succeeded' : 'failed',
            succeeded: completionResult.succeededCount,
            failed: completionResult.failedCount,
            error: completionResult.error,
            completedAt: new Date().toISOString(),
          },
        })

        // Cleanup metadata
        await payload.delete({
          collection: BULK_EMBEDDINGS_INPUT_METADATA_SLUG,
          where: { run: { equals: (run as any).id } },
        })

        // If completion failed, call onError so user can clean up provider resources
        if (!completionResult.success && callbacks.onError) {
          const providerBatchIds = batches.map((b: any) => b.providerBatchId as string)
          await callbacks.onError({
            providerBatchIds,
            error: new Error(completionResult.error || 'Completion failed'),
          })
        }

        return {
          output: {
            runId: input.runId,
            status: completionResult.success ? 'succeeded' : 'failed',
          },
        }
      }

      return { output: { runId: input.runId, status: 'unknown' } }
    },
  }

  return task
}

/**
 * Stream through missing embeddings, calling addChunk for each.
 * User controls batching via addChunk return value.
 */
async function streamAndBatchMissingEmbeddings(args: {
  payload: Payload
  runId: string
  poolName: KnowledgePoolName
  dynamicConfig: KnowledgePoolDynamicConfig
  embeddingVersion: string
  lastBulkCompletedAt?: string
  versionMismatch: boolean
  hasBaseline: boolean
  addChunk: (args: {
    chunk: BulkEmbeddingInput
    isLastChunk: boolean
  }) => Promise<BatchSubmission | null>
}): Promise<{ batchCount: number; totalInputs: number }> {
  const {
    payload,
    runId,
    poolName,
    dynamicConfig,
    embeddingVersion,
    lastBulkCompletedAt,
    versionMismatch,
    hasBaseline,
    addChunk,
  } = args

  const includeAll = versionMismatch || !hasBaseline
  const lastCompletedAtDate = lastBulkCompletedAt ? new Date(lastBulkCompletedAt) : undefined

  let batchIndex = 0
  let totalInputs = 0
  const collectionSlugs = Object.keys(dynamicConfig.collections)

  // Collect all chunks first to know which is the last one
  const allChunks: CollectedEmbeddingInput[] = []

  // Iterate through all collections and their documents
  for (const collectionSlug of collectionSlugs) {
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
        for (let idx = 0; idx < chunkData.length; idx++) {
          const chunkEntry = chunkData[idx]
          if (!chunkEntry?.chunk) continue

          const { chunk, ...extensionFields } = chunkEntry
          allChunks.push({
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
        }
      }

      page++
      if (page > totalPages) break
    }
  }

  // Track pending chunks - plugin manages this queue
  const pendingChunks: CollectedEmbeddingInput[] = []

  // Stream chunks to addChunk, tracking which is last
  for (let i = 0; i < allChunks.length; i++) {
    const collectedChunk = allChunks[i]
    const isLastChunk = i === allChunks.length - 1

    // Add to pending queue BEFORE calling addChunk
    pendingChunks.push(collectedChunk)

    const submission = await addChunk({
      chunk: { id: collectedChunk.id, text: collectedChunk.text },
      isLastChunk,
    })

    if (submission) {
      // User submitted a batch
      // - If isLastChunk: all pending chunks were submitted
      // - If not isLastChunk: all except current were submitted (current starts fresh)
      let submittedChunks: CollectedEmbeddingInput[]
      if (isLastChunk) {
        submittedChunks = pendingChunks.splice(0)
      } else {
        submittedChunks = pendingChunks.splice(0, pendingChunks.length - 1)
      }

      // Convert runId to number for postgres relationships
      const runIdNum = parseInt(runId, 10)

      // Store metadata for submitted chunks
      await Promise.all(
        submittedChunks.map((chunk) =>
          payload.create({
            collection: BULK_EMBEDDINGS_INPUT_METADATA_SLUG,
            data: {
              run: runIdNum,
              inputId: chunk.id,
              text: chunk.text,
              sourceCollection: chunk.metadata.sourceCollection,
              docId: chunk.metadata.docId,
              chunkIndex: chunk.metadata.chunkIndex,
              embeddingVersion: chunk.metadata.embeddingVersion,
              extensionFields: chunk.metadata.extensionFields,
            },
          }),
        ),
      )

      // Create batch record
      await payload.create({
        collection: BULK_EMBEDDINGS_BATCHES_SLUG,
        data: {
          run: runIdNum,
          batchIndex,
          providerBatchId: submission.providerBatchId,
          status: 'queued',
          inputCount: submittedChunks.length,
          submittedAt: new Date().toISOString(),
        },
      })

      totalInputs += submittedChunks.length
      batchIndex++
    }
  }

  return { batchCount: batchIndex, totalInputs }
}

/**
 * Complete all batches atomically - download all outputs and write all embeddings
 */
async function completeAllBatchesAtomically(args: {
  payload: Payload
  runId: string
  poolName: KnowledgePoolName
  batches: any[]
  callbacks: {
    completeBatch: (args: { providerBatchId: string }) => Promise<BulkEmbeddingOutput[]>
  }
}): Promise<{
  success: boolean
  succeededCount: number
  failedCount: number
  error?: string
}> {
  const { payload, runId, poolName, batches, callbacks } = args

  try {
    // Load all metadata for this run
    const metadataById = await loadInputMetadataByRun({ payload, runId })

    // Collect all outputs from all batches
    const allOutputs: BulkEmbeddingOutput[] = []
    for (const batch of batches) {
      const outputs = await callbacks.completeBatch({
        providerBatchId: batch.providerBatchId,
      })
      allOutputs.push(...outputs)
    }

    // Filter successful outputs
    const successfulOutputs = allOutputs.filter((o) => !o.error && o.embedding)
    const failedCount = allOutputs.length - successfulOutputs.length

    // Collect unique doc keys for deletion
    const docKeys = new Set<string>()
    for (const output of successfulOutputs) {
      const meta = metadataById.get(output.id)
      if (!meta) continue
      docKeys.add(`${meta.sourceCollection}:${meta.docId}`)
    }

    // Delete existing embeddings for docs we're about to update
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

    // Write all new embeddings
    for (const output of successfulOutputs) {
      const meta = metadataById.get(output.id)
      if (!meta || !output.embedding) continue

      const embeddingArray = Array.isArray(output.embedding)
        ? output.embedding
        : Array.from(output.embedding)

      const created = await payload.create({
        collection: poolName,
        data: {
          sourceCollection: meta.sourceCollection,
          docId: String(meta.docId),
          chunkIndex: meta.chunkIndex,
          chunkText: meta.text,
          embeddingVersion: meta.embeddingVersion,
          ...(meta.extensionFields || {}),
          embedding: embeddingArray,
        } as any,
      })

      await persistVectorColumn({
        payload,
        poolName: toSnakeCase(poolName),
        vector: embeddingArray,
        id: String((created as any)?.id ?? ''),
      })
    }

    return {
      success: true,
      succeededCount: successfulOutputs.length,
      failedCount,
    }
  } catch (error) {
    const errorMessage = (error as Error).message || String(error)
    return {
      success: false,
      succeededCount: 0,
      failedCount: 0,
      error: `Completion failed: ${errorMessage}`,
    }
  }
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
  const sql = `UPDATE "${schemaName}"."${toSnakeCase(poolName)}" SET embedding = $1 WHERE id = $2`
  const runSQL = async (statement: string, params?: any[]) => {
    if (postgresPayload.db.pool?.query) return postgresPayload.db.pool.query(statement, params)
    if (postgresPayload.db.drizzle?.execute) return postgresPayload.db.drizzle.execute(statement)
    throw new Error('[payloadcms-vectorize] Failed to persist vector column')
  }
  try {
    await runSQL(sql, [literal, id])
  } catch (e) {
    const errorMessage = (e as Error).message || (e as any).toString()
    payload.logger.error(`[payloadcms-vectorize] Failed to persist vector column: ${errorMessage}`)
    throw e
  }
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

  // Convert runId to number for postgres relationship queries
  const runIdNum = parseInt(runId, 10)

  let page = 1
  const limit = 100
  while (true) {
    const res = await payload.find({
      collection: BULK_EMBEDDINGS_INPUT_METADATA_SLUG,
      page,
      limit,
      where: { run: { equals: runIdNum } },
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
    page++
    if (page > totalPages) break
  }

  return map
}
