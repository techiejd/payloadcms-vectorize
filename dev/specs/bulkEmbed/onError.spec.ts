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
import { createMockAdapter } from 'helpers/mockAdapter.js'

const DIMS = DEFAULT_DIMS
const dbName = `bulk_onerror_${Date.now()}`

describe('Bulk embed - onError callback', () => {
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
    const built = await buildPayloadWithIntegration({
      dbName,
      pluginOpts: {
        dbAdapter: createMockAdapter(),
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
        bulkQueueNames: BULK_QUEUE_NAMES,
      },
      key: `onerror-${Date.now()}`,
    })
    payload = built.payload
  })

  test('onError callback is called when batch fails', async () => {
    await payload.create({ collection: 'posts', data: { title: 'Error Test' } as any })

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

    expect(onErrorCalled).toBe(true)
    expect(onErrorArgs).not.toBeNull()
    expect(onErrorArgs!.providerBatchIds.length).toBeGreaterThan(0)
    expect(onErrorArgs!.error).toBeInstanceOf(Error)
    expect(onErrorArgs!.error.message).toContain('failed')
  })
})


