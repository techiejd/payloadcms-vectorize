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
import { getVectorizedPayload } from 'payloadcms-vectorize'
import { expectGoodResult } from '../utils.vitest.js'

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
  })

  test('partial chunk failures are tracked and passed to onError', async () => {
    // Reset state
    onErrorCalled = false
    onErrorArgs = null

    // Use unique version to ensure this test only processes its own data
    const testVersion = `${testEmbeddingVersion}-partial-${Date.now()}`

    // Use a function-based failure check to avoid needing to know docId ahead of time
    // Fail any chunk with index 1 (second chunk of any doc)
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
              version: testVersion,
              queryFn: makeDummyEmbedQuery(DIMS),
              bulkEmbeddingsFns: createMockBulkEmbeddings(
                {
                  statusSequence: ['succeeded'],
                  // Fail any chunk with index 1 (second chunk) - ID format is collection:docId:chunkIndex
                  partialFailure: { shouldFail: (id: string) => id.endsWith(':1') },
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
      key: `partial-failure-${Date.now()}-${Math.random()}`,
    })
    payload = built.payload

    // Create a post with 2 chunks
    const post = await payload.create({
      collection: 'posts',
      data: { title: 'Partial Failure Test' } as any,
    })

    const vectorizedPayload = getVectorizedPayload(payload)
    const result = await vectorizedPayload?.bulkEmbed({ knowledgePool: 'default' })
    expectGoodResult(result)

    await waitForBulkJobs(payload)

    // Check run status - should still succeed but with failed count
    const updatedRun = await payload.findByID({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      id: result!.runId,
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
})
