import { describe, expect, test } from 'vitest'
import { buildConfig, getPayload } from 'payload'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { buildDummyConfig, dummyPluginOptions } from './constants.js'
import payloadcmsVectorize, { getVectorizedPayload } from 'payloadcms-vectorize'
import { createMockAdapter } from 'helpers/mockAdapter.js'
import { createTestDb } from './utils.js'

describe('jobs.tasks merging', () => {
  test('adds tasks when none provided', async () => {
    const cfg = await buildDummyConfig({ jobs: { tasks: [] } })
    const tasks = cfg.jobs?.tasks
    expect(Array.isArray(tasks)).toBe(true)
    expect(tasks).toEqual(
      expect.arrayContaining([
        { slug: 'payloadcms-vectorize:vectorize', handler: expect.any(Function) },
        { slug: 'payloadcms-vectorize:prepare-bulk-embedding', handler: expect.any(Function) },
        {
          slug: 'payloadcms-vectorize:poll-or-complete-bulk-embedding',
          handler: expect.any(Function),
        },
      ]),
    )
  })
})

describe('endpoints: /vector-search, /vector-bulk-embed', () => {
  test('adds the endpoints by default', async () => {
    const cfg = await buildDummyConfig({})
    const endpoints = cfg.endpoints
    expect(Array.isArray(endpoints)).toBe(true)
    expect(endpoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/vector-search',
          method: 'post',
          handler: expect.any(Function),
        }),
        expect.objectContaining({
          path: '/vector-bulk-embed',
          method: 'post',
          handler: expect.any(Function),
        }),
      ]),
    )
  })
  test('does not add the endpoint when disabled', async () => {
    const cfg = await buildDummyConfig({
      plugins: [
        payloadcmsVectorize({ ...dummyPluginOptions, endpointOverrides: { enabled: false } }),
      ],
    })
    const endpoints = cfg.endpoints
    expect(Array.isArray(endpoints)).toBe(true)
    expect(endpoints).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/vector-search',
          method: 'post',
          handler: expect.any(Function),
        }),
        expect.objectContaining({
          path: '/vector-bulk-embed',
          method: 'post',
          handler: expect.any(Function),
        }),
        expect.objectContaining({
          path: '/vector-retry-failed-batch',
          method: 'post',
          handler: expect.any(Function),
        }),
      ]),
    )
  })
  test('uses the custom path when provided', async () => {
    // TODO: Add test for custom path for bulk embed and retry failed batch
    const cfg = await buildDummyConfig({
      plugins: [
        payloadcmsVectorize({ ...dummyPluginOptions, endpointOverrides: { path: '/custom-path' } }),
      ],
    })
    const endpoints = cfg.endpoints
    expect(Array.isArray(endpoints)).toBe(true)
    expect(endpoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/custom-path',
          method: 'post',
          handler: expect.any(Function),
        }),
      ]),
    )
  })

  test('bins are added to the config', async () => {
    const testBins = [
      { key: 'test:bin', scriptPath: '/path/to/script.js' },
      { key: 'another:bin', scriptPath: '/path/to/another.js' },
    ]

    const dbAdapter = createMockAdapter({ bins: testBins })

    const cfg = await buildConfig({
      secret: 'test-secret',
      collections: [],
      editor: lexicalEditor(),
      db: {} as any,
      plugins: [
        payloadcmsVectorize({
          dbAdapter,
          knowledgePools: {
            default: {
              collections: {},
              embeddingConfig: {
                version: 'test',
                queryFn: async () => [0, 0, 0, 0, 0, 0, 0, 0],
                realTimeIngestionFn: async (texts) => texts.map(() => [0, 0, 0, 0, 0, 0, 0, 0]),
              },
            },
          },
        }),
      ],
    })

    expect(cfg.bin).toBeDefined()
    expect(cfg.bin).toEqual(expect.arrayContaining(testBins))
  })

  test('custom dict is retrievable when provided', async () => {
    const dbName = 'config_custom_dict_test'
    await createTestDb({ dbName })

    const testCustom = {
      myKey: 'myValue',
      anotherKey: { nested: true },
    }

    const dbAdapter = createMockAdapter({ custom: testCustom })

    const cfg = await buildConfig({
      secret: 'test-secret',
      collections: [],
      editor: lexicalEditor(),
      db: postgresAdapter({
        pool: {
          connectionString: `postgresql://postgres:password@localhost:5433/${dbName}`,
        },
      }),
      plugins: [
        payloadcmsVectorize({
          dbAdapter,
          knowledgePools: {
            default: {
              collections: {},
              extensionFields: [{ type: 'text', name: 'textField' }],
              embeddingConfig: {
                version: 'test',
                queryFn: async () => [0, 0, 0, 0, 0, 0, 0, 0],
                realTimeIngestionFn: async (texts) => texts.map(() => [0, 0, 0, 0, 0, 0, 0, 0]),
              },
            },
          },
        }),
      ],
    })

    const vectorizedPayload = getVectorizedPayload(await getPayload({ config: cfg }))
    expect(vectorizedPayload).toBeDefined()
    expect(vectorizedPayload!.getDbAdapterCustom()).toEqual(expect.objectContaining(testCustom))
  })

  test('infra collections (bulk embedding runs, batches, input metadata) are added to list of collections', async () => {
    const cfg = await buildDummyConfig({})

    const collectionSlugs = cfg.collections.map((c) => c.slug)

    // Bulk embedding runs collection
    expect(collectionSlugs).toContain('vector-bulk-embeddings-runs')

    // Bulk embedding batches collection
    expect(collectionSlugs).toContain('vector-bulk-embeddings-batches')

    // Bulk embedding input metadata collection
    expect(collectionSlugs).toContain('vector-bulk-embedding-input-metadata')
  })

  test('embedding collection w/ extensionFields are added to list of collections', async () => {
    const dbAdapter = createMockAdapter()

    const cfg = await buildConfig({
      secret: 'test-secret',
      collections: [],
      editor: lexicalEditor(),
      db: {} as any,
      plugins: [
        payloadcmsVectorize({
          dbAdapter,
          knowledgePools: {
            default: {
              collections: {},
              extensionFields: [
                { name: 'customField', type: 'text' },
                { name: 'anotherField', type: 'number' },
              ],
              embeddingConfig: {
                version: 'test',
                queryFn: async () => [0, 0, 0, 0, 0, 0, 0, 0],
                realTimeIngestionFn: async (texts) => texts.map(() => [0, 0, 0, 0, 0, 0, 0, 0]),
              },
            },
          },
        }),
      ],
    })

    // Find the default embedding collection
    const embeddingCollection = cfg.collections.find((c) => c.slug === 'default')
    expect(embeddingCollection).toBeDefined()

    // Check that extension fields are present
    const fieldNames = embeddingCollection!.fields.map((f: any) => f.name).filter(Boolean)
    expect(fieldNames).toContain('customField')
    expect(fieldNames).toContain('anotherField')

    // Also verify the built-in fields are present
    expect(fieldNames).toContain('sourceCollection')
    expect(fieldNames).toContain('docId')
    expect(fieldNames).toContain('chunkIndex')
    expect(fieldNames).toContain('chunkText')
    expect(fieldNames).toContain('embeddingVersion')
  })
})
