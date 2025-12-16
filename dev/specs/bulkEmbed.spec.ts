import type { Payload, SanitizedConfig } from 'payload'

import { buildConfig, getPayload } from 'payload'
import { beforeAll, describe, expect, test } from 'vitest'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { createVectorizeIntegration } from 'payloadcms-vectorize'
import { BULK_EMBEDDINGS_RUNS_SLUG } from '../../src/collections/bulkEmbeddingsRuns.js'
import { createBulkEmbedAllTask } from '../../src/tasks/bulkEmbedAll.js'
import { createTestDb } from './utils.js'
import {
  makeDummyEmbedDocs,
  makeDummyEmbedQuery,
  makeLocalBulkEmbeddingsCallbacks,
  testEmbeddingVersion,
} from 'helpers/embed.js'

const DIMS = 8

describe('Bulk embed ingest mode', () => {
  let payload: Payload
  let config: SanitizedConfig
  const dbName = 'bulk_embed_test'

  const integration = createVectorizeIntegration({
    default: {
      dims: DIMS,
      ivfflatLists: 1,
    },
  })

  const pluginOptions = {
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
        bulkEmbeddings: {
          ...makeLocalBulkEmbeddingsCallbacks(DIMS),
          ingestMode: 'bulk' as const,
        },
      },
    },
  }

  beforeAll(async () => {
    await createTestDb({ dbName })
    config = await buildConfig({
      secret: 'test-secret',
      editor: lexicalEditor(),
      collections: [
        {
          slug: 'posts',
          fields: [{ name: 'title', type: 'text' }],
        },
      ],
      db: postgresAdapter({
        extensions: ['vector'],
        afterSchemaInit: [integration.afterSchemaInitHook],
        pool: {
          connectionString: `postgresql://postgres:password@localhost:5433/${dbName}`,
        },
      }),
      plugins: [integration.payloadcmsVectorize(pluginOptions)],
      jobs: { tasks: [] },
    })

    payload = await getPayload({ config })
  })

  test('queues no realtime embeddings and bulk job backfills missing docs', async () => {
    const post = await payload.create({
      collection: 'posts',
      data: { title: 'Bulk Mode Title' } as any,
    })

    const initialEmbeds = await payload.find({
      collection: 'default',
      where: {
        and: [{ sourceCollection: { equals: 'posts' } }, { docId: { equals: String(post.id) } }],
      },
    })
    expect(initialEmbeds.totalDocs).toBe(0)

    const run = await payload.create({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      data: {
        pool: 'default',
        embeddingVersion: testEmbeddingVersion,
        status: 'queued',
      },
    })

    const bulkTask = createBulkEmbedAllTask({
      knowledgePools: pluginOptions.knowledgePools,
    })

    await bulkTask.handler({
      input: { runId: String(run.id) },
      req: { payload } as any,
    })

    const embeds = await payload.find({
      collection: 'default',
      where: {
        and: [{ sourceCollection: { equals: 'posts' } }, { docId: { equals: String(post.id) } }],
      },
    })
    expect(embeds.totalDocs).toBeGreaterThan(0)
    expect(embeds.docs[0]?.chunkText).toContain('Bulk Mode Title')

    const runDoc = await payload.findByID({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      id: run.id,
    })
    expect(runDoc.status).toBe('succeeded')
    expect(runDoc.inputs).toBeGreaterThan(0)
  })

  test('document updates clear stale embeddings and rerun populates new chunks', async () => {
    const post = await payload.create({
      collection: 'posts',
      data: { title: 'Original' } as any,
    })

    // First run to embed
    const firstRun = await payload.create({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      data: {
        pool: 'default',
        embeddingVersion: testEmbeddingVersion,
        status: 'queued',
      },
    })
    const bulkTask = createBulkEmbedAllTask({
      knowledgePools: pluginOptions.knowledgePools,
    })
    await bulkTask.handler({
      input: { runId: String(firstRun.id) },
      req: { payload } as any,
    })

    // Update document - should delete embeddings in bulk mode
    await payload.update({
      collection: 'posts',
      id: post.id,
      data: { title: 'Updated Title' } as any,
    })

    const afterUpdateEmbeds = await payload.find({
      collection: 'default',
      where: {
        and: [{ sourceCollection: { equals: 'posts' } }, { docId: { equals: String(post.id) } }],
      },
    })
    expect(afterUpdateEmbeds.totalDocs).toBe(0)

    // Run again to backfill
    const secondRun = await payload.create({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      data: {
        pool: 'default',
        embeddingVersion: testEmbeddingVersion,
        status: 'queued',
      },
    })
    await bulkTask.handler({
      input: { runId: String(secondRun.id) },
      req: { payload } as any,
    })

    const embedsAfterRerun = await payload.find({
      collection: 'default',
      where: {
        and: [{ sourceCollection: { equals: 'posts' } }, { docId: { equals: String(post.id) } }],
      },
    })
    expect(embedsAfterRerun.totalDocs).toBeGreaterThan(0)
    expect(embedsAfterRerun.docs[0]?.chunkText).toContain('Updated Title')
  })
})
