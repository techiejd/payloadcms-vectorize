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
import {
  isPostgresPayload,
  PostgresPayload,
  BulkEmbeddingInput,
  FailedChunkData,
} from '../types.js'
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

      // Load all batches for this run with pagination to handle >1000 batches
      // Convert runId to number for postgres relationship queries
      const runIdNum = parseInt(input.runId, 10)
      const batches: any[] = []
      let batchPage = 1
      const batchLimit = 100 // Smaller pages for better memory management

      while (true) {
        const batchesResult = await payload.find({
          collection: BULK_EMBEDDINGS_BATCHES_SLUG,
          where: { run: { equals: runIdNum } },
          limit: batchLimit,
          page: batchPage,
          sort: 'batchIndex',
        })
        const pageDocs = (batchesResult as any)?.docs || []
        batches.push(...pageDocs)

        const totalPages = (batchesResult as any)?.totalPages ?? batchPage
        if (batchPage >= totalPages || pageDocs.length === 0) break
        batchPage++
      }

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

      // Poll each non-terminal batch and complete succeeded ones incrementally
      let anyRunning = false
      let totalSucceeded = 0
      let totalFailed = 0
      const allFailedChunkData: FailedChunkData[] = []
      const batchStatuses = new Map<string, string>() // Track batch statuses as we process

      // Initialize with current statuses
      for (const batch of batches) {
        batchStatuses.set(String(batch.id), batch.status as string)
        // Accumulate counts from already completed batches
        if (TERMINAL_STATUSES.has(batch.status as string)) {
          if (batch.status === 'succeeded') {
            totalSucceeded += batch.succeededCount || 0
            totalFailed += batch.failedCount || 0
          }
        }
      }

      for (const batch of batches) {
        const batchStatus = batchStatuses.get(String(batch.id)) as string

        // Skip batches that are already completed
        if (TERMINAL_STATUSES.has(batchStatus)) {
          continue
        }

        // Poll batch and complete if succeeded (streams embeddings via onChunk callback)
        try {
          const completionResult = await pollAndCompleteSingleBatch({
            payload,
            runId: input.runId,
            poolName,
            batch,
            callbacks,
          })

          // Update batch status and counts
          await payload.update({
            id: batch.id,
            collection: BULK_EMBEDDINGS_BATCHES_SLUG,
            data: {
              status: completionResult.status,
              error: completionResult.error,
              ...(TERMINAL_STATUSES.has(completionResult.status)
                ? { completedAt: new Date().toISOString() }
                : {}),
              ...(completionResult.status === 'succeeded'
                ? {
                    succeededCount: completionResult.succeededCount,
                    failedCount: completionResult.failedCount,
                  }
                : {}),
            },
          })

          // Track the new status
          batchStatuses.set(String(batch.id), completionResult.status)

          // Accumulate counts from newly succeeded batches
          if (completionResult.status === 'succeeded') {
            totalSucceeded += completionResult.succeededCount
            totalFailed += completionResult.failedCount
            allFailedChunkData.push(...completionResult.failedChunkData)
          }

          // Track if still running (queued or running)
          if (completionResult.status === 'queued' || completionResult.status === 'running') {
            anyRunning = true
          }
          // Failed/canceled batches - leave them, can be re-run later
        } catch (error) {
          // Completion failed - mark batch as failed
          const errorMessage = (error as Error).message || String(error)
          await payload.update({
            id: batch.id,
            collection: BULK_EMBEDDINGS_BATCHES_SLUG,
            data: {
              status: 'failed',
              error: `Completion failed: ${errorMessage}`,
              completedAt: new Date().toISOString(),
            },
          })
          batchStatuses.set(String(batch.id), 'failed')
        }
      }

      // Check if all batches are complete
      const allBatchesComplete = Array.from(batchStatuses.values()).every((status) =>
        TERMINAL_STATUSES.has(status),
      )

      if (allBatchesComplete) {
        // All batches are done - finalize the run
        const hasAnySucceeded = Array.from(batchStatuses.values()).some(
          (status) => status === 'succeeded',
        )

        // Check if any batches are failed (not just canceled) - we keep metadata for potential retries
        const hasFailedBatches = Array.from(batchStatuses.values()).some(
          (status) => status === 'failed',
        )

        await payload.update({
          id: input.runId,
          collection: BULK_EMBEDDINGS_RUNS_SLUG,
          data: {
            status: hasAnySucceeded ? 'succeeded' : 'failed',
            succeeded: totalSucceeded,
            failed: totalFailed,
            failedChunkData: allFailedChunkData.length > 0 ? allFailedChunkData : undefined,
            completedAt: new Date().toISOString(),
          },
        })

        // Cleanup metadata for succeeded batches only
        // Keep metadata for failed batches to allow retry functionality
        const succeededBatchIds = Array.from(batchStatuses.entries())
          .filter(([_, status]) => status === 'succeeded')
          .map(([id, _]) => parseInt(id, 10))

        if (succeededBatchIds.length > 0) {
          await payload.delete({
            collection: BULK_EMBEDDINGS_INPUT_METADATA_SLUG,
            where: { batch: { in: succeededBatchIds } },
          })
        }

        // Call onError if there were any failures
        if (callbacks.onError && (totalFailed > 0 || !hasAnySucceeded)) {
          const providerBatchIds = batches.map((b: any) => b.providerBatchId as string)
          await callbacks.onError({
            providerBatchIds,
            error: new Error(
              totalFailed > 0
                ? `${totalFailed} chunk(s) failed during completion`
                : 'All batches failed',
            ),
            failedChunkData: allFailedChunkData.length > 0 ? allFailedChunkData : undefined,
            failedChunkCount: totalFailed > 0 ? totalFailed : undefined,
          })
        }

        return {
          output: {
            runId: input.runId,
            status: hasAnySucceeded ? 'succeeded' : 'failed',
          },
        }
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

      // Edge case: allBatchesComplete is false but anyRunning is false
      // This happens when all batches are in 'canceled' or 'failed' status but we didn't detect it above
      // Check if all batches are canceled
      const allCanceled = Array.from(batchStatuses.values()).every(
        (status) => status === 'canceled',
      )

      if (allCanceled) {
        await payload.update({
          id: input.runId,
          collection: BULK_EMBEDDINGS_RUNS_SLUG,
          data: {
            status: 'canceled',
            completedAt: new Date().toISOString(),
          },
        })
        return { output: { runId: input.runId, status: 'canceled' } }
      }

      // Fallback: mark as failed with diagnostic info
      const statusCounts = Array.from(batchStatuses.values()).reduce(
        (acc, status) => {
          acc[status] = (acc[status] || 0) + 1
          return acc
        },
        {} as Record<string, number>,
      )
      payload.logger.warn(
        `[payloadcms-vectorize] Run ${input.runId} reached unexpected state. Batch statuses: ${JSON.stringify(statusCounts)}`,
      )

      await payload.update({
        id: input.runId,
        collection: BULK_EMBEDDINGS_RUNS_SLUG,
        data: {
          status: 'failed',
          error: `Run reached unexpected state. Batch statuses: ${JSON.stringify(statusCounts)}`,
          completedAt: new Date().toISOString(),
        },
      })
      return { output: { runId: input.runId, status: 'failed' } }
    },
  }

  return task
}

