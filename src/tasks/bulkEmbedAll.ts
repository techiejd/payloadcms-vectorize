import {
  CollectionSlug,
  JsonObject,
  Payload,
  TaskConfig,
  TaskHandlerResult,
  TypeWithID,
} from 'payload'
import {
  BatchSubmission,
  BulkEmbeddingOutput,
  BulkEmbeddingRunDoc,
  BulkEmbeddingBatchDoc,
  BulkEmbeddingInputMetadataDoc,
  CollectedEmbeddingInput,
  CollectionVectorizeOption,
  KnowledgePoolDynamicConfig,
  KnowledgePoolName,
  BulkEmbeddingInput,
  DbAdapter,
  FailedChunkData,
} from '../types.js'
import { BULK_EMBEDDINGS_RUNS_SLUG } from '../collections/bulkEmbeddingsRuns.js'
import { BULK_EMBEDDINGS_INPUT_METADATA_SLUG } from '../collections/bulkEmbeddingInputMetadata.js'
import { BULK_EMBEDDINGS_BATCHES_SLUG } from '../collections/bulkEmbeddingsBatches.js'
import {
  TASK_SLUG_PREPARE_BULK_EMBEDDING,
  TASK_SLUG_POLL_OR_COMPLETE_BULK_EMBEDDING,
} from '../constants.js'
import { validateChunkData } from '../utils/validateChunkData.js'
import { deleteDocumentEmbeddings } from '../utils/deleteDocumentEmbeddings.js'

type PrepareBulkEmbeddingTaskInput = {
  runId: string
  /** If set, this is a per-collection worker job */
  collectionSlug?: string
  /** Page within the collection (default: 1) */
  page?: number
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

type PollOrCompleteSingleBatchTaskInput = {
  runId: string
  batchId: string
}

type PollOrCompleteSingleBatchTaskOutput = {
  runId: string
  batchId: string
  status: string
}

type PollOrCompleteSingleBatchTaskInputOutput = {
  input: PollOrCompleteSingleBatchTaskInput
  output: PollOrCompleteSingleBatchTaskOutput
}

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'canceled', 'retried'])

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
  const run = (await payload.findByID({
    collection: BULK_EMBEDDINGS_RUNS_SLUG,
    id: runId,
  })) as BulkEmbeddingRunDoc
  const poolName = run.pool as KnowledgePoolName
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

/**
 * Check if all batches for a run are terminal, and if so finalize the run.
 * This function is idempotent - safe to call concurrently from multiple per-batch tasks.
 */
