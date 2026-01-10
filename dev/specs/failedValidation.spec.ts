import { postgresAdapter } from '@payloadcms/db-postgres'
import { buildConfig } from 'payload'
import { getPayload } from 'payload'
import { describe, expect, test } from 'vitest'

import { createVectorizeIntegration } from '../../src/index.js'
import { createTestDb, waitForVectorizationJobs } from './utils.js'

const DIMS = 8

const embedDocs = async (texts: string[]) => texts.map(() => Array(DIMS).fill(0))
const embedQuery = async (_text: string) => Array(DIMS).fill(0)

const { afterSchemaInitHook, payloadcmsVectorize } = createVectorizeIntegration({
  default: {
    dims: DIMS,
    ivfflatLists: 1,
  },
})

const buildMalformedConfig = async () => {
  await createTestDb({ dbName: 'failed_validation_test' })
  return buildConfig({
    jobs: {
      tasks: [],
      autoRun: [
        {
          cron: '*/5 * * * * *', // Run every 5 seconds
          limit: 10,
        },
      ],
    },
    collections: [
      {
        slug: 'posts',
        fields: [{ name: 'title', type: 'text' }],
      },
    ],
    db: postgresAdapter({
      extensions: ['vector'],
      afterSchemaInit: [afterSchemaInitHook],
      pool: {
        connectionString:
          process.env.DATABASE_URI ||
          'postgresql://postgres:password@localhost:5433/failed_validation_test',
      },
    }),
    plugins: [
      payloadcmsVectorize({
        knowledgePools: {
          default: {
            collections: {
              posts: {
                // Malformed: second entry missing required "chunk" string
                toKnowledgePool: async () => [{ chunk: 'ok chunk' }, { bad: 'oops' } as any],
              },
            },
            embedDocs,
            embedQuery,
            embeddingVersion: 'malformed-test',
          },
        },
      }),
    ],
    secret: 'failed-validation-secret',
  })
}

describe('Validation failures mark jobs as errored', () => {
  test('malformed chunk entry fails the vectorize job', async () => {
    const config = await buildMalformedConfig()
    const payload = await getPayload({ config, cron: true })

    await payload.create({
      collection: 'posts',
      data: { title: 'bad chunks' },
    })

    // Wait for the queued job to finish (success or failure)
    await waitForVectorizationJobs(payload, 15000)

    // Then assert failure
    const res = await payload.find({
      collection: 'payload-jobs',
      where: {
        and: [{ taskSlug: { equals: 'payloadcms-vectorize:vectorize' } }],
      },
      limit: 1,
      sort: '-createdAt',
    })
    const failedJob = (res as any)?.docs?.[0]
    expect(failedJob.hasError).toBe(true)
    const errMsg = failedJob.error.message
    expect(errMsg).toMatch(/chunk/i)
    expect(errMsg).toMatch(/Invalid indices: 1/)

    // Ensure no embeddings were created (all-or-nothing validation)
    const embeddingsCount = await payload.count({ collection: 'default' })
    expect(embeddingsCount.totalDocs).toBe(0)
  })
})