/**
 * Stream through missing embeddings, calling addChunk for each.
 * User controls batching via addChunk return value.
 *
 * Uses a two-pass approach:
 * 1. First pass: count total chunks to know when we reach the last one
 * 2. Second pass: stream chunks without holding all in memory
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
  const collectionSlugs = Object.keys(dynamicConfig.collections)

  // First pass: count total chunks to know the last one
  // We store minimal info (docId + chunkCount) to avoid OOM
  type DocChunkInfo = { collectionSlug: string; docId: string; chunkCount: number }
  const docsToProcess: DocChunkInfo[] = []
  let totalChunkCount = 0

  for (const collectionSlug of collectionSlugs) {
    const collectionConfig = dynamicConfig.collections[collectionSlug]
    if (!collectionConfig) continue

    const toKnowledgePool = collectionConfig.toKnowledgePool
    let page = 1
    const limit = 50

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
        const validChunkCount = chunkData.filter((c) => c?.chunk).length
        if (validChunkCount > 0) {
          docsToProcess.push({
            collectionSlug,
            docId: String(doc.id),
            chunkCount: validChunkCount,
          })
          totalChunkCount += validChunkCount
        }
      }

      page++
      if (page > totalPages) break
    }
  }

  // If no chunks, return early
  if (totalChunkCount === 0) {
    return { batchCount: 0, totalInputs: 0 }
  }

  // Second pass: stream chunks without holding all in memory
  let batchIndex = 0
  let totalInputs = 0
  let processedChunkCount = 0
  const pendingChunks: CollectedEmbeddingInput[] = []

  for (const docInfo of docsToProcess) {
    const collectionConfig = dynamicConfig.collections[docInfo.collectionSlug]
    if (!collectionConfig) continue

    // Re-fetch the document to get its data
    const doc = await payload.findByID({
      collection: docInfo.collectionSlug as any,
      id: docInfo.docId,
    })
    if (!doc) continue

    const toKnowledgePool = collectionConfig.toKnowledgePool
    const chunkData = await toKnowledgePool(doc, payload)

    for (let idx = 0; idx < chunkData.length; idx++) {
      const chunkEntry = chunkData[idx]
      if (!chunkEntry?.chunk) continue

      processedChunkCount++
      const isLastChunk = processedChunkCount === totalChunkCount

      const { chunk, ...extensionFields } = chunkEntry
      const collectedChunk: CollectedEmbeddingInput = {
        id: `${docInfo.collectionSlug}:${doc.id}:${idx}`,
        text: chunk,
        metadata: {
          sourceCollection: docInfo.collectionSlug,
          docId: String(doc.id),
          chunkIndex: idx,
          embeddingVersion,
          extensionFields,
        },
      }

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

        // Create batch record first so we have the batch ID for metadata
        const batchRecord = await payload.create({
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

        const batchId = (batchRecord as any).id

        // Store metadata for submitted chunks with batch reference
        await Promise.all(
          submittedChunks.map((c) =>
            payload.create({
              collection: BULK_EMBEDDINGS_INPUT_METADATA_SLUG,
              data: {
                run: runIdNum,
                batch: batchId,
                inputId: c.id,
                text: c.text,
                sourceCollection: c.metadata.sourceCollection,
                docId: c.metadata.docId,
                chunkIndex: c.metadata.chunkIndex,
                embeddingVersion: c.metadata.embeddingVersion,
                extensionFields: c.metadata.extensionFields,
              },
            }),
          ),
        )

        totalInputs += submittedChunks.length
        batchIndex++
      }
    }
  }

  return { batchCount: batchIndex, totalInputs }
}

/**
 * Check if a source document exists
 */
