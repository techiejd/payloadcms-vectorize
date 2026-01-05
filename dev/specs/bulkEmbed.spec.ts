import type { Payload, SanitizedConfig } from 'payload'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { createVectorizeTask } from '../../src/tasks/vectorize.js'
import { BULK_EMBEDDINGS_RUNS_SLUG } from '../../src/collections/bulkEmbeddingsRuns.js'
import { BULK_EMBEDDINGS_BATCHES_SLUG } from '../../src/collections/bulkEmbeddingsBatches.js'
import { BULK_EMBEDDINGS_INPUT_METADATA_SLUG } from '../../src/collections/bulkEmbeddingInputMetadata.js'
import {
  BULK_QUEUE_NAMES,
  DEFAULT_DIMS,
  buildPayloadWithIntegration,
  clearAllCollections,
  createMockBulkEmbeddings,
  createSucceededBaselineRun,
  createTestDb,
  waitForBulkJobs,
} from './utils.js'
import { makeDummyEmbedDocs, makeDummyEmbedQuery, testEmbeddingVersion } from 'helpers/embed.js'

const DIMS = DEFAULT_DIMS

describe('Bulk embed ingest mode with streaming API', () => {
  let payload: Payload
  let config: SanitizedConfig
  const dbName = `bulk_embed_test_${Date.now()}`

  const basePluginOptions = {
    knowledgePools: {
      default: {
        collections: {
          posts: {
            toKnowledgePool: async (doc: any) => [{ chunk: doc.title }],
          },
        },
        embeddingConfig: {
          version: testEmbeddingVersion,
          queryFn: makeDummyEmbedQuery(DIMS),
          // No realTimeIngestionFn - bulk-only mode
          bulkEmbeddingsFns: createMockBulkEmbeddings({ statusSequence: ['succeeded'] }),
        },
      },
    },
    bulkQueueNames: BULK_QUEUE_NAMES,
  }

  // Helper to build payload with custom options using the SAME database
  const buildPayloadWithOptions = async (
    pluginOpts: any,
    keyPrefix: string = 'custom',
  ): Promise<Payload> => {
    const built = await buildPayloadWithIntegration({
      dbName,
      pluginOpts,
      secret: 'test-secret',
      dims: DIMS,
      key: `${keyPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    })
    return built.payload
  }

  beforeAll(async () => {
    await createTestDb({ dbName })
    const built = await buildPayloadWithIntegration({
      dbName,
      pluginOpts: basePluginOptions,
      secret: 'test-secret',
      dims: DIMS,
      key: `base-${Date.now()}`,
    })
    payload = built.payload
    config = built.config
  })

  beforeEach(async () => {
    // Clear data before each test but keep the same DB/payload
    await clearAllCollections(payload)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
  })

  test('no bulk run is queued on init or doc creation (bulk-only mode)', async () => {
    // Verify that no bulk runs are queued automatically on init
    const runsBeforeCreate = await (payload as any).find({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      where: { pool: { equals: 'default' } },
    })
    expect(runsBeforeCreate.totalDocs).toBe(0)

    // Create a post - should NOT queue a bulk run (bulk must be triggered manually)
    await payload.create({ collection: 'posts', data: { title: 'First' } as any })

    // Verify still no bulk runs queued
    const runsAfterCreate = await (payload as any).find({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      where: { pool: { equals: 'default' } },
    })
    expect(runsAfterCreate.totalDocs).toBe(0)
  })

  test('manually triggered bulk run embeds documents', async () => {
    // Create a post first
    const post = await payload.create({ collection: 'posts', data: { title: 'First' } as any })

    // Manually trigger a bulk run (simulating API call or admin UI)
    const run = await payload.create({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      data: {
        pool: 'default',
        embeddingVersion: testEmbeddingVersion,
        status: 'queued',
      },
    })

    await payload.jobs.queue<'payloadcms-vectorize:prepare-bulk-embedding'>({
      task: 'payloadcms-vectorize:prepare-bulk-embedding',
      input: { runId: String(run.id) },
      req: { payload } as any,
      ...(BULK_QUEUE_NAMES.prepareBulkEmbedQueueName
        ? { queue: BULK_QUEUE_NAMES.prepareBulkEmbedQueueName }
        : {}),
    })

    // Wait for the bulk run to complete
    await waitForBulkJobs(payload)

    const embeds = await payload.find({
      collection: 'default',
      where: { docId: { equals: String(post.id) } },
    })
    expect(embeds.totalDocs).toBe(1)
    const runDoc = (
      await (payload as any).find({
        collection: BULK_EMBEDDINGS_RUNS_SLUG,
        where: { id: { equals: String(run.id) } },
      })
    ).docs[0]
    expect(runDoc.status).toBe('succeeded')
  })

  test('bulk run creates batch records', async () => {
    // Create a post first
    await payload.create({ collection: 'posts', data: { title: 'Batch Test' } as any })

    // Manually trigger a bulk run
    const run = await payload.create({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      data: {
        pool: 'default',
        embeddingVersion: testEmbeddingVersion,
        status: 'queued',
      },
    })

    await payload.jobs.queue<'payloadcms-vectorize:prepare-bulk-embedding'>({
      task: 'payloadcms-vectorize:prepare-bulk-embedding',
      input: { runId: String(run.id) },
      req: { payload } as any,
      ...(BULK_QUEUE_NAMES.prepareBulkEmbedQueueName
        ? { queue: BULK_QUEUE_NAMES.prepareBulkEmbedQueueName }
        : {}),
    })

    await waitForBulkJobs(payload)

    // Verify batch records were created
    const batches = await payload.find({
      collection: BULK_EMBEDDINGS_BATCHES_SLUG as any,
      where: { run: { equals: String(run.id) } },
    })
    expect(batches.totalDocs).toBe(1)
    expect(batches.docs[0]).toHaveProperty('batchIndex', 0)
    expect(batches.docs[0]).toHaveProperty('status', 'succeeded')
  })

  test('version bump re-embeds all even without updates', async () => {
    const baselineOptions = {
      ...basePluginOptions,
      knowledgePools: {
        default: {
          ...basePluginOptions.knowledgePools.default,
          embeddingConfig: {
            ...basePluginOptions.knowledgePools.default.embeddingConfig,
            version: 'old-version',
            bulkEmbeddingsFns: createMockBulkEmbeddings({ statusSequence: ['succeeded'] }),
          },
        },
      },
    }
    const baselinePayload = await buildPayloadWithOptions(baselineOptions, 'baseline')
    await baselinePayload.create({ collection: 'posts', data: { title: 'Old' } as any })

    // Manually trigger baseline bulk run
    const baselineRun = await baselinePayload.create({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      data: { pool: 'default', embeddingVersion: 'old-version', status: 'queued' },
    })
    await baselinePayload.jobs.queue<'payloadcms-vectorize:prepare-bulk-embedding'>({
      task: 'payloadcms-vectorize:prepare-bulk-embedding',
      input: { runId: String(baselineRun.id) },
      req: { payload: baselinePayload } as any,
      ...(BULK_QUEUE_NAMES.prepareBulkEmbedQueueName
        ? { queue: BULK_QUEUE_NAMES.prepareBulkEmbedQueueName }
        : {}),
    })
    await waitForBulkJobs(baselinePayload)

    const bumpedOptions = {
      ...basePluginOptions,
      knowledgePools: {
        default: {
          ...basePluginOptions.knowledgePools.default,
          embeddingConfig: {
            ...basePluginOptions.knowledgePools.default.embeddingConfig,
            version: 'new-version',
            bulkEmbeddingsFns: createMockBulkEmbeddings({ statusSequence: ['succeeded'] }),
          },
        },
      },
    }
    // rebuild payload with bumped version
    const bumpedPayload = await buildPayloadWithOptions(bumpedOptions, 'bumped')
    const postAfter = await bumpedPayload.create({
      collection: 'posts',
      data: { title: 'Old' } as any,
    })

    // Manually trigger bulk run with new version
    const newVersionRun = await bumpedPayload.create({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      data: { pool: 'default', embeddingVersion: 'new-version', status: 'queued' },
    })
    await bumpedPayload.jobs.queue<'payloadcms-vectorize:prepare-bulk-embedding'>({
      task: 'payloadcms-vectorize:prepare-bulk-embedding',
      input: { runId: String(newVersionRun.id) },
      req: { payload: bumpedPayload } as any,
      ...(BULK_QUEUE_NAMES.prepareBulkEmbedQueueName
        ? { queue: BULK_QUEUE_NAMES.prepareBulkEmbedQueueName }
        : {}),
    })
    await waitForBulkJobs(bumpedPayload)

    const embeds = await bumpedPayload.find({
      collection: 'default',
      where: { docId: { equals: String(postAfter.id) } },
    })
    expect(embeds.totalDocs).toBe(1)
    const runDoc = (
      await (bumpedPayload as any).find({
        collection: BULK_EMBEDDINGS_RUNS_SLUG,
        where: { id: { equals: String(newVersionRun.id) } },
      })
    ).docs[0]
    expect(runDoc.inputs).toBe(1)
  })

  test('no version bump and no updates → zero eligible and succeed', async () => {
    // Create post first
    const post = await payload.create({ collection: 'posts', data: { title: 'Stable' } as any })

    // Manually trigger baseline bulk run
    const baselineRun = await payload.create({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      data: { pool: 'default', embeddingVersion: testEmbeddingVersion, status: 'queued' },
    })
    await payload.jobs.queue<'payloadcms-vectorize:prepare-bulk-embedding'>({
      task: 'payloadcms-vectorize:prepare-bulk-embedding',
      input: { runId: String(baselineRun.id) },
      req: { payload } as any,
      ...(BULK_QUEUE_NAMES.prepareBulkEmbedQueueName
        ? { queue: BULK_QUEUE_NAMES.prepareBulkEmbedQueueName }
        : {}),
    })
    await waitForBulkJobs(payload)

    // Verify baseline exists
    const embeds = await payload.find({
      collection: 'default',
      where: { docId: { equals: String(post.id) } },
    })
    expect(embeds.totalDocs).toBe(1)

    // Explicitly trigger a new bulk run (simulating manual trigger or API call)
    const run = await payload.create({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      data: {
        pool: 'default',
        embeddingVersion: testEmbeddingVersion,
        status: 'queued',
      },
    })

    await payload.jobs.queue<'payloadcms-vectorize:prepare-bulk-embedding'>({
      task: 'payloadcms-vectorize:prepare-bulk-embedding',
      input: { runId: String(run.id) },
      req: { payload } as any,
      ...(BULK_QUEUE_NAMES.prepareBulkEmbedQueueName
        ? { queue: BULK_QUEUE_NAMES.prepareBulkEmbedQueueName }
        : {}),
    })

    // Wait for the explicitly triggered run to complete
    await waitForBulkJobs(payload)

    // Verify the new run found zero eligible documents and succeeded
    const runDoc = (
      await (payload as any).find({
        collection: BULK_EMBEDDINGS_RUNS_SLUG,
        where: { id: { equals: String(run.id) } },
      })
    ).docs[0]
    expect(runDoc.status).toBe('succeeded')
    expect(runDoc.inputs).toBe(0)
    expect(runDoc.succeeded).toBe(0)
  })

  test('polling requeues when non-terminal then succeeds', async () => {
    const loopPayload = await buildPayloadWithOptions({
      ...basePluginOptions,
      knowledgePools: {
        default: {
          ...basePluginOptions.knowledgePools.default,
          embeddingConfig: {
            ...basePluginOptions.knowledgePools.default.embeddingConfig,
            bulkEmbeddingsFns: createMockBulkEmbeddings({
              statusSequence: ['running', 'succeeded'],
            }),
          },
        },
      },
    })

    const post = await loopPayload.create({ collection: 'posts', data: { title: 'Loop' } as any })

    // Manually trigger bulk run
    const run = await loopPayload.create({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      data: { pool: 'default', embeddingVersion: testEmbeddingVersion, status: 'queued' },
    })

    const queueSpy = vi.spyOn(loopPayload.jobs, 'queue')

    await loopPayload.jobs.queue<'payloadcms-vectorize:prepare-bulk-embedding'>({
      task: 'payloadcms-vectorize:prepare-bulk-embedding',
      input: { runId: String(run.id) },
      req: { payload: loopPayload } as any,
      ...(BULK_QUEUE_NAMES.prepareBulkEmbedQueueName
        ? { queue: BULK_QUEUE_NAMES.prepareBulkEmbedQueueName }
        : {}),
    })

    await waitForBulkJobs(loopPayload)

    expect(queueSpy).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'payloadcms-vectorize:poll-or-complete-bulk-embedding' }),
    )

    const embeds = await loopPayload.find({
      collection: 'default',
      where: { docId: { equals: String(post.id) } },
    })
    expect(embeds.totalDocs).toBe(1)
  })

  test('failed batch marks entire run as failed', async () => {
    const failedPayload = await buildPayloadWithOptions({
      ...basePluginOptions,
      knowledgePools: {
        default: {
          ...basePluginOptions.knowledgePools.default,
          embeddingConfig: {
            ...basePluginOptions.knowledgePools.default.embeddingConfig,
            bulkEmbeddingsFns: createMockBulkEmbeddings({ statusSequence: ['failed'] }),
          },
        },
      },
    })

    const post = await failedPayload.create({ collection: 'posts', data: { title: 'Fail' } as any })

    // Manually trigger bulk run
    const run = await failedPayload.create({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      data: { pool: 'default', embeddingVersion: testEmbeddingVersion, status: 'queued' },
    })

    await failedPayload.jobs.queue<'payloadcms-vectorize:prepare-bulk-embedding'>({
      task: 'payloadcms-vectorize:prepare-bulk-embedding',
      input: { runId: String(run.id) },
      req: { payload: failedPayload } as any,
      ...(BULK_QUEUE_NAMES.prepareBulkEmbedQueueName
        ? { queue: BULK_QUEUE_NAMES.prepareBulkEmbedQueueName }
        : {}),
    })

    await waitForBulkJobs(failedPayload)

    // Verify run is marked as failed
    const runDoc = (
      await (failedPayload as any).find({
        collection: BULK_EMBEDDINGS_RUNS_SLUG,
        where: { id: { equals: String(run.id) } },
      })
    ).docs[0]
    expect(runDoc.status).toBe('failed')

    // Verify no embeddings were written
    const embeds = await failedPayload.find({
      collection: 'default',
      where: { docId: { equals: String(post.id) } },
    })
    expect(embeds.totalDocs).toBe(0)
  })

  test('canceled batch marks entire run as failed', async () => {
    const canceledPayload = await buildPayloadWithOptions({
      ...basePluginOptions,
      knowledgePools: {
        default: {
          ...basePluginOptions.knowledgePools.default,
          embeddingConfig: {
            ...basePluginOptions.knowledgePools.default.embeddingConfig,
            bulkEmbeddingsFns: createMockBulkEmbeddings({ statusSequence: ['canceled'] }),
          },
        },
      },
    })

    const post = await canceledPayload.create({
      collection: 'posts',
      data: { title: 'Cancel' } as any,
    })

    // Manually trigger bulk run
    const run = await canceledPayload.create({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      data: { pool: 'default', embeddingVersion: testEmbeddingVersion, status: 'queued' },
    })

    await canceledPayload.jobs.queue<'payloadcms-vectorize:prepare-bulk-embedding'>({
      task: 'payloadcms-vectorize:prepare-bulk-embedding',
      input: { runId: String(run.id) },
      req: { payload: canceledPayload } as any,
      ...(BULK_QUEUE_NAMES.prepareBulkEmbedQueueName
        ? { queue: BULK_QUEUE_NAMES.prepareBulkEmbedQueueName }
        : {}),
    })

    await waitForBulkJobs(canceledPayload)

    const embeds = await canceledPayload.find({
      collection: 'default',
      where: { docId: { equals: String(post.id) } },
    })
    expect(embeds.totalDocs).toBe(0)
  })

  test('onError callback is called when batch fails', async () => {
    // Track onError calls
    let onErrorCalled = false
    let onErrorArgs: { providerBatchIds: string[]; error: Error } | null = null

    const errorPayload = await buildPayloadWithOptions({
      ...basePluginOptions,
      knowledgePools: {
        default: {
          ...basePluginOptions.knowledgePools.default,
          embeddingConfig: {
            ...basePluginOptions.knowledgePools.default.embeddingConfig,
            bulkEmbeddingsFns: createMockBulkEmbeddings({
              statusSequence: ['failed'],
              onErrorCallback: (args) => {
                onErrorCalled = true
                onErrorArgs = args
              },
            }),
          },
        },
      },
    })

    await errorPayload.create({ collection: 'posts', data: { title: 'Error Test' } as any })

    // Manually trigger bulk run
    const run = await errorPayload.create({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      data: { pool: 'default', embeddingVersion: testEmbeddingVersion, status: 'queued' },
    })

    await errorPayload.jobs.queue<'payloadcms-vectorize:prepare-bulk-embedding'>({
      task: 'payloadcms-vectorize:prepare-bulk-embedding',
      input: { runId: String(run.id) },
      req: { payload: errorPayload } as any,
      ...(BULK_QUEUE_NAMES.prepareBulkEmbedQueueName
        ? { queue: BULK_QUEUE_NAMES.prepareBulkEmbedQueueName }
        : {}),
    })

    await waitForBulkJobs(errorPayload)

    // Verify onError was called
    expect(onErrorCalled).toBe(true)
    expect(onErrorArgs).not.toBeNull()
    expect(onErrorArgs!.providerBatchIds.length).toBeGreaterThan(0)
    expect(onErrorArgs!.error).toBeInstanceOf(Error)
    expect(onErrorArgs!.error.message).toContain('failed')
  })

  test('metadata table is cleaned after successful completion', async () => {
    const cleanPayload = await buildPayloadWithOptions({
      ...basePluginOptions,
      knowledgePools: {
        default: {
          ...basePluginOptions.knowledgePools.default,
          collections: {
            posts: {
              toKnowledgePool: async (doc: any) => [{ chunk: doc.title }],
            },
          },
        },
      },
    })

    await cleanPayload.create({ collection: 'posts', data: { title: 'Cleanup' } as any })

    // Manually trigger bulk run
    const run = await cleanPayload.create({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      data: { pool: 'default', embeddingVersion: testEmbeddingVersion, status: 'queued' },
    })

    await cleanPayload.jobs.queue<'payloadcms-vectorize:prepare-bulk-embedding'>({
      task: 'payloadcms-vectorize:prepare-bulk-embedding',
      input: { runId: String(run.id) },
      req: { payload: cleanPayload } as any,
      ...(BULK_QUEUE_NAMES.prepareBulkEmbedQueueName
        ? { queue: BULK_QUEUE_NAMES.prepareBulkEmbedQueueName }
        : {}),
    })

    await waitForBulkJobs(cleanPayload)

    const metadata = await cleanPayload.find({
      collection: BULK_EMBEDDINGS_INPUT_METADATA_SLUG,
      where: { run: { exists: true } },
    })
    expect(metadata.totalDocs).toBe(0)
  })

  test('metadata table is cleaned after failed run (no partial writes)', async () => {
    const failPayload = await buildPayloadWithOptions({
      ...basePluginOptions,
      knowledgePools: {
        default: {
          ...basePluginOptions.knowledgePools.default,
          embeddingConfig: {
            ...basePluginOptions.knowledgePools.default.embeddingConfig,
            bulkEmbeddingsFns: createMockBulkEmbeddings({ statusSequence: ['failed'] }),
          },
        },
      },
    })

    await failPayload.create({ collection: 'posts', data: { title: 'FailCleanup' } as any })

    // Manually trigger bulk run
    const run = await failPayload.create({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      data: { pool: 'default', embeddingVersion: testEmbeddingVersion, status: 'queued' },
    })

    await failPayload.jobs.queue<'payloadcms-vectorize:prepare-bulk-embedding'>({
      task: 'payloadcms-vectorize:prepare-bulk-embedding',
      input: { runId: String(run.id) },
      req: { payload: failPayload } as any,
      ...(BULK_QUEUE_NAMES.prepareBulkEmbedQueueName
        ? { queue: BULK_QUEUE_NAMES.prepareBulkEmbedQueueName }
        : {}),
    })

    await waitForBulkJobs(failPayload)

    // Verify metadata is cleaned up even on failure
    const metadata = await failPayload.find({
      collection: BULK_EMBEDDINGS_INPUT_METADATA_SLUG,
      where: { run: { exists: true } },
    })
    expect(metadata.totalDocs).toBe(0)
  })

  test('extension fields are merged when writing embeddings', async () => {
    const extPayload = await buildPayloadWithOptions({
      ...basePluginOptions,
      knowledgePools: {
        default: {
          collections: {
            posts: {
              toKnowledgePool: async (doc: any) => [
                { chunk: doc.title, category: 'tech', priority: 3 },
              ],
            },
          },
          extensionFields: [
            { name: 'category', type: 'text' },
            { name: 'priority', type: 'number' },
          ],
          embeddingConfig: {
            ...basePluginOptions.knowledgePools.default.embeddingConfig,
          },
        },
      },
    } as any)

    const post = await extPayload.create({
      collection: 'posts',
      data: { title: 'Ext merge' } as any,
    })

    // Manually trigger bulk run
    const run = await extPayload.create({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      data: { pool: 'default', embeddingVersion: testEmbeddingVersion, status: 'queued' },
    })

    await extPayload.jobs.queue<'payloadcms-vectorize:prepare-bulk-embedding'>({
      task: 'payloadcms-vectorize:prepare-bulk-embedding',
      input: { runId: String(run.id) },
      req: { payload: extPayload } as any,
      ...(BULK_QUEUE_NAMES.prepareBulkEmbedQueueName
        ? { queue: BULK_QUEUE_NAMES.prepareBulkEmbedQueueName }
        : {}),
    })

    await waitForBulkJobs(extPayload)

    const embeds = await extPayload.find({
      collection: 'default',
      where: { docId: { equals: String(post.id) } },
    })
    expect(embeds.totalDocs).toBe(1)
    expect(embeds.docs[0]).toHaveProperty('category', 'tech')
    expect(embeds.docs[0]).toHaveProperty('priority', 3)
  })

  test('multiple chunks keep their respective extension fields', async () => {
    const multiPayload = await buildPayloadWithOptions({
      ...basePluginOptions,
      knowledgePools: {
        default: {
          collections: {
            posts: {
              toKnowledgePool: async () => [
                { chunk: 'Chunk 1', category: 'a', priority: 1 },
                { chunk: 'Chunk 2', category: 'b', priority: 2 },
              ],
            },
          },
          extensionFields: [
            { name: 'category', type: 'text' },
            { name: 'priority', type: 'number' },
          ],
          embeddingConfig: {
            ...basePluginOptions.knowledgePools.default.embeddingConfig,
          },
        },
      },
    } as any)

    const post = await multiPayload.create({
      collection: 'posts',
      data: { title: 'Two' } as any,
    })

    // Manually trigger bulk run
    const run = await multiPayload.create({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      data: { pool: 'default', embeddingVersion: testEmbeddingVersion, status: 'queued' },
    })

    await multiPayload.jobs.queue<'payloadcms-vectorize:prepare-bulk-embedding'>({
      task: 'payloadcms-vectorize:prepare-bulk-embedding',
      input: { runId: String(run.id) },
      req: { payload: multiPayload } as any,
      ...(BULK_QUEUE_NAMES.prepareBulkEmbedQueueName
        ? { queue: BULK_QUEUE_NAMES.prepareBulkEmbedQueueName }
        : {}),
    })

    await waitForBulkJobs(multiPayload)

    const embeds = await multiPayload.find({
      collection: 'default',
      where: { docId: { equals: String(post.id) } },
      sort: 'chunkIndex',
    })
    expect(embeds.totalDocs).toBe(2)
    expect(embeds.docs[0]).toMatchObject({ category: 'a', priority: 1, chunkIndex: 0 })
    expect(embeds.docs[1]).toMatchObject({ category: 'b', priority: 2, chunkIndex: 1 })
  })

  test('multiple batches are created when flushing after N chunks', async () => {
    // Create mock that flushes after 2 chunks
    const smallBatchPayload = await buildPayloadWithOptions({
      ...basePluginOptions,
      knowledgePools: {
        default: {
          ...basePluginOptions.knowledgePools.default,
          embeddingConfig: {
            ...basePluginOptions.knowledgePools.default.embeddingConfig,
            bulkEmbeddingsFns: createMockBulkEmbeddings({
              statusSequence: ['succeeded'],
              flushAfterChunks: 2, // Flush after 2 chunks
            }),
          },
        },
      },
    })

    // Create 5 posts (should result in 3 batches: 2, 2, 1)
    for (let i = 0; i < 5; i++) {
      await smallBatchPayload.create({ collection: 'posts', data: { title: `Post ${i}` } as any })
    }

    // Manually trigger bulk run
    const run = await smallBatchPayload.create({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      data: { pool: 'default', embeddingVersion: testEmbeddingVersion, status: 'queued' },
    })

    await smallBatchPayload.jobs.queue<'payloadcms-vectorize:prepare-bulk-embedding'>({
      task: 'payloadcms-vectorize:prepare-bulk-embedding',
      input: { runId: String(run.id) },
      req: { payload: smallBatchPayload } as any,
      ...(BULK_QUEUE_NAMES.prepareBulkEmbedQueueName
        ? { queue: BULK_QUEUE_NAMES.prepareBulkEmbedQueueName }
        : {}),
    })

    await waitForBulkJobs(smallBatchPayload, 15000)

    // Verify multiple batches were created
    const batches = await smallBatchPayload.find({
      collection: BULK_EMBEDDINGS_BATCHES_SLUG as any,
      where: { run: { equals: String(run.id) } },
      sort: 'batchIndex',
    })
    expect(batches.totalDocs).toBe(3)
    expect(batches.docs[0]).toHaveProperty('batchIndex', 0)
    expect(batches.docs[1]).toHaveProperty('batchIndex', 1)
    expect(batches.docs[2]).toHaveProperty('batchIndex', 2)

    // Verify all embeddings were written
    const embeds = await smallBatchPayload.find({
      collection: 'default',
    })
    expect(embeds.totalDocs).toBe(5)

    // Verify run has correct totalBatches
    const runDoc = (
      await (smallBatchPayload as any).find({
        collection: BULK_EMBEDDINGS_RUNS_SLUG,
        where: { id: { equals: String(run.id) } },
      })
    ).docs[0]
    expect(runDoc.totalBatches).toBe(3)
    expect(runDoc.status).toBe('succeeded')
  })

  test('realtime mode queues vectorize jobs when realTimeIngestionFn is provided', async () => {
    const realtimeOptions = {
      knowledgePools: {
        default: {
          collections: {
            posts: {
              toKnowledgePool: async (doc: any) => [{ chunk: doc.title }],
            },
          },
          embeddingConfig: {
            version: testEmbeddingVersion,
            queryFn: makeDummyEmbedQuery(DIMS),
            realTimeIngestionFn: makeDummyEmbedDocs(DIMS),
            // Also provide bulk for testing, but realTimeIngestionFn should take precedence
            bulkEmbeddingsFns: createMockBulkEmbeddings({ statusSequence: ['succeeded'] }),
          },
        },
      },
      bulkQueueNames: BULK_QUEUE_NAMES,
    }

    const realtimePayload = await buildPayloadWithOptions(realtimeOptions as any, 'realtime')
    const post = await realtimePayload.create({
      collection: 'posts',
      data: { title: 'Realtime Test' } as any,
    })
    const vectorizeTask = createVectorizeTask({
      knowledgePools: realtimeOptions.knowledgePools as any,
    })
    const vectorizeHandler = vectorizeTask.handler as any
    await vectorizeHandler({
      input: { doc: post, collection: 'posts', knowledgePool: 'default' } as any,
      req: { payload: realtimePayload } as any,
      inlineTask: vi.fn(),
      tasks: {} as any,
      job: {} as any,
    })
    const embeds = await realtimePayload.find({
      collection: 'default',
      where: { docId: { equals: String(post.id) } },
    })
    expect(embeds.totalDocs).toBeGreaterThan(0)
  })
})