async function finalizeRunIfComplete(args: {
  payload: Payload
  runId: string
  poolName: KnowledgePoolName
  callbacks: {
    onError?: (args: {
      providerBatchIds: string[]
      error: Error
      failedChunkData?: FailedChunkData[]
      failedChunkCount?: number
    }) => Promise<void>
  }
}): Promise<{ finalized: boolean; status?: string }> {
  const { payload, runId, poolName, callbacks } = args

  // Check if run is already terminal (prevents double-finalization race)
  const currentRun = await payload.findByID({
    collection: BULK_EMBEDDINGS_RUNS_SLUG,
    id: runId,
  })
  if (TERMINAL_STATUSES.has((currentRun as any).status)) {
    return { finalized: true, status: (currentRun as any).status }
  }

  // Stream through batches page-by-page, aggregating without storing them all in memory
  const runIdNum = parseInt(runId, 10)
  const PAGE_SIZE = 100
  let page = 1
  let totalBatchCount = 0
  let allTerminal = true
  let hasAnySucceeded = false
  let allCanceled = true
  let totalSucceeded = 0
  let totalFailed = 0
  const allFailedChunkData: FailedChunkData[] = []
  const succeededBatchIds: number[] = []
  const providerBatchIds: string[] = []

  while (true) {
    const result = await payload.find({
      collection: BULK_EMBEDDINGS_BATCHES_SLUG,
      where: { run: { equals: runIdNum } },
      limit: PAGE_SIZE,
      page,
      sort: 'batchIndex',
    })
    const docs = (result as any)?.docs || []

    for (const batch of docs) {
      totalBatchCount++
      const status = batch.status as string
      providerBatchIds.push(batch.providerBatchId as string)

      if (!TERMINAL_STATUSES.has(status)) allTerminal = false
      if (status === 'succeeded') hasAnySucceeded = true
      if (status !== 'canceled') allCanceled = false

      if (status === 'succeeded') {
        totalSucceeded += batch.succeededCount || 0
        totalFailed += batch.failedCount || 0
        succeededBatchIds.push(parseInt(String(batch.id), 10))
        if (Array.isArray(batch.failedChunkData)) {
          allFailedChunkData.push(...batch.failedChunkData)
        }
      }
    }

    const totalPages = (result as any)?.totalPages ?? page
    if (page >= totalPages || docs.length === 0) break
    page++
  }

  if (totalBatchCount === 0) {
    await payload.update({
      id: runId,
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      data: {
        status: 'succeeded',
        inputs: 0,
        succeeded: 0,
        failed: 0,
        completedAt: new Date().toISOString(),
      },
    })
    return { finalized: true, status: 'succeeded' }
  }

  if (!allTerminal) {
    return { finalized: false }
  }

  // All batches are terminal — finalize the run
  if (allCanceled) {
    await payload.update({
      id: runId,
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      data: { status: 'canceled', completedAt: new Date().toISOString() },
    })
    return { finalized: true, status: 'canceled' }
  }

  const runStatus = hasAnySucceeded ? 'succeeded' : 'failed'

  await payload.update({
    id: runId,
    collection: BULK_EMBEDDINGS_RUNS_SLUG,
    data: {
      status: runStatus,
      succeeded: totalSucceeded,
      failed: totalFailed,
      failedChunkData: allFailedChunkData.length > 0 ? allFailedChunkData : undefined,
      completedAt: new Date().toISOString(),
    },
  })

  // Cleanup metadata for succeeded batches only
  if (succeededBatchIds.length > 0) {
    await payload.delete({
      collection: BULK_EMBEDDINGS_INPUT_METADATA_SLUG,
      where: { batch: { in: succeededBatchIds } },
    })
  }

  // Call onError if there were any failures
  if (callbacks.onError && (totalFailed > 0 || !hasAnySucceeded)) {
    await callbacks.onError({
      providerBatchIds,
      error: new Error(
        totalFailed > 0 ? `${totalFailed} chunk(s) failed during completion` : 'All batches failed',
      ),
      failedChunkData: allFailedChunkData.length > 0 ? allFailedChunkData : undefined,
      failedChunkCount: totalFailed > 0 ? totalFailed : undefined,
    })
  }

  return { finalized: true, status: runStatus }
}

