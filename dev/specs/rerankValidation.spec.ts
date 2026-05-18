import { describe, expect, test } from 'vitest'
import { buildConfig } from 'payload'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { makeDummyEmbedDocs, makeDummyEmbedQuery, testEmbeddingVersion } from 'helpers/embed.js'
import { createMockAdapter } from 'helpers/mockAdapter.js'
import payloadcmsVectorize, { type RerankFn } from 'payloadcms-vectorize'
import { DIMS } from './constants.js'

const dbName = 'rerank_validation_test'

const buildWithRerank = async (rerank: any) =>
  buildConfig({
    collections: [{ slug: 'posts', fields: [{ name: 'title', type: 'text' }] }],
    db: postgresAdapter({
      pool: {
        connectionString: `postgresql://postgres:password@localhost:5433/${dbName}`,
      },
    }),
    plugins: [
      payloadcmsVectorize({
        dbAdapter: createMockAdapter(),
        knowledgePools: {
          default: {
            collections: {
              posts: {
                toKnowledgePool: async (doc) => (doc.title ? [{ chunk: doc.title }] : []),
              },
            },
            embeddingConfig: {
              version: testEmbeddingVersion,
              queryFn: makeDummyEmbedQuery(DIMS),
              realTimeIngestionFn: makeDummyEmbedDocs(DIMS),
              rerank,
            },
          },
        },
      }),
    ],
    secret: 'rerank-validation-secret',
    jobs: { tasks: [] },
  })

const validCallback: RerankFn = async (_q, r) => r

describe('rerank config validation', () => {
  test('multiplier = 0 throws', async () => {
    await expect(buildWithRerank({ multiplier: 0, callback: validCallback })).rejects.toThrow(
      /multiplier/i,
    )
  })

  test('multiplier = -1 throws', async () => {
    await expect(buildWithRerank({ multiplier: -1, callback: validCallback })).rejects.toThrow(
      /multiplier/i,
    )
  })

  test('multiplier = NaN throws', async () => {
    await expect(buildWithRerank({ multiplier: NaN, callback: validCallback })).rejects.toThrow(
      /multiplier/i,
    )
  })

  test('multiplier = Infinity throws', async () => {
    await expect(
      buildWithRerank({ multiplier: Infinity, callback: validCallback }),
    ).rejects.toThrow(/multiplier/i)
  })

  test('callback not a function throws', async () => {
    await expect(buildWithRerank({ multiplier: 2, callback: 'nope' as any })).rejects.toThrow(
      /callback/i,
    )
  })

  test('valid config does not throw', async () => {
    await expect(
      buildWithRerank({ multiplier: 1.5, callback: validCallback }),
    ).resolves.toBeTruthy()
  })
})
