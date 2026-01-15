import type { Payload } from 'payload'
import { beforeAll, describe, expect, test } from 'vitest'
import { BULK_EMBEDDINGS_RUNS_SLUG } from '../../../src/collections/bulkEmbeddingsRuns.js'
import {
  BULK_QUEUE_NAMES,
  DEFAULT_DIMS,
  buildPayloadWithIntegration,
  createMockBulkEmbeddings,
  createTestDb,
  expectGoodResult,
  waitForBulkJobs,
} from '../utils.js'
import { makeDummyEmbedQuery, testEmbeddingVersion } from 'helpers/embed.js'
import { getVectorizedPayload } from 'payloadcms-vectorize'

const DIMS = DEFAULT_DIMS
const dbName = `bulk_partial_failure_nofail_${Date.now()}`

describe('Bulk embed - partial failures', () => {
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

  test('run with no partial failures does not call onError', async () => {
    // Reset state
    onErrorCalled = false
    onErrorArgs = null

    // Use unique version to ensure this test only processes its own data
    const testVersion = `${testEmbeddingVersion}-nofail-${Date.now()}`

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
              version: testVersion,
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
      key: `no-partial-failure-${Date.now()}-${Math.random()}`,
    })
    payload = built.payload

    await payload.create({ collection: 'posts', data: { title: 'No Failure Test' } as any })

    const vectorizedPayload = getVectorizedPayload(payload)
    const result = await vectorizedPayload?.bulkEmbed({ knowledgePool: 'default' })
    expectGoodResult(result)

    await waitForBulkJobs(payload)

    // Check run status
    const updatedRun = await payload.findByID({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      id: result!.runId,
    })

    expect(updatedRun.status).toBe('succeeded')
    expect(updatedRun.failed).toBe(0)
    expect(updatedRun.failedChunkData).toBeNull()

    // onError should NOT be called when everything succeeds
    expect(onErrorCalled).toBe(false)
  })
})
