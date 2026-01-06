import type { Payload, SanitizedConfig } from 'payload'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { BULK_EMBEDDINGS_RUNS_SLUG } from '../../../src/collections/bulkEmbeddingsRuns.js'
import { BULK_EMBEDDINGS_BATCHES_SLUG } from '../../../src/collections/bulkEmbeddingsBatches.js'
import { BULK_EMBEDDINGS_INPUT_METADATA_SLUG } from '../../../src/collections/bulkEmbeddingInputMetadata.js'
import {
  BULK_QUEUE_NAMES,
  DEFAULT_DIMS,
  buildPayloadWithIntegration,
  clearAllCollections,
  createMockBulkEmbeddings,
  createTestDb,
  waitForBulkJobs,
} from '../utils.js'
import { makeDummyEmbedQuery, testEmbeddingVersion } from 'helpers/embed.js'

const DIMS = DEFAULT_DIMS
const dbName = `bulk_basic_${Date.now()}`

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
        bulkEmbeddingsFns: createMockBulkEmbeddings({ statusSequence: ['succeeded'] }),
      },
    },
  },
  bulkQueueNames: BULK_QUEUE_NAMES,
}

describe('Bulk embed - basic tests', () => {
  let payload: Payload
  let config: SanitizedConfig

  beforeAll(async () => {
    await createTestDb({ dbName })
    const built = await buildPayloadWithIntegration({
      dbName,
      pluginOpts: basePluginOptions,
      secret: 'test-secret',
      dims: DIMS,
      key: `basic-${Date.now()}`,
    })
    payload = built.payload
    config = built.config
  })

  beforeEach(async () => {
    await clearAllCollections(payload)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
  })

  test('no bulk run is queued on init or doc creation (bulk-only mode)', async () => {
    const runsBeforeCreate = await (payload as any).find({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      where: { pool: { equals: 'default' } },
    })
    expect(runsBeforeCreate.totalDocs).toBe(0)

    await payload.create({ collection: 'posts', data: { title: 'First' } as any })

    const runsAfterCreate = await (payload as any).find({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      where: { pool: { equals: 'default' } },
    })
    expect(runsAfterCreate.totalDocs).toBe(0)
  })

  test('manually triggered bulk run embeds documents', async () => {
    const post = await payload.create({ collection: 'posts', data: { title: 'First' } as any })

    const run = await payload.create({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      data: { pool: 'default', embeddingVersion: testEmbeddingVersion, status: 'queued' },
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
    await payload.create({ collection: 'posts', data: { title: 'Batch Test' } as any })

    const run = await payload.create({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      data: { pool: 'default', embeddingVersion: testEmbeddingVersion, status: 'queued' },
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

    const batches = await payload.find({
      collection: BULK_EMBEDDINGS_BATCHES_SLUG as any,
      where: { run: { equals: String(run.id) } },
    })
    expect(batches.totalDocs).toBe(1)
    expect(batches.docs[0]).toHaveProperty('batchIndex', 0)
    expect(batches.docs[0]).toHaveProperty('status', 'succeeded')
  })

  test('no version bump and no updates → zero eligible and succeed', async () => {
    const post = await payload.create({ collection: 'posts', data: { title: 'Stable' } as any })

    // First bulk run
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

    const embeds = await payload.find({
      collection: 'default',
      where: { docId: { equals: String(post.id) } },
    })
    expect(embeds.totalDocs).toBe(1)

    // Second bulk run - should find zero eligible
    const run = await payload.create({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      data: { pool: 'default', embeddingVersion: testEmbeddingVersion, status: 'queued' },
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

  test('metadata table is cleaned after successful completion', async () => {
    await payload.create({ collection: 'posts', data: { title: 'Cleanup' } as any })

    const run = await payload.create({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      data: { pool: 'default', embeddingVersion: testEmbeddingVersion, status: 'queued' },
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

    const metadata = await payload.find({
      collection: BULK_EMBEDDINGS_INPUT_METADATA_SLUG,
      where: { run: { exists: true } },
    })
    expect(metadata.totalDocs).toBe(0)
  })
})

