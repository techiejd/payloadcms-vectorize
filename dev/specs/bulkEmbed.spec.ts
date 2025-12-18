import type { Payload, SanitizedConfig } from 'payload'

import { buildConfig, getPayload } from 'payload'
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { createVectorizeTask } from '../../src/tasks/vectorize.js'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { createVectorizeIntegration } from 'payloadcms-vectorize'
import { BULK_EMBEDDINGS_RUNS_SLUG } from '../../src/collections/bulkEmbeddingsRuns.js'
import {
  createPrepareBulkEmbeddingTask,
  createPollOrCompleteBulkEmbeddingTask,
} from '../../src/tasks/bulkEmbedAll.js'
import { createTestDb } from './utils.js'
import { makeDummyEmbedDocs, makeDummyEmbedQuery, testEmbeddingVersion } from 'helpers/embed.js'
import type { BulkEmbeddingsConfig, BulkEmbeddingRunStatus } from '../../src/types.js'

const DIMS = 8

// Mock bulk embeddings configs for testing
function createMockBulkEmbeddings(statusSequence: BulkEmbeddingRunStatus[]): BulkEmbeddingsConfig {
  let callCount = 0
  let lastInputs: BulkEmbeddingInput[] = []
  const embeddings = makeDummyEmbedDocs(DIMS)

  return {
    ingestMode: 'bulk',
    prepareBulkEmbeddings: async ({ inputs }) => {
      lastInputs = inputs
      return {
        providerBatchId: `mock-${Date.now()}`,
        status: 'queued',
        counts: { inputs: inputs.length },
      }
    },
    pollBulkEmbeddings: async () => {
      const status = statusSequence[Math.min(callCount++, statusSequence.length - 1)]
      return {
        status,
        counts:
          status === 'succeeded'
            ? { inputs: lastInputs.length, succeeded: lastInputs.length, failed: 0 }
            : undefined,
      }
    },
    completeBulkEmbeddings: async () => {
      if (!lastInputs.length) {
        return { status: 'succeeded', outputs: [], counts: { inputs: 0, succeeded: 0, failed: 0 } }
      }
      const vectors = await embeddings(lastInputs.map((i) => i.text))
      const outputs = lastInputs.map((input, idx) => ({
        id: input.id,
        embedding: vectors[idx],
      }))
      return {
        status: 'succeeded',
        outputs,
        counts: { inputs: outputs.length, succeeded: outputs.length, failed: 0 },
      }
    },
  }
}

