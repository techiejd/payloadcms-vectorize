import type { Payload } from 'payload'
import { beforeAll, describe, expect, test } from 'vitest'
import { BULK_EMBEDDINGS_RUNS_SLUG } from '../../../src/collections/bulkEmbeddingsRuns.js'
import type { VectorizedPayload } from '../../../src/types.js'
import {
  BULK_QUEUE_NAMES,
  DEFAULT_DIMS,
  buildPayloadWithIntegration,
  createMockBulkEmbeddings,
  createTestDb,
} from '../utils.js'
import { makeDummyEmbedQuery, testEmbeddingVersion } from 'helpers/embed.js'

const DIMS = DEFAULT_DIMS
const dbName = `bulk_concurrent_${Date.now()}`

describe('Bulk embed - concurrent runs prevention', () => {
  let payload: VectorizedPayload<'default'>

  beforeAll(async () => {
    await createTestDb({ dbName })
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
              version: testEmbeddingVersion,
              queryFn: makeDummyEmbedQuery(DIMS),
              bulkEmbeddingsFns: createMockBulkEmbeddings({
                statusSequence: ['queued', 'running'],
              }),
            },
          },
        },
        bulkQueueNames: BULK_QUEUE_NAMES,
      },
      secret: 'test-secret',
      dims: DIMS,
      key: `concurrent-${Date.now()}`,
    })
    payload = built.payload as VectorizedPayload<'default'>
  })

  test('cannot start concurrent bulk embed runs for the same pool', async () => {
    // Create a test post first
    await payload.create({
      collection: 'posts',
      data: { title: 'Concurrent test post' } as any,
    })

    // Create a run manually in 'running' status
    const existingRun = await (payload as any).create({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      data: {
        pool: 'default',
        embeddingVersion: testEmbeddingVersion,
        status: 'running',
      },
    })

    // Try to start another bulk embed for the same pool
    const result = await payload.bulkEmbed({ knowledgePool: 'default' })

    expect('conflict' in result && result.conflict).toBe(true)
    expect(result.status).toBe('running')
    expect(result.runId).toBe(String(existingRun.id))
    expect('message' in result && result.message).toContain('already running')

    // Cleanup: mark the run as succeeded so it doesn't interfere with other tests
    await (payload as any).update({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      id: existingRun.id,
      data: {
        status: 'succeeded',
        completedAt: new Date().toISOString(),
      },
    })
  })

  test('can start bulk embed run after previous run completes', async () => {
    // Create a test post
    await payload.create({
      collection: 'posts',
      data: { title: 'Sequential test post' } as any,
    })

    // Create a completed run
    await (payload as any).create({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      data: {
        pool: 'default',
        embeddingVersion: testEmbeddingVersion,
        status: 'succeeded',
        completedAt: new Date().toISOString(),
      },
    })

    // Should be able to start a new run for the same pool
    const result = await payload.bulkEmbed({ knowledgePool: 'default' })

    expect('conflict' in result).toBe(false)
    expect(result.status).toBe('queued')
    expect(result.runId).toBeDefined()

    // Cleanup: mark the new run as succeeded
    await (payload as any).update({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      id: result.runId,
      data: {
        status: 'succeeded',
        completedAt: new Date().toISOString(),
      },
    })
  })
})
