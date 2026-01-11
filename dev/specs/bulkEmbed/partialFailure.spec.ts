import type { Payload } from 'payload'
import { beforeAll, describe, expect, test } from 'vitest'
import { BULK_EMBEDDINGS_RUNS_SLUG } from '../../../src/collections/bulkEmbeddingsRuns.js'
import {
  BULK_QUEUE_NAMES,
  DEFAULT_DIMS,
  buildPayloadWithIntegration,
  createMockBulkEmbeddings,
  createTestDb,
  waitForBulkJobs,
} from '../utils.js'
import { makeDummyEmbedQuery, testEmbeddingVersion } from 'helpers/embed.js'

const DIMS = DEFAULT_DIMS
const dbName = `bulk_partial_failure_${Date.now()}`

describe('Bulk embed - partial chunk failures', () => {
  let payload: Payload
  let onErrorCalled = false
  let onErrorArgs: {
    providerBatchIds: string[]
    error: Error
    failedChunkData?: Array<{ collection: string; documentId: string; chunkIndex: number }>
    failedChunkCount?: number
  } | null = null

  beforeAll(async () => {
    await createTestDb({ dbName })
    // We'll set up the payload dynamically in each test to control failIds
  })

  test('partial chunk failures are tracked and passed to onError', async () => {
    // Reset state
    onErrorCalled = false
    onErrorArgs = null

    // The ID format is collectionSlug:docId:chunkIndex
    // We need to fail a specific chunk - but we don't know the docId yet
    // So we'll create the payload with a dynamic failIds check

    const built = await buildPayloadWithIntegration({
      dbName,
      pluginOpts: {
        knowledgePools: {
          default: {
            collections: {
              posts: {
                toKnowledgePool: async (doc: any) => [
                  { chunk: doc.title },
                  { chunk: doc.title + ' chunk2' },
                ],
              },
            },
            embeddingConfig: {
              version: testEmbeddingVersion,
              queryFn: makeDummyEmbedQuery(DIMS),
              bulkEmbeddingsFns: createMockBulkEmbeddings(
                {
                  statusSequence: ['succeeded'],
                  // We'll fail chunks that contain ":1" (second chunk of any doc)
                  partialFailure: { failIds: [] }, // Will be updated below
                  onErrorCallback: (args) => {
                    onErrorCalled = true
                    onErrorArgs = args
                  },
                },
                DIMS,
              ),
            },
          },
        },
        bulkQueueNames: BULK_QUEUE_NAMES,
      },
      secret: 'test-secret',
      dims: DIMS,
      key: `partial-failure-${Date.now()}`,
    })
    payload = built.payload

    // Create a post
    const post = await payload.create({
      collection: 'posts',
      data: { title: 'Partial Failure Test' } as any,
    })

    // Now we know the docId, update the mock to fail the second chunk
    const failChunkId = `posts:${post.id}:1`

    // Re-create with the correct failIds
    const built2 = await buildPayloadWithIntegration({
      dbName,
      pluginOpts: {
        knowledgePools: {
          default: {
            collections: {
              posts: {
                toKnowledgePool: async (doc: any) => [
                  { chunk: doc.title },
                  { chunk: doc.title + ' chunk2' },
                ],
              },
            },
            embeddingConfig: {
              version: testEmbeddingVersion + '-v2',
              queryFn: makeDummyEmbedQuery(DIMS),
              bulkEmbeddingsFns: createMockBulkEmbeddings(
                {
                  statusSequence: ['succeeded'],
                  partialFailure: { failIds: [failChunkId] },
                  onErrorCallback: (args) => {
                    onErrorCalled = true
                    onErrorArgs = args
                  },
                },
                DIMS,
              ),
            },
          },
        },
        bulkQueueNames: BULK_QUEUE_NAMES,
      },
      secret: 'test-secret',
      dims: DIMS,
      key: `partial-failure-2-${Date.now()}`,
    })
    payload = built2.payload

    const run = await payload.create({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      data: { pool: 'default', embeddingVersion: testEmbeddingVersion + '-v2', status: 'queued' },
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

    // Check run status - should still succeed but with failed count
    const updatedRun = await payload.findByID({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      id: run.id,
    })

    expect(updatedRun.status).toBe('succeeded')
    expect(updatedRun.succeeded).toBe(1) // First chunk succeeded
    expect(updatedRun.failed).toBe(1) // Second chunk failed
    expect(updatedRun.failedChunkData).toBeDefined()
    expect(Array.isArray(updatedRun.failedChunkData)).toBe(true)
    expect(
      (
        updatedRun.failedChunkData as Array<{
          collection: string
          documentId: string
          chunkIndex: number
        }>
      ).length,
    ).toBe(1)
    const failedChunk = (
      updatedRun.failedChunkData as Array<{
        collection: string
        documentId: string
        chunkIndex: number
      }>
    )[0]
    expect(failedChunk.collection).toBe('posts')
    expect(failedChunk.documentId).toBe(String(post.id))
    expect(failedChunk.chunkIndex).toBe(1) // Second chunk (index 1)

    // Check onError callback was called with failed chunk info
    expect(onErrorCalled).toBe(true)
    expect(onErrorArgs).not.toBeNull()
    expect(onErrorArgs!.failedChunkData).toBeDefined()
    expect(onErrorArgs!.failedChunkData!.length).toBe(1)
    expect(onErrorArgs!.failedChunkData![0].collection).toBe('posts')
    expect(onErrorArgs!.failedChunkData![0].documentId).toBe(String(post.id))
    expect(onErrorArgs!.failedChunkData![0].chunkIndex).toBe(1)
    expect(onErrorArgs!.failedChunkCount).toBe(1)
    expect(onErrorArgs!.error.message).toContain('1 chunk(s) failed')
  })

  test('run with no partial failures does not call onError', async () => {
    // Reset state
    onErrorCalled = false
    onErrorArgs = null

    const built = await buildPayloadWithIntegration({
      dbName,
      pluginOpts: {
        knowledgePools: {
          default: {
            collections: {
              posts: {
                toKnowledgePool: async (doc: any) => [{ chunk: doc.title }],
              },
            },
            embeddingConfig: {
              version: testEmbeddingVersion + '-v3',
              queryFn: makeDummyEmbedQuery(DIMS),
              bulkEmbeddingsFns: createMockBulkEmbeddings(
                {
                  statusSequence: ['succeeded'],
                  // No partial failures
                  onErrorCallback: (args) => {
                    onErrorCalled = true
                    onErrorArgs = args
                  },
                },
                DIMS,
              ),
            },
          },
        },
        bulkQueueNames: BULK_QUEUE_NAMES,
      },
      secret: 'test-secret',
      dims: DIMS,
      key: `no-partial-failure-${Date.now()}`,
    })
    payload = built.payload

    await payload.create({ collection: 'posts', data: { title: 'No Failure Test' } as any })

    const run = await payload.create({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      data: { pool: 'default', embeddingVersion: testEmbeddingVersion + '-v3', status: 'queued' },
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

    // Check run status
    const updatedRun = await payload.findByID({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      id: run.id,
    })

    expect(updatedRun.status).toBe('succeeded')
    expect(updatedRun.failed).toBe(0)
    expect(updatedRun.failedChunkData).toBeNull()

    // onError should NOT be called when everything succeeds
    expect(onErrorCalled).toBe(false)
  })
})