async function documentExists(args: {
  payload: Payload
  collection: string
  docId: string
}): Promise<boolean> {
  const { payload, collection, docId } = args
  try {
    await payload.findByID({
      collection: collection as any,
      id: docId,
    })
    return true
  } catch (error) {
    // Document not found or other error
    return false
  }
}

/**
 * Poll a single batch and complete if succeeded - stream outputs and write embeddings incrementally.
 * Checks document existence before writing each embedding (skips deleted docs).
 * Returns both the batch status and completion counts.
 */
async function pollAndCompleteSingleBatch(args: {
  payload: Payload
  runId: string
  poolName: KnowledgePoolName
  batch: any
  callbacks: {
    pollOrCompleteBatch: (args: {
      providerBatchId: string
      onChunk: (chunk: BulkEmbeddingOutput) => Promise<void>
    }) => Promise<{ status: string; error?: string }>
  }
}): Promise<{
  status: string
  error?: string
  succeededCount: number
  failedCount: number
  failedChunkData: FailedChunkData[]
}> {
  const { payload, runId, poolName, batch, callbacks } = args

  let succeededCount = 0
  let failedCount = 0
  const failedChunkData: FailedChunkData[] = []
  const processedDocs = new Set<string>() // Track which docs we've processed (for deletion)

  // Poll batch and stream chunks when complete
  const pollResult = await callbacks.pollOrCompleteBatch({
    providerBatchId: batch.providerBatchId,
    onChunk: async (output: BulkEmbeddingOutput) => {
      // Lookup metadata on-demand (O(1) with index) instead of loading all into memory
      const meta = await getMetadataByInputId({
        payload,
        runId,
        inputId: output.id,
      })
      if (!meta) {
        // Metadata not found - log and skip this chunk (may have been deleted or cleanup ran)
        payload.logger.warn(
          `[payloadcms-vectorize] Metadata not found for chunk ${output.id} in run ${runId}. Skipping chunk.`,
        )
        failedCount++
        return
      }

      // Check if document still exists (may have been deleted during bulk embedding)
      const docExists = await documentExists({
        payload,
        collection: meta.sourceCollection,
        docId: meta.docId,
      })

      if (!docExists) {
        // Document was deleted - skip this chunk and clean up metadata
        await payload.delete({
          collection: BULK_EMBEDDINGS_INPUT_METADATA_SLUG,
          where: {
            and: [{ run: { equals: parseInt(runId, 10) } }, { inputId: { equals: output.id } }],
          },
        })
        failedCount++
        failedChunkData.push({
          collection: meta.sourceCollection,
          documentId: meta.docId,
          chunkIndex: meta.chunkIndex,
        })
        return
      }

      // Handle errors from provider
      if (output.error || !output.embedding) {
        failedCount++
        failedChunkData.push({
          collection: meta.sourceCollection,
          documentId: meta.docId,
          chunkIndex: meta.chunkIndex,
        })
        return
      }

      // Track this doc for potential deletion of old embeddings
      const docKey = `${meta.sourceCollection}:${meta.docId}`
      const isFirstChunkForDoc = !processedDocs.has(docKey)

      if (isFirstChunkForDoc) {
        processedDocs.add(docKey)
        // Check if embeddings already exist for this document+version (from a previous batch)
        const hasCurrentEmbedding = await docHasEmbeddingVersion({
          payload,
          poolName,
          sourceCollection: meta.sourceCollection,
          docId: meta.docId,
          embeddingVersion: meta.embeddingVersion,
        })

        // Only delete if no embeddings exist for this version (they're from an old version)
        if (!hasCurrentEmbedding) {
          // Delete existing embeddings for this document (from old version)
          await payload.delete({
            collection: poolName,
            where: {
              and: [
                { sourceCollection: { equals: meta.sourceCollection } },
                { docId: { equals: String(meta.docId) } },
              ],
            },
          })
        }
      }

      // Write the embedding
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

      succeededCount++
    },
  })

  return {
    status: pollResult.status,
    error: pollResult.error,
    succeededCount,
    failedCount,
    failedChunkData,
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

/**
 * Lookup metadata for a single input by runId + inputId.
 * Uses the composite index ['run', 'inputId'] for O(1) lookup.
 * This approach uses constant memory instead of loading all metadata into memory.
 */
async function getMetadataByInputId(args: {
  payload: Payload
  runId: string
  inputId: string
}): Promise<{
  text: string
  sourceCollection: string
  docId: string
  chunkIndex: number
  embeddingVersion: string
  extensionFields?: Record<string, any>
} | null> {
  const { payload, runId, inputId } = args
  const runIdNum = parseInt(runId, 10)

  const result = await payload.find({
    collection: BULK_EMBEDDINGS_INPUT_METADATA_SLUG,
    where: {
      and: [{ run: { equals: runIdNum } }, { inputId: { equals: inputId } }],
    },
    limit: 1,
  })

  const doc = (result as any)?.docs?.[0]
  if (!doc) return null

  return {
    text: doc.text,
    sourceCollection: doc.sourceCollection,
    docId: String(doc.docId),
    chunkIndex: doc.chunkIndex,
    embeddingVersion: doc.embeddingVersion,
    extensionFields: doc.extensionFields || undefined,
  }
}