export const createPrepareBulkEmbeddingTask = ({
  knowledgePools,
  pollOrCompleteQueueName,
  prepareBulkEmbedQueueName,
}: {
  knowledgePools: Record<KnowledgePoolName, KnowledgePoolDynamicConfig>
  pollOrCompleteQueueName?: string
  prepareBulkEmbedQueueName?: string
}): TaskConfig<PrepareBulkEmbeddingTaskInputOutput> => {
  const task: TaskConfig<PrepareBulkEmbeddingTaskInputOutput> = {
    slug: TASK_SLUG_PREPARE_BULK_EMBEDDING,
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

      // =============================================
      // COORDINATOR MODE: no collectionSlug in input
      // =============================================
      if (!input.collectionSlug) {
        // Queue one worker per collection
        const collectionSlugs = Object.keys(dynamicConfig.collections)
        if (collectionSlugs.length === 0) {
          // No collections configured - mark run as succeeded
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

        for (const collectionSlug of collectionSlugs) {
          await payload.jobs.queue<'payloadcms-vectorize:prepare-bulk-embedding'>({
            task: 'payloadcms-vectorize:prepare-bulk-embedding',
            input: { runId: input.runId, collectionSlug, page: 1 },
            req,
            ...(prepareBulkEmbedQueueName ? { queue: prepareBulkEmbedQueueName } : {}),
          })
        }

        // Update run status
        await payload.update({
          id: input.runId,
          collection: BULK_EMBEDDINGS_RUNS_SLUG,
          data: {
            status: 'running',
            submittedAt: new Date().toISOString(),
          },
        })

        return { output: { runId: input.runId, status: 'coordinated' } }
      }

      // =============================================
      // WORKER MODE: collectionSlug is set
      // =============================================

      // Early exit if run is already terminal
      if (TERMINAL_STATUSES.has((run as any).status)) {
        return { output: { runId: input.runId, status: (run as any).status } }
      }

      const collectionSlug = input.collectionSlug
      const collectionConfig = dynamicConfig.collections[collectionSlug]
      if (!collectionConfig) {
        throw new Error(
          `[payloadcms-vectorize] collection "${collectionSlug}" not found in pool "${poolName}"`,
        )
      }

      const DEFAULT_BATCH_LIMIT = 1000
      const batchLimit =
        collectionConfig.batchLimit && collectionConfig.batchLimit > 0
          ? collectionConfig.batchLimit
          : DEFAULT_BATCH_LIMIT
      const page = input.page ?? 1

      // Compute baseline/version for filtering
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

      const baselineRun = latestSucceededRun.docs?.[0] as BulkEmbeddingRunDoc | undefined
      const baselineVersion: string | undefined = baselineRun?.embeddingVersion
      const lastBulkCompletedAt: string | undefined = baselineRun?.completedAt
      const versionMismatch = baselineVersion !== undefined && baselineVersion !== embeddingVersion
      const includeAll = versionMismatch || !baselineRun
      const lastCompletedAtDate = lastBulkCompletedAt ? new Date(lastBulkCompletedAt) : undefined

      // Build where clause for this collection
      const where = includeAll
        ? undefined
        : lastCompletedAtDate
          ? { updatedAt: { greater_than: lastCompletedAtDate.toISOString() } }
          : undefined

      // STEP 1: Query the page
      const queryResult = await payload.find({
        collection: collectionSlug,
        where,
        limit: batchLimit,
        page,
        sort: 'id',
      })

      // STEP 2: If there's a next page, queue continuation BEFORE processing
      if (queryResult.nextPage) {
        await payload.jobs.queue<'payloadcms-vectorize:prepare-bulk-embedding'>({
          task: 'payloadcms-vectorize:prepare-bulk-embedding',
          input: { runId: input.runId, collectionSlug, page: queryResult.nextPage },
          req,
          ...(prepareBulkEmbedQueueName ? { queue: prepareBulkEmbedQueueName } : {}),
        })
      }

      // STEP 3: Process this page's docs
      let totalResult: { batchCount: number; totalInputs: number; batchIds: (string | number)[] }
      try {
        totalResult = await streamAndBatchDocs({
          payload,
          runId: input.runId,
          poolName,
          collectionSlug,
          collectionConfig,
          docs: (queryResult.docs || []) as Array<JsonObject & TypeWithID>,
          embeddingVersion,
          includeAll,
          lastCompletedAtDate,
          addChunk: callbacks.addChunk,
        })
      } catch (error) {
        // Ingestion failed - mark run as failed
        const errorMessage = (error as Error).message || String(error)
        await payload.update({
          id: input.runId,
          collection: BULK_EMBEDDINGS_RUNS_SLUG,
          data: {
            status: 'failed',
            error: errorMessage,
            completedAt: new Date().toISOString(),
          },
        })
        throw error
      }

      // STEP 4: Accumulate counts on run record
      if (totalResult.totalInputs > 0) {
        const currentRun = await payload.findByID({
          collection: BULK_EMBEDDINGS_RUNS_SLUG,
          id: input.runId,
        })
        const existingInputs = (currentRun as any).inputs ?? 0
        const existingBatches = (currentRun as any).totalBatches ?? 0
        await payload.update({
          id: input.runId,
          collection: BULK_EMBEDDINGS_RUNS_SLUG,
          data: {
            totalBatches: existingBatches + totalResult.batchCount,
            inputs: existingInputs + totalResult.totalInputs,
          },
        })
      }

      // STEP 5: Queue per-batch polling tasks
      for (const batchId of totalResult.batchIds) {
        await payload.jobs.queue<typeof TASK_SLUG_POLL_OR_COMPLETE_BULK_EMBEDDING>({
          task: TASK_SLUG_POLL_OR_COMPLETE_BULK_EMBEDDING,
          input: { runId: input.runId, batchId: String(batchId) },
          req,
          ...(pollOrCompleteQueueName ? { queue: pollOrCompleteQueueName } : {}),
        })
      }

      // If this worker produced 0 batches and has no continuation, try to finalize.
      // finalizeRunIfComplete is idempotent: if other workers created batches that
      // aren't terminal yet, it returns { finalized: false } and the polling tasks
      // will handle finalization later.
      if (totalResult.batchCount === 0 && !queryResult.nextPage) {
        await finalizeRunIfComplete({ payload, runId: input.runId, poolName, callbacks })
      }

      return {
        output: { runId: input.runId, status: 'prepared', batchCount: totalResult.batchCount },
      }
    },
  }

  return task
}

