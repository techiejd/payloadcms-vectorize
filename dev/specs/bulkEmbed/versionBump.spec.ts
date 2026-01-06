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
import { makeDummyEmbedQuery } from 'helpers/embed.js'

const DIMS = DEFAULT_DIMS
const dbName = `bulk_version_${Date.now()}`

describe('Bulk embed - version bump', () => {
  let payload: Payload

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
              version: 'new-version',
              queryFn: makeDummyEmbedQuery(DIMS),
              bulkEmbeddingsFns: createMockBulkEmbeddings({ statusSequence: ['succeeded'] }),
            },
          },
        },
        bulkQueueNames: BULK_QUEUE_NAMES,
      },
      secret: 'test-secret',
      dims: DIMS,
      key: `version-${Date.now()}`,
    })
    payload = built.payload
  })

  test('version bump re-embeds all even without updates', async () => {
    const post = await payload.create({ collection: 'posts', data: { title: 'Old' } as any })

    // Create an embedding with old version manually
    await payload.create({
      collection: 'default',
      data: {
        docId: String(post.id),
        sourceCollection: 'posts',
        text: 'Old',
        chunkIndex: 0,
        embedding: Array(DIMS).fill(0.1),
        embeddingVersion: 'old-version',
        updatedAt: new Date().toISOString(),
      } as any,
    })

    // Run bulk embed with new version
    const run = await payload.create({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      data: { pool: 'default', embeddingVersion: 'new-version', status: 'queued' },
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

    // Should have 1 embedding with new version (old one replaced)
    const embeds = await payload.find({
      collection: 'default',
      where: { docId: { equals: String(post.id) } },
    })
    expect(embeds.totalDocs).toBe(1)
    expect(embeds.docs[0].embeddingVersion).toBe('new-version')

    const runDoc = (
      await (payload as any).find({
        collection: BULK_EMBEDDINGS_RUNS_SLUG,
        where: { id: { equals: String(run.id) } },
      })
    ).docs[0]
    expect(runDoc.inputs).toBe(1)
  })
})

