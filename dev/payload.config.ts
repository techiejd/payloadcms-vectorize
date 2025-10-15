import { postgresAdapter } from '@payloadcms/db-postgres'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import path from 'path'
import { buildConfig } from 'payload'
import { createVectorizeIntegration, StaticIntegrationConfig } from 'payloadcms-vectorize'
import { makeEmbed, embeddingVersion } from './helpers/embed.js'
import sharp from 'sharp'
import { fileURLToPath } from 'url'

import { testEmailAdapter } from './helpers/testEmailAdapter.js'
import { seed } from './seed.js'
import { chunkRichText, chunkText } from './helpers/chunkers.js'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

if (!process.env.ROOT_DIR) {
  process.env.ROOT_DIR = dirname
}

const DIMS = 8

const integrationConfig: StaticIntegrationConfig = {
  dims: DIMS,
  ivfflatLists: 100,
}

const { afterSchemaInitHook, payloadcmsVectorize } = createVectorizeIntegration(integrationConfig)

const buildConfigWithPostgres = async () => {
  return buildConfig({
    admin: {
      importMap: {
        baseDir: path.resolve(dirname),
      },
    },
    collections: [
      {
        slug: 'posts',
        fields: [
          { name: 'title', type: 'text' },
          { name: 'content', type: 'richText' },
        ],
      },
    ],
    db: postgresAdapter({
      extensions: ['vector'],
      afterSchemaInit: [afterSchemaInitHook],
      pool: {
        connectionString:
          process.env.DATABASE_URI || 'postgresql://postgres:password@localhost:5433/payload_test',
      },
    }),
    editor: lexicalEditor(),
    email: testEmailAdapter,
    jobs: {
      tasks: [],
      autoRun: [
        {
          cron: '*/5 * * * * *', // Run every 5 seconds in development
          limit: 10,
          queue: 'default',
        },
      ],
      jobsCollectionOverrides: ({ defaultJobsCollection }) => {
        // Make jobs collection visible in admin for debugging
        if (!defaultJobsCollection.admin) {
          defaultJobsCollection.admin = {}
        }
        defaultJobsCollection.admin.hidden = false
        return defaultJobsCollection
      },
    },
    onInit: async (payload) => {
      await seed(payload)
    },
    plugins: [
      payloadcmsVectorize({
        collections: {
          posts: {
            fields: {
              title: { chunker: chunkText },
              content: { chunker: chunkRichText },
            },
          },
        },
        embed: makeEmbed(DIMS),
        embeddingVersion,
      }),
    ],
    secret: process.env.PAYLOAD_SECRET || 'test-secret_key',
    sharp,
    typescript: {
      outputFile: path.resolve(dirname, 'payload-types.ts'),
    },
  })
}

export default buildConfigWithPostgres()
