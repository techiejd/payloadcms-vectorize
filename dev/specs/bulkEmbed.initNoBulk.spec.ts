import type { Payload } from 'payload'
import { describe, expect, test } from 'vitest'
import {
  BULK_QUEUE_NAMES,
  DEFAULT_DIMS,
  buildPayloadWithIntegration,
  clearAllCollections,
  createMockBulkEmbeddings,
  createTestDb,
  waitForBulkJobs,
} from './utils.js'
import { makeDummyEmbedDocs, makeDummyEmbedQuery, testEmbeddingVersion } from 'helpers/embed.js'
import { BULK_EMBEDDINGS_RUNS_SLUG } from '../../src/collections/bulkEmbeddingsRuns.js'

const DIMS = DEFAULT_DIMS

describe('Bulk embed init without bulk', () => {
  let payload: Payload
  const dbName = 'bulk_embed_init_toggle'

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
        bulkEmbeddings: createMockBulkEmbeddings({ statusSequence: ['succeeded'] }, DIMS),
      },
    },
    bulkQueueNames: BULK_QUEUE_NAMES,
  }

  // NOTE: skipped because Payload caches the first getPayload() instance per process,
  // so toggling bulk on/off in a single process cannot be simulated reliably.
  // Keep this isolated spec for future process-isolated runs.
  test('enabling bulk later queues first run automatically', async () => {
    await createTestDb({ dbName })

    // Build without bulk (plugin disabled so no hooks/onInit work)
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
    const { payload: noBulkPayload } = await buildPayloadWithIntegration({
      dbName,
      pluginOpts: noBulkOptions,
      dims: DIMS,
      key: `noBulkPayload-${dbName}-${Date.now()}`,
    })
    await clearAllCollections(noBulkPayload)
    await noBulkPayload.create({ collection: 'posts', data: { title: 'NoBulk' } as any })
    const none = await (noBulkPayload as any).find({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      where: { pool: { equals: 'default' } },
    })
    expect(none.totalDocs).toBe(0)

    // Rebuild with bulk enabled; onInit should queue the first run
    const { payload: bulkPayload } = await buildPayloadWithIntegration({
      dbName,
      pluginOpts: basePluginOptions,
      dims: DIMS,
      key: `bulkPayload-${dbName}-${Date.now()}`,
    })
    payload = bulkPayload
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
})
