import type { Payload, SanitizedConfig } from 'payload'

import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { createVectorizeTask } from '../../src/tasks/vectorize.js'
import { BULK_EMBEDDINGS_RUNS_SLUG } from '../../src/collections/bulkEmbeddingsRuns.js'
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
import type { BulkEmbeddingsFns } from '../../src/types.js'

const DIMS = DEFAULT_DIMS

describe('Bulk embed ingest mode with version/time gating', () => {
  let payload: Payload
  let config: SanitizedConfig
  const dbNameBase = 'bulk_embed_test'
  let dbName: string

  const basePluginOptions = {
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
        bulkEmbeddings: createMockBulkEmbeddings({ statusSequence: ['succeeded'] }),
      },
    },
    bulkQueueNames: BULK_QUEUE_NAMES,
  }

  const makeDbName = () => `${dbNameBase}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`

  const buildPayload = async (
    pluginOpts = basePluginOptions,
    options?: { dbName?: string; secret?: string },
  ) => {
    const dbToUse = options?.dbName || dbName
    const secret = options?.secret || 'test-secret'
    console.log('building payload with pluginOpts', pluginOpts)
    const built = await buildPayloadWithIntegration({
      dbName: dbToUse,
      pluginOpts,
      secret,
      dims: DIMS,
      key: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    })
    payload = built.payload
    config = built.config
    return payload
  }

  beforeEach(async () => {
    dbName = makeDbName()
    await createTestDb({ dbName })
    await buildPayload()
  })

  afterEach(async () => {
    await clearAllCollections(payload)
    vi.restoreAllMocks()
  })

  async function createSucceededBaseline({
    version = testEmbeddingVersion,
    completedAt = new Date().toISOString(),
  } = {}) {
    return createSucceededBaselineRun(payload, { version, completedAt })
  }

  test('fresh project, no docs → counts 0 baseline', async () => {
    // onInit queues first run automatically; no docs should yield zero counts
    await waitForBulkJobs(payload)
    const runDoc = (
      await (payload as any).find({
        collection: BULK_EMBEDDINGS_RUNS_SLUG,
        where: { pool: { equals: 'default' } },
        sort: '-createdAt',
        limit: 1,
      })
    ).docs[0]
    expect(runDoc.inputs).toBe(0)
    expect(runDoc.succeeded).toBe(0)
  })

  test('enabling bulk later queues first run automatically', async () => {
    // Clear state from the default payload built in beforeEach
    await clearAllCollections(payload)

    // Use a fresh database for the toggle scenario to avoid residual runs
    const tempDbName = `${dbNameBase}_toggle_${Date.now()}`
    await createTestDb({ dbName: tempDbName })

    // Start without bulkEmbeddings configured
    const noBulkOptions = {
      ...basePluginOptions,
      disabled: true,
      knowledgePools: {
        default: {
          ...basePluginOptions.knowledgePools.default,
          bulkEmbeddings: undefined,
        },
      },
    }
    console.log('building noBulkPayload with noBulkOptions', noBulkOptions)
    const noBulkPayload = await buildPayload(noBulkOptions as any, {
      dbName: tempDbName,
      secret: `secret-nobulk-${Date.now()}`,
    })
    console.log('noBulkPayload')
    // Clear any runs that might have been created by previous payload instance
    console.log('clearing all')
    await clearAllCollections(noBulkPayload)
    console.log('creating post')
    await noBulkPayload.create({ collection: 'posts', data: { title: 'NoBulk' } as any })
    console.log('creating post done')
    // No bulk runs should exist (onInit shouldn't create runs when bulkEmbeddings is undefined)
    const none = await (noBulkPayload as any).find({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      where: { pool: { equals: 'default' } },
    })
    console.log('none', none)
    expect(none.totalDocs).toBe(0)

    // Rebuild with bulk enabled; onInit should queue the first run
    const bulkPayload = await buildPayload(basePluginOptions, {
      dbName: tempDbName,
      secret: `secret-bulk-${Date.now()}`,
    })
    await bulkPayload.create({ collection: 'posts', data: { title: 'WithBulk' } as any })
    await waitForBulkJobs(bulkPayload)
    const runDoc = (
      await (bulkPayload as any).find({
        collection: BULK_EMBEDDINGS_RUNS_SLUG,
        where: { pool: { equals: 'default' } },
        sort: '-createdAt',
        limit: 1,
      })
    ).docs[0]
    expect(runDoc).toBeDefined()
    expect(runDoc.status).toBe('succeeded')
  })

  test('fresh project, add doc → establishes baseline and then embeds all', async () => {
    // Wait for the initial onInit-queued baseline run to complete (0 docs)
    await waitForBulkJobs(payload)

    // Now create the post, which will queue another run via afterChange
    const post = await payload.create({ collection: 'posts', data: { title: 'First' } as any })

    // Wait for the post-creation-queued run to complete
    await waitForBulkJobs(payload)

    const embeds = await payload.find({
      collection: 'default',
      where: { docId: { equals: String(post.id) } },
    })
    expect(embeds.totalDocs).toBe(1)
    const runDoc = (
      await (payload as any).find({
        collection: BULK_EMBEDDINGS_RUNS_SLUG,
        where: { pool: { equals: 'default' } },
        sort: '-createdAt',
        limit: 1,
      })
    ).docs[0]
    expect(runDoc.status).toBe('succeeded')
  })

  test('version bump re-embeds all even without updates', async () => {
    // TODO(techiejd): Why is this clear all necessary?
    await clearAllCollections(payload)
    const baselineOptions = {
      ...basePluginOptions,
      knowledgePools: {
        default: {
          ...basePluginOptions.knowledgePools.default,
          embeddingVersion: 'old-version',
          bulkEmbeddings: createMockBulkEmbeddings({ statusSequence: ['succeeded'] }),
        },
      },
    }
    const baselinePayload = await buildPayload(baselineOptions)
    await baselinePayload.create({ collection: 'posts', data: { title: 'Old' } as any })
    await waitForBulkJobs(baselinePayload) // initial baseline run with 'old-version'

    const bumpedOptions = {
      ...basePluginOptions,
      knowledgePools: {
        default: {
          ...basePluginOptions.knowledgePools.default,
          embeddingVersion: 'new-version',
          bulkEmbeddings: createMockBulkEmbeddings({ statusSequence: ['succeeded'] }),
        },
      },
    }
    // rebuild payload with bumped options so onInit queues a version-mismatch run
    const bumpedPayload = await buildPayload(bumpedOptions)
    const postAfter = await bumpedPayload.create({
      collection: 'posts',
      data: { title: 'Old' } as any,
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
        where: { pool: { equals: 'default' } },
        sort: '-createdAt',
        limit: 1,
      })
    ).docs[0]
    expect(runDoc.inputs).toBe(1)
  })

  test('no version bump and no updates → zero eligible and succeed', async () => {
    // Wait for initial onInit-queued baseline run
    await waitForBulkJobs(payload)

    // Create post and wait for it to be embedded (establishes baseline)
    const post = await payload.create({ collection: 'posts', data: { title: 'Stable' } as any })
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

  /*test('updatedAt gating: updated after last bulk is eligible; before is skipped', async () => {
    await clearAllCollections(payload)
    const gatingPayload = await buildPayload()
    const oldPost = await gatingPayload.create({
      collection: 'posts',
      data: { title: 'Old' } as any,
    })
    await waitForBulkJobs(gatingPayload) // baseline run
    const baselineTime = new Date()
    await createSucceededBaseline({ completedAt: baselineTime.toISOString() })

    const newPost = await gatingPayload.create({
      collection: 'posts',
      data: { title: 'New' } as any,
    })
    await gatingPayload.update({
      collection: 'posts',
      id: newPost.id,
      data: { title: 'New Updated' } as any,
    })

    await waitForBulkJobs(gatingPayload)

    const embedsOld = await gatingPayload.find({
      collection: 'default',
      where: { docId: { equals: String(oldPost.id) } },
    })
    const embedsNew = await gatingPayload.find({
      collection: 'default',
      where: { docId: { equals: String(newPost.id) } },
    })
    expect(embedsOld.totalDocs).toBe(1)
    expect(embedsNew.totalDocs).toBe(1)
  })

  test('missing embedding for current version is eligible even if not updated', async () => {
    const post = await payload.create({ collection: 'posts', data: { title: 'Missing' } as any })
    await createSucceededBaseline()
    await payload.delete({
      collection: 'default',
      where: { docId: { equals: String(post.id) } },
    })
    await waitForBulkJobs(payload)
    const embeds = await payload.find({
      collection: 'default',
      where: { docId: { equals: String(post.id) } },
    })
    expect(embeds.totalDocs).toBe(1)
  })

  test('stale replacement happens at completion, not prepare', async () => {
    const post = await payload.create({ collection: 'posts', data: { title: 'Stale' } as any })
    await waitForBulkJobs(payload)
    await payload.update({
      collection: 'posts',
      id: post.id,
      data: { title: 'Fresh Title' } as any,
    })
    const embedsBefore = await payload.find({
      collection: 'default',
      where: { docId: { equals: String(post.id) } },
    })
    expect(embedsBefore.totalDocs).toBeGreaterThan(0)
    await waitForBulkJobs(payload)
    const embedsAfter = await payload.find({
      collection: 'default',
      where: { docId: { equals: String(post.id) } },
    })
    expect(embedsAfter.docs[0]?.chunkText).toContain('Fresh Title')
  })

  test('partial outputs only delete/replace succeeded doc IDs', async () => {
    await clearAllCollections(payload)
    const partialPayload = await buildPayload({
      ...basePluginOptions,
      knowledgePools: {
        default: {
          ...basePluginOptions.knowledgePools.default,
          bulkEmbeddings: createMockBulkEmbeddings({
            statusSequence: ['succeeded'],
            partialFailure: { failIds: [] },
          }),
        },
      },
    })
    const post1 = await partialPayload.create({ collection: 'posts', data: { title: 'P1' } as any })
    const post2 = await partialPayload.create({ collection: 'posts', data: { title: 'P2' } as any })
    // Rebuild with failIds after IDs are known
    const partialPayloadWithFails = await buildPayload({
      ...basePluginOptions,
      knowledgePools: {
        default: {
          ...basePluginOptions.knowledgePools.default,
          bulkEmbeddings: createMockBulkEmbeddings({
            statusSequence: ['succeeded'],
            partialFailure: { failIds: [`posts:${post2.id}:0`] },
          }),
        },
      },
    })
    await waitForBulkJobs(partialPayloadWithFails)

    const embedsP1 = await partialPayloadWithFails.find({
      collection: 'default',
      where: { docId: { equals: String(post1.id) } },
    })
    const embedsP2 = await partialPayloadWithFails.find({
      collection: 'default',
      where: { docId: { equals: String(post2.id) } },
    })
    expect(embedsP1.totalDocs).toBe(1)
    expect(embedsP2.totalDocs).toBe(0)
  })

  test('polling requeues when non-terminal then succeeds', async () => {
    await clearAllCollections(payload)
    const loopPayload = await buildPayload({
      ...basePluginOptions,
      knowledgePools: {
        default: {
          ...basePluginOptions.knowledgePools.default,
          bulkEmbeddings: createMockBulkEmbeddings({ statusSequence: ['running', 'succeeded'] }),
        },
      },
    })
    const queueSpy = vi.spyOn(loopPayload.jobs, 'queue')
    const opts = {
      ...basePluginOptions,
      knowledgePools: {
        default: {
          ...basePluginOptions.knowledgePools.default,
          bulkEmbeddings: createMockBulkEmbeddings({ statusSequence: ['running', 'succeeded'] }),
        },
      },
    }
    const post = await loopPayload.create({ collection: 'posts', data: { title: 'Loop' } as any })
    await waitForBulkJobs(loopPayload)
    expect(queueSpy).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'payloadcms-vectorize:poll-or-complete-bulk-embedding' }),
    )
    await waitForBulkJobs(loopPayload)
    const embeds = await loopPayload.find({
      collection: 'default',
      where: { docId: { equals: String(post.id) } },
    })
    expect(embeds.totalDocs).toBe(1)
  })

  test('failed polling stops and does not complete embeddings', async () => {
    await clearAllCollections(payload)
    const failedPayload = await buildPayload({
      ...basePluginOptions,
      knowledgePools: {
        default: {
          ...basePluginOptions.knowledgePools.default,
          bulkEmbeddings: createMockBulkEmbeddings({ statusSequence: ['failed'] }),
        },
      },
    })
    const post = await failedPayload.create({ collection: 'posts', data: { title: 'Fail' } as any })
    await waitForBulkJobs(failedPayload)
    const embeds = await failedPayload.find({
      collection: 'default',
      where: { docId: { equals: String(post.id) } },
    })
    expect(embeds.totalDocs).toBe(0)
  })

  test('canceled polling stops', async () => {
    await clearAllCollections(payload)
    const canceledPayload = await buildPayload({
      ...basePluginOptions,
      knowledgePools: {
        default: {
          ...basePluginOptions.knowledgePools.default,
          bulkEmbeddings: createMockBulkEmbeddings({ statusSequence: ['canceled'] }),
        },
      },
    })
    const post = await canceledPayload.create({
      collection: 'posts',
      data: { title: 'Cancel' } as any,
    })
    await waitForBulkJobs(canceledPayload)
    const embeds = await canceledPayload.find({
      collection: 'default',
      where: { docId: { equals: String(post.id) } },
    })
    expect(embeds.totalDocs).toBe(0)
  })

  test('stores metadata records for inputs before provider submit', async () => {
    await clearAllCollections(payload)
    const metaPayload = await buildPayload({
      ...basePluginOptions,
      knowledgePools: {
        default: {
          ...basePluginOptions.knowledgePools.default,
          extensionFields: [{ name: 'category', type: 'text' }],
          collections: {
            posts: {
              toKnowledgePool: async (doc: any) => [{ chunk: doc.title, category: 'tech' }],
            },
          },
        },
      },
    })
    const createSpy = vi.spyOn(metaPayload, 'create')
    await metaPayload.create({ collection: 'posts', data: { title: 'Meta' } as any })
    await waitForBulkJobs(metaPayload)
    expect(
      createSpy.mock.calls.some(
        (call) =>
          call[0]?.collection === BULK_EMBEDDINGS_INPUT_METADATA_SLUG && call[0]?.data?.inputId,
      ),
    ).toBe(true)
    createSpy.mockRestore()
  })

  test('extension fields are merged when writing embeddings from metadata table', async () => {
    await clearAllCollections(payload)
    const metaPayload = await buildPayload({
      ...basePluginOptions,
      knowledgePools: {
        default: {
          ...basePluginOptions.knowledgePools.default,
          extensionFields: [
            { name: 'category', type: 'text' },
            { name: 'priority', type: 'number' },
          ],
          collections: {
            posts: {
              toKnowledgePool: async (doc: any) => [
                { chunk: doc.title, category: 'tech', priority: 3 },
              ],
            },
          },
        },
      },
    })
    const post = await metaPayload.create({
      collection: 'posts',
      data: { title: 'Ext merge' } as any,
    })
    await waitForBulkJobs(metaPayload)
    const embeds = await metaPayload.find({
      collection: 'default',
      where: { docId: { equals: String(post.id) } },
    })
    expect(embeds.totalDocs).toBe(1)
    expect(embeds.docs[0]).toHaveProperty('category', 'tech')
    expect(embeds.docs[0]).toHaveProperty('priority', 3)
  })

  test('multiple chunks keep their respective extension fields', async () => {
    await clearAllCollections(payload)
    const multiPayload = await buildPayload({
      ...basePluginOptions,
      knowledgePools: {
        default: {
          ...basePluginOptions.knowledgePools.default,
          extensionFields: [
            { name: 'category', type: 'text' },
            { name: 'priority', type: 'number' },
          ],
          collections: {
            posts: {
              toKnowledgePool: async () => [
                { chunk: 'Chunk 1', category: 'a', priority: 1 },
                { chunk: 'Chunk 2', category: 'b', priority: 2 },
              ],
            },
          },
        },
      },
    })
    const post = await multiPayload.create({
      collection: 'posts',
      data: { title: 'Two' } as any,
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

  test('metadata table is cleaned after successful completion', async () => {
    await clearAllCollections(payload)
    const cleanPayload = await buildPayload({
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
    await waitForBulkJobs(cleanPayload)
    const metadata = await cleanPayload.find({
      collection: BULK_EMBEDDINGS_INPUT_METADATA_SLUG,
      where: { run: { exists: true } },
    })
    expect(metadata.totalDocs).toBe(0)
  })

  test('realtime ingest mode still queues vectorize jobs', async () => {
    const realtimeOptions = {
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
            ingestMode: 'realtime' as const,
            prepareBulkEmbeddings: async () => ({
              providerBatchId: 'noop',
              status: 'succeeded' as const,
              counts: { inputs: 0, succeeded: 0, failed: 0 },
            }),
            pollBulkEmbeddings: async () => ({ status: 'succeeded' }),
            completeBulkEmbeddings: async () => ({
              status: 'succeeded' as const,
              outputs: [],
              counts: { inputs: 0 },
            }),
          },
        },
      },
      bulkQueueNames: BULK_QUEUE_NAMES,
    }

    const realtimePayload = await buildPayload(realtimeOptions as any)
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
  })*/
})
