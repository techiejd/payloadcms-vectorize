import type { Payload, SanitizedConfig } from 'payload'

import { buildConfig, getPayload } from 'payload'
import { beforeAll, describe, expect, test } from 'vitest'
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
  const embeddings = makeDummyEmbedDocs(DIMS)

  return {
    ingestMode: 'bulk',
    prepareBulkEmbeddings: async ({ inputs }) => {
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
        counts: status === 'succeeded' ? { inputs: 1, succeeded: 1, failed: 0 } : undefined,
      }
    },
    completeBulkEmbeddings: async ({ providerBatchId }) => {
      const inputs = [{ id: 'test-1', text: 'test text', metadata: {} }]
      const vectors = await embeddings([inputs[0].text])
      return {
        status: 'succeeded',
        outputs: [{ id: inputs[0].id, embedding: vectors[0] }],
        counts: { inputs: 1, succeeded: 1, failed: 0 },
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
    bulkQueueName: 'vectorize-bulk',
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

  test('bulk ingest mode queues no realtime embeddings and bulk job backfills missing docs', async () => {
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

    const run = await payload.create({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      data: {
        pool: 'default',
        embeddingVersion: testEmbeddingVersion,
        status: 'queued',
      },
    })

    // Run prepare task
    const prepareTask = createPrepareBulkEmbeddingTask({
      knowledgePools: pluginOptions.knowledgePools,
      bulkQueueName: pluginOptions.bulkQueueName,
    })
    await prepareTask.handler({
      input: { runId: String(run.id) },
      req: { payload } as any,
    })

    // Run poll/complete task
    const pollTask = createPollOrCompleteBulkEmbeddingTask({
      knowledgePools: pluginOptions.knowledgePools,
      bulkQueueName: pluginOptions.bulkQueueName,
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
    expect(embeds.totalDocs).toBeGreaterThan(0)
    expect(embeds.docs[0]?.chunkText).toContain('Bulk Mode Title')

    const runDoc = await payload.findByID({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      id: run.id,
    })
    expect(runDoc.status).toBe('succeeded')
    expect(runDoc.inputs).toBeGreaterThan(0)
  })

  test('bulk ingest mode clears stale embeddings on document updates and rerun populates new chunks', async () => {
    const post = await payload.create({
      collection: 'posts',
      data: { title: 'Original' } as any,
    })

    // First run to embed
    const firstRun = await payload.create({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      data: {
        pool: 'default',
        embeddingVersion: testEmbeddingVersion,
        status: 'queued',
      },
    })

    const prepareTask = createPrepareBulkEmbeddingTask({
      knowledgePools: pluginOptions.knowledgePools,
      bulkQueueName: pluginOptions.bulkQueueName,
    })
    const pollTask = createPollOrCompleteBulkEmbeddingTask({
      knowledgePools: pluginOptions.knowledgePools,
      bulkQueueName: pluginOptions.bulkQueueName,
    })

    await prepareTask.handler({ input: { runId: String(firstRun.id) }, req: { payload } as any })
    await pollTask.handler({ input: { runId: String(firstRun.id) }, req: { payload } as any })

    // Update document - should delete embeddings in bulk mode
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
    expect(afterUpdateEmbeds.totalDocs).toBe(0)

    // Run again to backfill
    const secondRun = await payload.create({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      data: {
        pool: 'default',
        embeddingVersion: testEmbeddingVersion,
        status: 'queued',
      },
    })
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
          // No bulkEmbeddings - should default to realtime
        },
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

    // Check that embeddings were created immediately
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
      bulkQueueName: 'vectorize-bulk',
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
      bulkQueueName: failedBulkOptions.bulkQueueName,
    })
    const pollTask = createPollOrCompleteBulkEmbeddingTask({
      knowledgePools: failedBulkOptions.knowledgePools,
      bulkQueueName: failedBulkOptions.bulkQueueName,
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
      bulkQueueName: 'vectorize-bulk',
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
      bulkQueueName: canceledBulkOptions.bulkQueueName,
    })
    const pollTask = createPollOrCompleteBulkEmbeddingTask({
      knowledgePools: canceledBulkOptions.knowledgePools,
      bulkQueueName: canceledBulkOptions.bulkQueueName,
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
      bulkQueueName: pluginOptions.bulkQueueName,
    })
    const pollTask = createPollOrCompleteBulkEmbeddingTask({
      knowledgePools: pluginOptions.knowledgePools,
      bulkQueueName: pluginOptions.bulkQueueName,
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
