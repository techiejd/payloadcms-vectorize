// dev/create-alt-db.ts
import type { Payload, SanitizedConfig } from 'payload'
import { buildConfig, getPayload } from 'payload'
import { Client } from 'pg'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { createVectorizeIntegration } from 'payloadcms-vectorize'
import { BULK_EMBEDDINGS_RUNS_SLUG } from '../../src/collections/bulkEmbeddingsRuns.js'
import { BULK_EMBEDDINGS_INPUT_METADATA_SLUG } from '../../src/collections/bulkEmbeddingInputMetadata.js'
import { BULK_EMBEDDINGS_BATCHES_SLUG } from '../../src/collections/bulkEmbeddingsBatches.js'
import { makeDummyEmbedDocs } from 'helpers/embed.js'
import type {
  BulkEmbeddingsFns,
  BulkEmbeddingInput,
  BulkEmbeddingRunStatus,
} from '../../src/types.js'

export const createTestDb = async ({ dbName }: { dbName: string }) => {
  const adminUri =
    process.env.DATABASE_ADMIN_URI || 'postgresql://postgres:password@localhost:5433/postgres' // connect to 'postgres'
  const client = new Client({ connectionString: adminUri })
  await client.connect()
  const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName])
  if (exists.rowCount === 0) {
    await client.query(`CREATE DATABASE ${dbName}`)
  }
  await client.end()
}