export const createPollOrCompleteSingleBatchTask = ({
  knowledgePools,
  pollOrCompleteQueueName,
  adapter,
}: {
  knowledgePools: Record<KnowledgePoolName, KnowledgePoolDynamicConfig>
  pollOrCompleteQueueName?: string
  adapter: DbAdapter
}): TaskConfig<PollOrCompleteSingleBatchTaskInputOutput> => {
  const task: TaskConfig<PollOrCompleteSingleBatchTaskInputOutput> = {
    slug: TASK_SLUG_POLL_OR_COMPLETE_BULK_EMBEDDING,
    handler: async ({
      input,
      req,
    }): Promise<TaskHandlerResult<PollOrCompleteSingleBatchTaskInputOutput>> => {
      if (!input?.runId || !input?.batchId) {
        throw new Error('[payloadcms-vectorize] single batch task requires runId and batchId')
      }
      const { runId, batchId } = input
      const payload = req.payload
      const { run, poolName, dynamicConfig } = await loadRunAndConfig({
        payload,
        runId,
        knowledgePools,
      })

      const callbacks = dynamicConfig.embeddingConfig.bulkEmbeddingsFns!

      // Early exit if run is already terminal
      if (TERMINAL_STATUSES.has(run.status)) {
        return { output: { runId, batchId, status: run.status } }
      }

      // Load this specific batch
      const batch = (await payload.findByID({
        collection: BULK_EMBEDDINGS_BATCHES_SLUG,
        id: batchId,
      })) as BulkEmbeddingBatchDoc

      // If batch is already terminal, just check if run can be finalized
      if (TERMINAL_STATUSES.has((batch as any).status)) {
        await finalizeRunIfComplete({ payload, runId, poolName, callbacks })
        return { output: { runId, batchId, status: (batch as any).status } }
      }

      // Poll and complete this single batch
      try {
        const completionResult = await pollAndCompleteSingleBatch({
          payload,
          runId,
          poolName,
          batch,
          callbacks,
          adapter,
        })

        // Update batch status and counts
        await payload.update({
          id: batchId,
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
                  failedChunkData:
                    completionResult.failedChunkData.length > 0
                      ? completionResult.failedChunkData
                      : undefined,
                }
              : {}),
          },
        })

        // If batch is now terminal, check if run should be finalized
        if (TERMINAL_STATUSES.has(completionResult.status)) {
          await finalizeRunIfComplete({ payload, runId, poolName, callbacks })
          return { output: { runId, batchId, status: completionResult.status } }
        }

        // Still running - re-queue self with polling delay
        await payload.jobs.queue<typeof TASK_SLUG_POLL_OR_COMPLETE_BULK_EMBEDDING>({
          task: TASK_SLUG_POLL_OR_COMPLETE_BULK_EMBEDDING,
          input: { runId, batchId },
          req,
          ...(pollOrCompleteQueueName ? { queue: pollOrCompleteQueueName } : {}),
        })

        return { output: { runId, batchId, status: completionResult.status } }
      } catch (error) {
        // Batch processing failed - mark batch as failed
        const errorMessage = (error as Error).message || String(error)
        await payload.update({
          id: batchId,
          collection: BULK_EMBEDDINGS_BATCHES_SLUG,
          data: {
            status: 'failed',
            error: `Completion failed: ${errorMessage}`,
            completedAt: new Date().toISOString(),
          },
        })
        // Check if this was the last batch to complete
        await finalizeRunIfComplete({ payload, runId, poolName, callbacks })
        return { output: { runId, batchId, status: 'failed' } }
      }
    },
  }

  return task
}

