import type { Payload, SanitizedConfig } from 'payload'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
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
const dbName = `bulk_should_embed_fn_${Date.now()}`

const basePluginOptions = {
  dbAdapter: createMockAdapter(),
  knowledgePools: {
    default: {
      collections: {
        posts: {
          shouldEmbedFn: async (doc: any) => !doc.title?.startsWith('SKIP'),
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

describe('Bulk embed - shouldEmbedFn', () => {
  let payload: Payload
  let config: SanitizedConfig
  let vectorizedPayload: VectorizedPayload | null = null

  beforeAll(async () => {
    await createTestDb({ dbName })
    const built = await buildPayloadWithIntegration({
      dbName,
      pluginOpts: basePluginOptions,
      key: `bulk-should-embed-${Date.now()}`,
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

  test('filtered-out document is not embedded during bulk run', async () => {
    await payload.create({ collection: 'posts', data: { title: 'SKIP me' } as any })
    const embeddedPost = await payload.create({
      collection: 'posts',
      data: { title: 'Embed me' } as any,
    })

    const result = await vectorizedPayload?.bulkEmbed({ knowledgePool: 'default' })
    expectGoodResult(result)

    await waitForBulkJobs(payload)

    // Only the allowed post should have embeddings
    const allEmbeddings = await payload.find({
      collection: 'default',
      where: { sourceCollection: { equals: 'posts' } },
    })
    expect(allEmbeddings.totalDocs).toBe(1)
    expect(allEmbeddings.docs[0]).toHaveProperty('docId', String(embeddedPost.id))
  })

  test('multiple filtered-out documents produce no embeddings while allowed ones do', async () => {
    await payload.create({ collection: 'posts', data: { title: 'SKIP first' } as any })
    await payload.create({ collection: 'posts', data: { title: 'SKIP second' } as any })
    const allowedPost = await payload.create({
      collection: 'posts',
      data: { title: 'Allowed post' } as any,
    })

    const result = await vectorizedPayload?.bulkEmbed({ knowledgePool: 'default' })
    expectGoodResult(result)

    await waitForBulkJobs(payload)

    const allEmbeddings = await payload.find({
      collection: 'default',
      where: { sourceCollection: { equals: 'posts' } },
    })
    expect(allEmbeddings.totalDocs).toBe(1)
    expect(allEmbeddings.docs[0]).toHaveProperty('docId', String(allowedPost.id))
  })
})
