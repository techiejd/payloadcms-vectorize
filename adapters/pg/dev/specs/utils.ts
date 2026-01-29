// dev/create-alt-db.ts
import type { Payload, SanitizedConfig } from 'payload'
import { buildConfig, getPayload } from 'payload'
import { Client } from 'pg'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { createVectorizeIntegration } from 'payloadcms-vectorize'
import { BULK_EMBEDDINGS_RUNS_SLUG } from '../../src/collections/bulkEmbeddingsRuns.js'
import { BULK_EMBEDDINGS_INPUT_METADATA_SLUG } from '../../src/collections/bulkEmbeddingInputMetadata.js'
import { BULK_EMBEDDINGS_BATCHES_SLUG } from '../../src/collections/bulkEmbeddingsBatches.js'
import { makeDummyEmbedDocs } from '../helpers/embed.js'
import { script as vectorizeMigrateScript } from '../../src/bin/vectorize-migrate.js'
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
  
  /*
  // Drop and recreate the database to ensure a clean state
  // First, terminate any existing connections to the database
  await client.query(`
    SELECT pg_terminate_backend(pg_stat_activity.pid)
    FROM pg_stat_activity
    WHERE pg_stat_activity.datname = $1
      AND pid <> pg_backend_pid()
  `, [dbName])*/
  
  const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName])
  if (exists.rowCount === 0) {
    await client.query(`CREATE DATABASE ${dbName}`)
    //await client.query(`DROP DATABASE "${dbName}"`)
  }
  //await client.query(`DROP DATABASE "${dbName}"`)
  await client.end()
}

/**
 * Initialize Payload with migrations applied.
 * This handles the full migration setup:
 * 1. Get payload instance
 * 2. Create initial migration
 * 3. Run vectorize:migrate to patch with IVFFLAT index
 * 4. Apply migrations
 *
 * NOTE: This function is only used by migration-specific tests (e.g., migrationCli.spec.ts).
 * All other tests should use getPayload() directly without migrations.
 *
 * @param config - A pre-built SanitizedConfig (must have migrationDir and push: false in db config)
 * @param key - Unique key for getPayload caching (prevents instance collisions in tests)
 * @param cron - Whether to enable cron jobs (default: true)
 */
export async function initializePayloadWithMigrations({
  config,
  key,
  cron = true,
  skipMigrations = false,
}: {
  config: SanitizedConfig
  key?: string
  cron?: boolean
  skipMigrations?: boolean
}): Promise<Payload> {
  if (skipMigrations) {
    return await getPayload({ config, key, cron })
  }

  const migrationKey = `${key ?? 'payload'}-migrations-${Date.now()}`
  const payloadForMigrations = await getPayload({ config, key: migrationKey, cron: false })

  // Create initial migration (Payload's schema)
  await payloadForMigrations.db.createMigration({ migrationName: 'initial', payload: payloadForMigrations })

  // Run vectorize:migrate to patch with IVFFLAT index
  await vectorizeMigrateScript(config)

  // Apply migrations (forceAcceptWarning bypasses the dev mode prompt)
  await (payloadForMigrations.db as any).migrate({ forceAcceptWarning: true })

  if (!cron) {
    return payloadForMigrations
  }

  return await getPayload({ config, key, cron: true })
}

/**
 * Create a unique migration directory for a test.
 * Returns the path and a cleanup function.
 */
export function createTestMigrationsDir(dbName: string): {
  migrationsDir: string
  cleanup: () => void
} {
  const migrationsDir = join(process.cwd(), 'dev', `test-migrations-${dbName}`)
  // Clean up any existing migration directory
  rmSync(migrationsDir, { recursive: true, force: true })
  mkdirSync(migrationsDir, { recursive: true })

  return {
    migrationsDir,
    cleanup: () => rmSync(migrationsDir, { recursive: true, force: true }),
  }
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
  /** Static list of IDs to fail, OR a function to decide at runtime */
  partialFailure?: { failIds: string[] } | { shouldFail: (id: string) => boolean }
  /** Optional: flush after this many chunks (for testing multi-batch scenarios) */
  flushAfterChunks?: number
  /** Optional: callback to track onError calls for testing */
  onErrorCallback?: (args: {
    providerBatchIds: string[]
    error: Error
    failedChunkData?: Array<{ collection: string; documentId: string; chunkIndex: number }>
    failedChunkCount?: number
  }) => void
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

    pollOrCompleteBatch: async ({ providerBatchId, onChunk }) => {
      const callCount = batchPollCount.get(providerBatchId) ?? 0
      batchPollCount.set(providerBatchId, callCount + 1)
      const status = statusSequence[Math.min(callCount, statusSequence.length - 1)]

      // If succeeded, stream the outputs via onChunk
      if (status === 'succeeded') {
        const inputs = batchInputs.get(providerBatchId) ?? []
        if (inputs.length) {
          const vectors = await embeddings(inputs.map((i) => i.text))
          for (let idx = 0; idx < inputs.length; idx++) {
            const input = inputs[idx]
            // Support both static array and function-based failure check
            const shouldFail = partialFailure
              ? 'shouldFail' in partialFailure
                ? partialFailure.shouldFail(input.id)
                : partialFailure.failIds?.includes(input.id)
              : false
            const output = shouldFail
              ? { id: input.id, error: 'fail' }
              : { id: input.id, embedding: vectors[idx] }
            await onChunk(output)
          }
        }
        // Clean up state
        batchInputs.delete(providerBatchId)
        batchPollCount.delete(providerBatchId)
      }

      return { status }
    },

    onError: async ({ providerBatchIds, error, failedChunkData, failedChunkCount }) => {
      // Clean up state
      for (const batchId of providerBatchIds) {
        batchInputs.delete(batchId)
        batchPollCount.delete(batchId)
      }
      accumulatedChunks = []
      batchIndex = 0

      // Call the test callback if provided
      if (onErrorCallback) {
        onErrorCallback({ providerBatchIds, error, failedChunkData, failedChunkCount })
      }
    },
  }
}

export type BuildPayloadArgs = {
  dbName: string
  pluginOpts: any
  key?: string
  skipMigrations?: boolean
}

export async function buildPayloadWithIntegration({
  dbName,
  pluginOpts,
  key,
  skipMigrations,
}: BuildPayloadArgs): Promise<{ payload: Payload; config: SanitizedConfig }> {
  const integration = createVectorizeIntegration({
    default: {
      dims: DEFAULT_DIMS,
      ivfflatLists: 1,
    },
  })

  const config = await buildConfig({
    secret: 'test-secret',
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
          queue: pluginOpts.realtimeQueueName ?? 'default',
        },
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
  const payload = await getPayload({
    config,
    key: payloadKey,
    cron: true,
  })

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
