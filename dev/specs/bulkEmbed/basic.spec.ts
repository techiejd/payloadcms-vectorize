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
import { getVectorizedPayload, VectorizedPayload } from 'payloadcms-vectorize'
import { expectGoodResult } from '../utils.vitest.js'
import { createMockAdapter } from 'helpers/mockAdapter.js'

const DIMS = DEFAULT_DIMS
const dbName = `bulk_basic_${Date.now()}`

const basePluginOptions = {
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
        bulkEmbeddingsFns: createMockBulkEmbeddings({ statusSequence: ['succeeded'] }),
      },
    },
  },
  bulkQueueNames: BULK_QUEUE_NAMES,
}

describe('Bulk embed - basic tests', () => {
  let payload: Payload
  let config: SanitizedConfig
  let vectorizedPayload: VectorizedPayload | null = null

  beforeAll(async () => {
    await createTestDb({ dbName })
    const built = await buildPayloadWithIntegration({
      dbName,
      pluginOpts: basePluginOptions,
      key: `basic-${Date.now()}`,
    })
    payload = built.payload
    config = built.config
    vectorizedPayload = getVectorizedPayload(payload)
  })

  beforeEach(async () => {
    await clearAllCollections(payload)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
  })

  test('manually triggered bulk run embeds documents', async () => {
    const post = await payload.create({ collection: 'posts', data: { title: 'First' } as any })

    const result = await vectorizedPayload?.bulkEmbed({ knowledgePool: 'default' })
    expectGoodResult(result)

    await waitForBulkJobs(payload)

    const embeds = await payload.find({
      collection: 'default',
      where: { docId: { equals: String(post.id) } },
    })
    expect(embeds.totalDocs).toBe(1)
    const runDoc = (
      await (payload as any).find({
        collection: BULK_EMBEDDINGS_RUNS_SLUG,
        where: { id: { equals: String(result!.runId) } },
      })
    ).docs[0]
    expect(runDoc.status).toBe('succeeded')
  })

  test('bulk run creates batch records', async () => {
    await payload.create({ collection: 'posts', data: { title: 'Batch Test' } as any })
    const result = await vectorizedPayload?.bulkEmbed({ knowledgePool: 'default' })
    expectGoodResult(result)

    await waitForBulkJobs(payload)

    const batches = await payload.find({
      collection: BULK_EMBEDDINGS_BATCHES_SLUG as any,
      where: { run: { equals: String(result!.runId) } },
    })
    expect(batches.totalDocs).toBe(1)
    expect(batches.docs[0]).toHaveProperty('batchIndex', 0)
    expect(batches.docs[0]).toHaveProperty('status', 'succeeded')
  })

  test('no version bump and no updates → zero eligible and succeed', async () => {
    const post = await payload.create({ collection: 'posts', data: { title: 'Stable' } as any })

    // First bulk run
    const result0 = await vectorizedPayload?.bulkEmbed({ knowledgePool: 'default' })
    expectGoodResult(result0)
    await waitForBulkJobs(payload)

    const embeds = await payload.find({
      collection: 'default',
      where: { docId: { equals: String(post.id) } },
    })
    expect(embeds.totalDocs).toBe(1)

    // Second bulk run - should find zero eligible
    const result1 = await vectorizedPayload?.bulkEmbed({ knowledgePool: 'default' })
    expect(result1).toBeDefined()

    await waitForBulkJobs(payload)

    const runDoc = (
      await (payload as any).find({
        collection: BULK_EMBEDDINGS_RUNS_SLUG,
        where: { id: { equals: String(result1!.runId) } },
      })
    ).docs[0]
    expect(runDoc.status).toBe('succeeded')
    expect(runDoc.inputs).toBe(0)
    expect(runDoc.succeeded).toBe(0)
  })

  test('metadata table is cleaned after successful completion', async () => {
    await payload.create({ collection: 'posts', data: { title: 'Cleanup' } as any })

    await vectorizedPayload?.bulkEmbed({ knowledgePool: 'default' })

    await waitForBulkJobs(payload)

    const metadata = await payload.find({
      collection: BULK_EMBEDDINGS_INPUT_METADATA_SLUG,
      where: { run: { exists: true } },
    })
    expect(metadata.totalDocs).toBe(0)
  })
})
