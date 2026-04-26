// adapters/mongodb/dev/specs/extensionFields.spec.ts
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { MongoClient } from 'mongodb'
import type { BasePayload } from 'payload'
import type { DbAdapter } from 'payloadcms-vectorize'
import { DIMS, MONGO_URI } from './constants.js'
import { buildMongoTestPayload, teardownDbs } from './utils.js'
import { makeDummyEmbedDocs, makeDummyEmbedQuery, testEmbeddingVersion } from '@shared-test/helpers/embed'

const DB = `mongo_extension_fields_${Date.now()}`

describe('Extension fields (mongodb)', () => {
  let payload: BasePayload
  let adapter: DbAdapter

  beforeAll(async () => {
    const built = await buildMongoTestPayload({
      uri: MONGO_URI,
      dbName: DB,
      pools: {
        default: {
          dimensions: DIMS,
          filterableFields: ['category', 'priority'],
        },
      },
      collections: [
        {
          slug: 'posts',
          fields: [
            { name: 'title', type: 'text' },
            { name: 'category', type: 'text' },
            { name: 'priority', type: 'number' },
          ],
        },
      ],
      knowledgePools: {
        default: {
          collections: {},
          extensionFields: [
            { name: 'category', type: 'text' },
            { name: 'priority', type: 'number' },
          ],
          embeddingConfig: {
            version: testEmbeddingVersion,
            queryFn: makeDummyEmbedQuery(DIMS),
            realTimeIngestionFn: makeDummyEmbedDocs(DIMS),
          },
        },
      },
    })
    payload = built.payload
    adapter = built.adapter
  })

  afterAll(async () => {
    await teardownDbs(payload, MONGO_URI, DB)
  })

  test('search index declares extension fields as filterable', async () => {
    await adapter.storeChunk(payload, 'default', {
      sourceCollection: 'posts',
      docId: 'doc-bootstrap',
      chunkIndex: 0,
      chunkText: 'bootstrap',
      embeddingVersion: testEmbeddingVersion,
      embedding: Array(DIMS).fill(0.1),
      extensionFields: { category: 'cat-a', priority: 1 },
    })

    const c = new MongoClient(MONGO_URI)
    await c.connect()
    const indexes = (await c
      .db(`${DB}_vectors`)
      .collection('vectorize_default')
      .listSearchIndexes('vectorize_default_idx')
      .toArray()) as Array<{ latestDefinition: { fields: Array<{ type: string; path: string }> } }>
    await c.close()

    const def = indexes[0]?.latestDefinition
    expect(def).toBeDefined()
    const filterPaths = def!.fields.filter((f) => f.type === 'filter').map((f) => f.path)
    expect(filterPaths).toContain('sourceCollection')
    expect(filterPaths).toContain('docId')
    expect(filterPaths).toContain('embeddingVersion')
    expect(filterPaths).toContain('category')
    expect(filterPaths).toContain('priority')
  }, 90_000)

  test('extensionFields are persisted on the chunk document and returned by search', async () => {
    const target = Array(DIMS).fill(0.42)
    await adapter.storeChunk(payload, 'default', {
      sourceCollection: 'posts',
      docId: 'doc-1',
      chunkIndex: 0,
      chunkText: 'hello',
      embeddingVersion: testEmbeddingVersion,
      embedding: target,
      extensionFields: { category: 'cat-a', priority: 7 },
    })

    await new Promise((r) => setTimeout(r, 1500))

    const r = await adapter.search(payload, target, 'default', 5)
    const hit = r.find((x) => x.docId === 'doc-1')
    expect(hit).toBeDefined()
    expect((hit as any).category).toBe('cat-a')
    expect((hit as any).priority).toBe(7)
  }, 90_000)
})