async function waitForTasks(
  payload: Payload,
  taskSlugs: string[],
  maxWaitMs = 10000,
  intervalMs = 250,
) {
  const hasJobsCollection = (payload as any)?.config?.collections?.some(
    (c: any) => c.slug === 'payload-jobs',
  )
  if (!hasJobsCollection) return

  const startTime = Date.now()
  while (Date.now() - startTime < maxWaitMs) {
    const pending = await payload.find({
      collection: 'payload-jobs',
      where: {
        and: [{ taskSlug: { in: taskSlugs } }, { completedAt: { exists: false } }],
      },
    })
    if (pending.totalDocs === 0) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  // One last grace wait
  await new Promise((resolve) => setTimeout(resolve, 500))
}

export async function waitForVectorizationJobs(payload: Payload, maxWaitMs = 10000) {
  await waitForTasks(payload, ['payloadcms-vectorize:vectorize'], maxWaitMs)
}

export async function waitForBulkJobs(payload: Payload, maxWaitMs = 10000) {
  await waitForTasks(
    payload,
    [
      'payloadcms-vectorize:prepare-bulk-embedding',
      'payloadcms-vectorize:poll-or-complete-bulk-embedding',
    ],
    maxWaitMs,
  )
}

export const DEFAULT_DIMS = 8
export const BULK_QUEUE_NAMES = {
  prepareBulkEmbedQueueName: 'vectorize-bulk-prepare',
  pollOrCompleteQueueName: 'vectorize-bulk-poll',
}

type MockOptions = {
  statusSequence: BulkEmbeddingRunStatus[]
  partialFailure?: { failIds: string[] }
  /** Optional: flush after this many chunks (for testing multi-batch scenarios) */
  flushAfterChunks?: number
  /** Optional: callback to track onError calls for testing */
  onErrorCallback?: (args: { providerBatchIds: string[]; error: Error }) => void
}

/**
 * Creates a mock BulkEmbeddingsFns for testing the new addChunk API.
 * User controls batching - we simulate by optionally flushing after N chunks.
 */
export function createMockBulkEmbeddings(
  options: MockOptions,
  dims: number = DEFAULT_DIMS,
): BulkEmbeddingsFns {
  const { statusSequence, partialFailure, flushAfterChunks, onErrorCallback } = options
  // Accumulated chunks for current batch
  let accumulatedChunks: BulkEmbeddingInput[] = []
  let batchIndex = 0

  // Track inputs per batch (keyed by providerBatchId)
  const batchInputs = new Map<string, BulkEmbeddingInput[]>()
  // Track poll call count per batch for status sequence
  const batchPollCount = new Map<string, number>()
  const embeddings = makeDummyEmbedDocs(dims)

  return {
    addChunk: async ({ chunk, isLastChunk }) => {
      // Add current chunk to accumulator
      accumulatedChunks.push(chunk)

      // Determine if we should flush
      const shouldFlushDueToSize = flushAfterChunks && accumulatedChunks.length >= flushAfterChunks
      const shouldFlush = shouldFlushDueToSize || isLastChunk

      if (shouldFlush && accumulatedChunks.length > 0) {
        const toSubmit = [...accumulatedChunks]
        accumulatedChunks = []
        const providerBatchId = `mock-batch-${batchIndex}-${Date.now()}`
        batchInputs.set(providerBatchId, toSubmit)
        batchPollCount.set(providerBatchId, 0)
        batchIndex++
        return { providerBatchId }
      }

      return null
    },

    pollBatch: async ({ providerBatchId }) => {
      const callCount = batchPollCount.get(providerBatchId) ?? 0
      batchPollCount.set(providerBatchId, callCount + 1)
      const status = statusSequence[Math.min(callCount, statusSequence.length - 1)]
      const inputs = batchInputs.get(providerBatchId) ?? []
      const counts =
        status === 'succeeded'
          ? { inputs: inputs.length, succeeded: inputs.length, failed: 0 }
          : undefined
      return {
        status,
        counts,
      }
    },

    completeBatch: async ({ providerBatchId }) => {
      const inputs = batchInputs.get(providerBatchId) ?? []
      if (!inputs.length) {
        return []
      }
      const vectors = await embeddings(inputs.map((i) => i.text))
      const outputs = inputs.map((input, idx) => {
        const shouldFail = partialFailure?.failIds?.includes(input.id)
        return shouldFail
          ? { id: input.id, error: 'fail' }
          : { id: input.id, embedding: vectors[idx] }
      })
      // Clean up state
      batchInputs.delete(providerBatchId)
      batchPollCount.delete(providerBatchId)
      return outputs
    },

    onError: async ({ providerBatchIds, error }) => {
      // Clean up state
      for (const batchId of providerBatchIds) {
        batchInputs.delete(batchId)
        batchPollCount.delete(batchId)
      }
      accumulatedChunks = []
      batchIndex = 0

      // Call the test callback if provided
      if (onErrorCallback) {
        onErrorCallback({ providerBatchIds, error })
      }
    },
  }
}

export type BuildPayloadArgs = {
  dbName: string
  pluginOpts: any
  secret?: string
  dims?: number
  key?: string
}

export async function buildPayloadWithIntegration({
  dbName,
  pluginOpts,
  secret = 'test-secret',
  dims = DEFAULT_DIMS,
  key,
}: BuildPayloadArgs): Promise<{ payload: Payload; config: SanitizedConfig }> {
  const integration = createVectorizeIntegration({
    default: {
      dims,
      ivfflatLists: 1,
    },
  })

  const config = await buildConfig({
    secret,
    editor: lexicalEditor(),
    collections: [
      {
        slug: 'posts',
        fields: [{ name: 'title', type: 'text' }],
      },
    ],
    db: postgresAdapter({
      extensions: ['vector'],
      afterSchemaInit: [integration.afterSchemaInitHook],
      pool: {
        connectionString: `postgresql://postgres:password@localhost:5433/${dbName}`,
      },
    }),
    plugins: [integration.payloadcmsVectorize(pluginOpts)],
    jobs: {
      tasks: [],
      autoRun: [
        {
          cron: '*/2 * * * * *',
          limit: 10,
          queue: pluginOpts.bulkQueueNames?.prepareBulkEmbedQueueName,
        },
        {
          cron: '*/2 * * * * *',
          limit: 10,
          queue: pluginOpts.bulkQueueNames?.pollOrCompleteQueueName,
        },
      ],
    },
  })

  const payloadKey = key ?? `payload-${dbName}-${Date.now()}`
  const payload = await getPayload({ config, key: payloadKey, cron: true })
  return { payload, config }
}

export const clearAllCollections = async (pl: Payload) => {
  const hasCollection = (slug: string) =>
    !!(pl as any)?.config?.collections?.some((c: any) => c.slug === slug)

  const safeDelete = async (slug: string) => {
    if (!hasCollection(slug)) return
    try {
      await (pl as any).delete({
        collection: slug,
        where: { id: { exists: true } },
      })
    } catch {
      // ignore if collection not registered in this payload instance
    }
  }

  await safeDelete(BULK_EMBEDDINGS_RUNS_SLUG)
  await safeDelete(BULK_EMBEDDINGS_BATCHES_SLUG)
  await safeDelete(BULK_EMBEDDINGS_INPUT_METADATA_SLUG)
  await safeDelete('default')
  await safeDelete('posts')
  await safeDelete('payload-jobs')
}

export async function createSucceededBaselineRun(
  payload: Payload,
  {
    version,
    completedAt = new Date().toISOString(),
  }: { version?: string; completedAt?: string } = {},
) {
  return (payload as any).create({
    collection: BULK_EMBEDDINGS_RUNS_SLUG,
    data: {
      pool: 'default',
      embeddingVersion: version ?? '',
      status: 'succeeded',
      completedAt,
    },
  })
}