/**
 * Process pre-fetched docs from a single collection, calling addChunk for each chunk.
 * User controls batching via addChunk return value.
 *
 * Single-pass approach using async generator to yield chunks sequentially.
 * This avoids the need for a pre-counting pass while correctly determining isLastChunk.
 */
async function streamAndBatchDocs(args: {
  payload: Payload
  runId: string
  poolName: KnowledgePoolName
  collectionSlug: string
  collectionConfig: CollectionVectorizeOption
  docs: Array<JsonObject & TypeWithID>
  embeddingVersion: string
  includeAll: boolean
  lastCompletedAtDate?: Date
  addChunk: (args: {
    chunk: BulkEmbeddingInput
    isLastChunk: boolean
  }) => Promise<BatchSubmission | null>
}): Promise<{ batchCount: number; totalInputs: number; batchIds: (string | number)[] }> {
  const {
    payload,
    runId,
    poolName,
    collectionSlug,
    collectionConfig,
    docs,
    embeddingVersion,
    includeAll,
    lastCompletedAtDate,
    addChunk,
  } = args

  // Async generator that yields chunks one at a time from pre-fetched docs
  async function* generateChunks(): AsyncGenerator<CollectedEmbeddingInput, void, unknown> {
    const toKnowledgePool = collectionConfig.toKnowledgePool

    for (const doc of docs) {
      // If !includeAll, we still need to check if document has current embedding
      // (can't filter this in the where clause since it's a cross-collection check)
      if (!includeAll && !lastCompletedAtDate) {
        const hasCurrentEmbedding = await docHasEmbeddingVersion({
          payload,
          poolName,
          sourceCollection: collectionSlug,
          docId: String(doc.id),
          embeddingVersion,
        })
        if (hasCurrentEmbedding) continue
      }

      // Check if document should be embedded
      if (collectionConfig.shouldEmbedFn) {
        const shouldEmbed = await collectionConfig.shouldEmbedFn(doc, payload)
        if (!shouldEmbed) continue
      }

      const chunkData = await toKnowledgePool(doc, payload)

      validateChunkData(chunkData, String(doc.id), collectionSlug)

      // Yield valid chunks
      for (let idx = 0; idx < chunkData.length; idx++) {
        const chunkEntry = chunkData[idx]
        const { chunk, ...extensionFields } = chunkEntry

        yield {
          id: `${collectionSlug}:${doc.id}:${idx}`,
          text: chunk,
          metadata: {
            sourceCollection: collectionSlug,
            docId: String(doc.id),
            chunkIndex: idx,
            embeddingVersion,
            extensionFields,
          },
        }
      }
    }
  }

  // Determine starting batchIndex from existing batches for this run
  const runIdNum = parseInt(runId, 10)
  const maxBatchResult = await payload.find({
    collection: BULK_EMBEDDINGS_BATCHES_SLUG,
    where: { run: { equals: runIdNum } },
    sort: '-batchIndex',
    limit: 1,
  })
  let batchIndex =
    maxBatchResult.docs.length > 0 ? ((maxBatchResult.docs[0] as any).batchIndex ?? 0) + 1 : 0

  // Process chunks from generator
  let totalInputs = 0
  const pendingChunks: CollectedEmbeddingInput[] = []
  const chunkIterator = generateChunks()
  let currentBatchId: number | undefined = undefined
  const batchIds: (string | number)[] = []

  async function processChunk(
    chunk: CollectedEmbeddingInput,
    isLastChunk: boolean = false,
  ): Promise<void> {
    // Add to pending queue BEFORE calling addChunk
    pendingChunks.push(chunk)

    // If this is the first chunk in a new batch, create a placeholder batch record
    if (pendingChunks.length === 1) {
      // Starting a new batch - create placeholder batch record
      const placeholderBatch = await payload.create({
        collection: BULK_EMBEDDINGS_BATCHES_SLUG,
        data: {
          run: runIdNum,
          batchIndex,
          providerBatchId: `placeholder-${runId}-${batchIndex}`, // Temporary, will be updated
          status: 'queued',
          inputCount: 0, // Will be updated after submission
          submittedAt: new Date().toISOString(),
        },
      })
      currentBatchId = placeholderBatch.id as number
    }

    if (!currentBatchId) {
      throw new Error(
        `[payloadcms-vectorize] Failed to get batch ID for chunk ${chunk.id} in run ${runId}`,
      )
    }

    // Save metadata with the batch ID
    await payload.create({
      collection: BULK_EMBEDDINGS_INPUT_METADATA_SLUG,
      data: {
        run: runIdNum,
        batch: currentBatchId,
        inputId: chunk.id,
        text: chunk.text,
        sourceCollection: chunk.metadata.sourceCollection,
        docId: chunk.metadata.docId,
        chunkIndex: chunk.metadata.chunkIndex,
        embeddingVersion: chunk.metadata.embeddingVersion,
        extensionFields: chunk.metadata.extensionFields,
      },
    })

    const submission = await addChunk({
      chunk: { id: chunk.id, text: chunk.text },
      isLastChunk,
    })

    if (submission) {
      // When addChunk returns a submission, all chunks in pendingChunks were submitted
      // (the provider controls which chunks get submitted)
      const submittedChunks = pendingChunks.splice(0)
      const inputCount = submittedChunks.length

      // Update the batch record with the real providerBatchId and inputCount
      await payload.update({
        id: currentBatchId,
        collection: BULK_EMBEDDINGS_BATCHES_SLUG,
        data: {
          providerBatchId: submission.providerBatchId,
          inputCount,
        },
      })

      totalInputs += inputCount
      batchIds.push(currentBatchId)
      batchIndex++
      currentBatchId = undefined // Reset for next batch
    }
  }

  // Process chunks from generator using look-ahead for isLastChunk
  let prevChunk: CollectedEmbeddingInput | undefined = undefined
  for await (const currentChunk of chunkIterator) {
    if (prevChunk) {
      await processChunk(prevChunk)
    }
    prevChunk = currentChunk
  }
  if (prevChunk) {
    await processChunk(prevChunk, true)
  }

  return { batchCount: batchIds.length, totalInputs, batchIds }
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
      collection: collection as CollectionSlug,
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
  batch: BulkEmbeddingBatchDoc
  callbacks: {
    pollOrCompleteBatch: (args: {
      providerBatchId: string
      onChunk: (chunk: BulkEmbeddingOutput) => Promise<void>
    }) => Promise<{ status: string; error?: string }>
  }
  adapter: DbAdapter
}): Promise<{
  status: string
  error?: string
  succeededCount: number
  failedCount: number
  failedChunkData: FailedChunkData[]
}> {
  const { payload, runId, poolName, batch, callbacks, adapter } = args

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
          await deleteDocumentEmbeddings({
            payload,
            poolName,
            collection: meta.sourceCollection,
            docId: String(meta.docId),
            adapter,
          })
        }
      }

      // Write the embedding
      const embeddingArray = Array.isArray(output.embedding)
        ? output.embedding
        : Array.from(output.embedding)

      const created = await payload.create({
        collection: poolName as CollectionSlug,
        data: {
          sourceCollection: meta.sourceCollection,
          docId: String(meta.docId),
          chunkIndex: meta.chunkIndex,
          chunkText: meta.text,
          embeddingVersion: meta.embeddingVersion,
          ...(meta.extensionFields || {}),
          embedding: embeddingArray,
        },
      })

      await adapter.storeEmbedding(
        payload,
        poolName,
        meta.sourceCollection,
        String(meta.docId),
        String(created.id),
        embeddingArray,
      )

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

async function docHasEmbeddingVersion(args: {
  payload: Payload
  poolName: KnowledgePoolName
  sourceCollection: string
  docId: string
  embeddingVersion: string
}): Promise<boolean> {
  const { payload, poolName, sourceCollection, docId, embeddingVersion } = args
  const existing = await payload.find({
    collection: poolName as CollectionSlug,
    where: {
      and: [
        { sourceCollection: { equals: sourceCollection } },
        { docId: { equals: String(docId) } },
        { embeddingVersion: { equals: embeddingVersion } },
      ],
    },
    limit: 1,
  })
  return existing.totalDocs > 0
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
  extensionFields?: Record<string, unknown>
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

  const doc = result.docs?.[0] as BulkEmbeddingInputMetadataDoc | undefined
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