describe('Bulk embed ingest mode', () => {
  let payload: Payload
  let config: SanitizedConfig
  const dbName = 'bulk_embed_test'

  const integration = createVectorizeIntegration({
    default: {
      dims: DIMS,
      ivfflatLists: 1,
    },
  })

  const pluginOptions = {
    knowledgePools: {
      default: {
        collections: {
          posts: {
            toKnowledgePool: async (doc: any) => [{ chunk: doc.title }],
          },
        },
        embedDocs: makeDummyEmbedDocs(DIMS),
        embedQuery: makeDummyEmbedQuery(DIMS),
        embeddingVersion: testEmbeddingVersion,
        bulkEmbeddings: createMockBulkEmbeddings(['succeeded']),
      },
    },
    bulkQueueNames: {
      prepareBulkEmbedQueueName: 'vectorize-bulk-prepare',
      pollOrCompleteQueueName: 'vectorize-bulk-poll',
    },
  }

  beforeAll(async () => {
    await createTestDb({ dbName })
    config = await buildConfig({
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
      plugins: [integration.payloadcmsVectorize(pluginOptions)],
      jobs: { tasks: [] },
    })

    payload = await getPayload({ config })
  })

  beforeEach(async () => {
    // Clean runs and embeddings between tests to avoid cross-test leakage
    await payload.delete({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      where: { id: { exists: true } },
    })
    await payload.delete({
      collection: 'default',
      where: { id: { exists: true } },
    })
    vi.restoreAllMocks()
  })

  test('bulk ingest mode queues no realtime embeddings and bulk job backfills missing docs', async () => {
    const queueSpy = vi.spyOn(payload.jobs, 'queue')

    const post = await payload.create({
      collection: 'posts',
      data: { title: 'Bulk Mode Title' } as any,
    })

    const initialEmbeds = await payload.find({
      collection: 'default',
      where: {
        and: [{ sourceCollection: { equals: 'posts' } }, { docId: { equals: String(post.id) } }],
      },
    })
    expect(initialEmbeds.totalDocs).toBe(0)

    // Bulk mode should queue prepare task automatically
    expect(queueSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        task: 'payloadcms-vectorize:prepare-bulk-embedding',
      }),
    )

    // Get the latest queued run created by the hook
    const { docs: latestRuns } = await payload.find({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      where: { pool: { equals: 'default' } },
      sort: '-createdAt',
      limit: 1,
    })
    const run = latestRuns[0]
    expect(run).toBeDefined()

    // Seed a stale embedding that should be deleted during poll/complete
    await payload.create({
      collection: 'default',
      data: {
        sourceCollection: 'posts',
        docId: String(post.id),
        chunkIndex: 0,
        chunkText: 'stale chunk',
        embeddingVersion: 'old-version',
      },
    })

    // Run prepare task
    const prepareTask = createPrepareBulkEmbeddingTask({
      knowledgePools: pluginOptions.knowledgePools,
      pollOrCompleteQueueName: pluginOptions.bulkQueueNames?.pollOrCompleteQueueName,
    })
    await prepareTask.handler({
      input: { runId: String(run.id) },
      req: { payload } as any,
    })

    // Prepare should have queued the poll task on the poll queue
    expect(queueSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        task: 'payloadcms-vectorize:poll-or-complete-bulk-embedding',
      }),
    )

    // Run poll/complete task
    const pollTask = createPollOrCompleteBulkEmbeddingTask({
      knowledgePools: pluginOptions.knowledgePools,
      pollOrCompleteQueueName: pluginOptions.bulkQueueNames?.pollOrCompleteQueueName,
    })
    await pollTask.handler({
      input: { runId: String(run.id) },
      req: { payload } as any,
    })

    const embeds = await payload.find({
      collection: 'default',
      where: {
        and: [{ sourceCollection: { equals: 'posts' } }, { docId: { equals: String(post.id) } }],
      },
    })
    expect(embeds.totalDocs).toBe(1) // stale embedding should have been deleted and replaced
    expect(embeds.docs[0]?.chunkText).toContain('Bulk Mode Title')

    const runDoc = await payload.findByID({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      id: run.id,
    })
    expect(runDoc.status).toBe('succeeded')
    expect(runDoc.inputs).toBeGreaterThan(0)
  })

  test('bulk ingest mode clears stale embeddings on document updates and rerun populates new chunks', async () => {
    const queueSpy = vi.spyOn(payload.jobs, 'queue')

    const post = await payload.create({
      collection: 'posts',
      data: { title: 'Original' } as any,
    })

    // First run to embed (auto-queued on create)
    const firstRun = (
      await payload.find({
        collection: BULK_EMBEDDINGS_RUNS_SLUG,
        where: { pool: { equals: 'default' } },
        sort: '-createdAt',
        limit: 1,
      })
    ).docs[0]
    expect(firstRun).toBeDefined()

    const prepareTask = createPrepareBulkEmbeddingTask({
      knowledgePools: pluginOptions.knowledgePools,
      pollOrCompleteQueueName: pluginOptions.bulkQueueNames?.pollOrCompleteQueueName,
    })
    const pollTask = createPollOrCompleteBulkEmbeddingTask({
      knowledgePools: pluginOptions.knowledgePools,
      pollOrCompleteQueueName: pluginOptions.bulkQueueNames?.pollOrCompleteQueueName,
    })

    await prepareTask.handler({ input: { runId: String(firstRun.id) }, req: { payload } as any })
    await pollTask.handler({ input: { runId: String(firstRun.id) }, req: { payload } as any })

    // Update document - embeddings should remain until poll/completion of the next run
    await payload.update({
      collection: 'posts',
      id: post.id,
      data: { title: 'Updated Title' } as any,
    })

    const afterUpdateEmbeds = await payload.find({
      collection: 'default',
      where: {
        and: [{ sourceCollection: { equals: 'posts' } }, { docId: { equals: String(post.id) } }],
      },
    })
    expect(afterUpdateEmbeds.totalDocs).toBeGreaterThan(0) // no upfront delete; still present until bulk completion

    // Next run should have been queued by the update hook
    expect(queueSpy).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'payloadcms-vectorize:prepare-bulk-embedding' }),
    )
    const secondRun = (
      await payload.find({
        collection: BULK_EMBEDDINGS_RUNS_SLUG,
        where: { pool: { equals: 'default' } },
        sort: '-createdAt',
        limit: 1,
      })
    ).docs[0]
    expect(secondRun).toBeDefined()

    await prepareTask.handler({ input: { runId: String(secondRun.id) }, req: { payload } as any })
    await pollTask.handler({ input: { runId: String(secondRun.id) }, req: { payload } as any })

    const embedsAfterRerun = await payload.find({
      collection: 'default',
      where: {
        and: [{ sourceCollection: { equals: 'posts' } }, { docId: { equals: String(post.id) } }],
      },
    })
    expect(embedsAfterRerun.totalDocs).toBeGreaterThan(0)
    expect(embedsAfterRerun.docs[0]?.chunkText).toContain('Updated Title')
  })

  test('realtime ingest mode queues vectorize jobs on document creation', async () => {
    const realtimePluginOptions = {
      knowledgePools: {
        default: {
          collections: {
            posts: {
              toKnowledgePool: async (doc: any) => [{ chunk: doc.title }],
            },
          },
          embedDocs: makeDummyEmbedDocs(DIMS),
          embedQuery: makeDummyEmbedQuery(DIMS),
          embeddingVersion: testEmbeddingVersion,
          bulkEmbeddings: {
            ingestMode: 'realtime',
            prepareBulkEmbeddings: async () => ({
              providerBatchId: 'noop',
              status: 'succeeded',
              counts: { inputs: 0, succeeded: 0, failed: 0 },
            }),
            pollBulkEmbeddings: async () => ({ status: 'succeeded' }),
            completeBulkEmbeddings: async () => ({
              status: 'succeeded',
              outputs: [],
              counts: { inputs: 0 },
            }),
          },
        },
      },
      bulkQueueNames: {
        prepareBulkEmbedQueueName: 'vectorize-bulk-prepare',
        pollOrCompleteQueueName: 'vectorize-bulk-poll',
      },
    }

    const realtimeConfig = await buildConfig({
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
      plugins: [integration.payloadcmsVectorize(realtimePluginOptions)],
      jobs: { tasks: [] },
    })

    const realtimePayload = await getPayload({ config: realtimeConfig })

    // Create a document - should trigger realtime vectorization
    const post = await realtimePayload.create({
      collection: 'posts',
      data: { title: 'Realtime Test' } as any,
    })

    // Manually run vectorize task since jobs queue is not processed in tests
    const vectorizeTask = createVectorizeTask({
      knowledgePools: realtimePluginOptions.knowledgePools,
    })
    await vectorizeTask.handler({
      input: {
        doc: post,
        collection: 'posts',
        knowledgePool: 'default',
      } as any,
      req: { payload: realtimePayload } as any,
      inlineTask: vi.fn(),
      tasks: {} as any,
      job: {} as any,
    })

    const embeds = await realtimePayload.find({
      collection: 'default',
      where: {
        and: [{ sourceCollection: { equals: 'posts' } }, { docId: { equals: String(post.id) } }],
      },
    })
    expect(embeds.totalDocs).toBeGreaterThan(0)
    expect(embeds.docs[0]?.chunkText).toBe('Realtime Test')
  })

  test('bulk polling handles failed status correctly', async () => {
    const failedBulkOptions = {
      knowledgePools: {
        default: {
          collections: {
            posts: {
              toKnowledgePool: async (doc: any) => [{ chunk: doc.title }],
            },
          },
          embedDocs: makeDummyEmbedDocs(DIMS),
          embedQuery: makeDummyEmbedQuery(DIMS),
          embeddingVersion: testEmbeddingVersion,
          bulkEmbeddings: createMockBulkEmbeddings(['failed']),
        },
      },
      bulkQueueNames: {
        prepareBulkEmbedQueueName: 'vectorize-bulk-prepare',
        pollOrCompleteQueueName: 'vectorize-bulk-poll',
      },
    }

    const failedConfig = await buildConfig({
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
      plugins: [integration.payloadcmsVectorize(failedBulkOptions)],
      jobs: { tasks: [] },
    })

    const failedPayload = await getPayload({ config: failedConfig })

    const post = await failedPayload.create({
      collection: 'posts',
      data: { title: 'Failed Test' } as any,
    })

    const run = await failedPayload.create({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      data: {
        pool: 'default',
        embeddingVersion: testEmbeddingVersion,
        status: 'queued',
      },
    })

    const prepareTask = createPrepareBulkEmbeddingTask({
      knowledgePools: failedBulkOptions.knowledgePools,
      pollOrCompleteQueueName: failedBulkOptions.bulkQueueNames?.pollOrCompleteQueueName,
    })
    const pollTask = createPollOrCompleteBulkEmbeddingTask({
      knowledgePools: failedBulkOptions.knowledgePools,
      pollOrCompleteQueueName: failedBulkOptions.bulkQueueNames?.pollOrCompleteQueueName,
    })

    await prepareTask.handler({
      input: { runId: String(run.id) },
      req: { payload: failedPayload } as any,
    })
    await pollTask.handler({
      input: { runId: String(run.id) },
      req: { payload: failedPayload } as any,
    })

    const runDoc = await failedPayload.findByID({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      id: run.id,
    })
    expect(runDoc.status).toBe('failed')
    // Should not call completeBulkEmbeddings, so no embeddings created
    const embeds = await failedPayload.find({
      collection: 'default',
      where: {
        and: [{ sourceCollection: { equals: 'posts' } }, { docId: { equals: String(post.id) } }],
      },
    })
    expect(embeds.totalDocs).toBe(0)
  })

  test('bulk polling handles canceled status correctly', async () => {
    const canceledBulkOptions = {
      knowledgePools: {
        default: {
          collections: {
            posts: {
              toKnowledgePool: async (doc: any) => [{ chunk: doc.title }],
            },
          },
          embedDocs: makeDummyEmbedDocs(DIMS),
          embedQuery: makeDummyEmbedQuery(DIMS),
          embeddingVersion: testEmbeddingVersion,
          bulkEmbeddings: createMockBulkEmbeddings(['canceled']),
        },
      },
      bulkQueueNames: {
        prepareBulkEmbedQueueName: 'vectorize-bulk-prepare',
        pollOrCompleteQueueName: 'vectorize-bulk-poll',
      },
    }

    const canceledConfig = await buildConfig({
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
      plugins: [integration.payloadcmsVectorize(canceledBulkOptions)],
      jobs: { tasks: [] },
    })

    const canceledPayload = await getPayload({ config: canceledConfig })

    const run = await canceledPayload.create({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      data: {
        pool: 'default',
        embeddingVersion: testEmbeddingVersion,
        status: 'queued',
      },
    })

    const prepareTask = createPrepareBulkEmbeddingTask({
      knowledgePools: canceledBulkOptions.knowledgePools,
      pollOrCompleteQueueName: canceledBulkOptions.bulkQueueNames?.pollOrCompleteQueueName,
    })
    const pollTask = createPollOrCompleteBulkEmbeddingTask({
      knowledgePools: canceledBulkOptions.knowledgePools,
      pollOrCompleteQueueName: canceledBulkOptions.bulkQueueNames?.pollOrCompleteQueueName,
    })

    await prepareTask.handler({
      input: { runId: String(run.id) },
      req: { payload: canceledPayload } as any,
    })
    await pollTask.handler({
      input: { runId: String(run.id) },
      req: { payload: canceledPayload } as any,
    })

    const runDoc = await canceledPayload.findByID({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      id: run.id,
    })
    expect(runDoc.status).toBe('canceled')
  })

  test('bulk fan-in: multiple documents created before bulk task runs are all processed in single run', async () => {
    // Create multiple documents
    const post1 = await payload.create({
      collection: 'posts',
      data: { title: 'Post 1' } as any,
    })
    const post2 = await payload.create({
      collection: 'posts',
      data: { title: 'Post 2' } as any,
    })

    // Verify no embeddings initially
    const initialEmbeds = await payload.find({
      collection: 'default',
      where: { sourceCollection: { equals: 'posts' } },
    })
    expect(initialEmbeds.totalDocs).toBe(0)

    // Create single bulk run
    const run = await payload.create({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      data: {
        pool: 'default',
        embeddingVersion: testEmbeddingVersion,
        status: 'queued',
      },
    })

    // Run bulk tasks
    const prepareTask = createPrepareBulkEmbeddingTask({
      knowledgePools: pluginOptions.knowledgePools,
      pollOrCompleteQueueName: pluginOptions.bulkQueueNames?.pollOrCompleteQueueName,
    })
    const pollTask = createPollOrCompleteBulkEmbeddingTask({
      knowledgePools: pluginOptions.knowledgePools,
      pollOrCompleteQueueName: pluginOptions.bulkQueueNames?.pollOrCompleteQueueName,
    })

    await prepareTask.handler({ input: { runId: String(run.id) }, req: { payload } as any })
    await pollTask.handler({ input: { runId: String(run.id) }, req: { payload } as any })

    // Verify all documents got embeddings
    const finalEmbeds = await payload.find({
      collection: 'default',
      where: { sourceCollection: { equals: 'posts' } },
    })
    expect(finalEmbeds.totalDocs).toBe(2)

    const runDoc = await payload.findByID({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      id: run.id,
    })
    expect(runDoc.status).toBe('succeeded')
    expect(runDoc.inputs).toBe(2)
  })
})
