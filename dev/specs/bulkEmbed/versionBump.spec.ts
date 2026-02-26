import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  BULK_QUEUE_NAMES,
  DEFAULT_DIMS,
  buildPayloadWithIntegration,
  createMockBulkEmbeddings,
  createTestDb,
  destroyPayload,
  waitForBulkJobs,
} from '../utils.js'
import { makeDummyEmbedQuery } from 'helpers/embed.js'
import { getVectorizedPayload } from '../../../src/types.js'
import { expectGoodResult } from '../utils.vitest.js'
import { createMockAdapter } from 'helpers/mockAdapter.js'
import type { Payload } from 'payload'

const DIMS = DEFAULT_DIMS
const dbName = `bulk_version_${Date.now()}`

describe('Bulk embed - version bump', () => {
  let payload: Payload
  let knowledgePools: any

  beforeAll(async () => {
    await createTestDb({ dbName })

    knowledgePools = {
      default: {
        collections: {
          posts: {
            toKnowledgePool: async (doc: any) => [{ chunk: doc.title }],
          },
        },
        embeddingConfig: {
          version: 'old-version',
          queryFn: makeDummyEmbedQuery(DIMS),
          bulkEmbeddingsFns: createMockBulkEmbeddings({ statusSequence: ['succeeded'] }),
        },
      },
    }

    payload = (
      await buildPayloadWithIntegration({
        dbName,
        pluginOpts: {
          dbAdapter: createMockAdapter(),
          knowledgePools,
          bulkQueueNames: BULK_QUEUE_NAMES,
        },
        key: `version-bump-${Date.now()}`,
      })
    ).payload
  })

  afterAll(async () => {
    await destroyPayload(payload)
  })

  test('version bump re-embeds all even without updates', async () => {
    // Phase 1: Bulk embed with old-version
    const post = await payload.create({ collection: 'posts', data: { title: 'Old' } as any })

    const vp = getVectorizedPayload(payload)
    const result0 = await vp?.bulkEmbed({ knowledgePool: 'default' })
    expectGoodResult(result0)

    await waitForBulkJobs(payload, 30000)

    const embeds0 = await payload.find({
      collection: 'default',
      where: { docId: { equals: String(post.id) } },
    })
    expect(embeds0.totalDocs).toBe(1)
    expect(embeds0.docs[0].embeddingVersion).toBe('old-version')

    // Phase 2: Mutate config to new-version and re-embed
    knowledgePools.default.embeddingConfig.version = 'new-version'
    knowledgePools.default.embeddingConfig.bulkEmbeddingsFns = createMockBulkEmbeddings({
      statusSequence: ['succeeded'],
    })

    const result1 = await vp?.bulkEmbed({ knowledgePool: 'default' })
    expectGoodResult(result1)

    await waitForBulkJobs(payload, 30000)

    const embeds1 = await payload.find({
      collection: 'default',
      where: { docId: { equals: String(post.id) } },
    })
    expect(embeds1.totalDocs).toBe(1)
    expect(embeds1.docs[0].embeddingVersion).toBe('new-version')
  })
})
