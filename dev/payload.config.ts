import { postgresAdapter } from '@payloadcms/db-postgres'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import path from 'path'
import { buildConfig } from 'payload'
import { createVectorizeIntegration } from 'payloadcms-vectorize'
import {
  makeDummyEmbedDocs,
  testEmbeddingVersion,
  voyageEmbedDocs,
  voyageEmbedQuery,
  makeDummyEmbedQuery,
  makeLocalBulkEmbeddingsCallbacks,
} from './helpers/embed.js'
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

if (process.env.NODE_ENV === 'production') {
  // hack for testing atm.
  throw new Error('NODE_ENV should not be production')
}

const dims = Number(process.env.DIMS)
const ivfflatLists = Number(process.env.IVFFLATLISTS)
const embedDocs = process.env.USE_VOYAGE !== undefined ? voyageEmbedDocs : makeDummyEmbedDocs(dims)
const embedQuery =
  process.env.USE_VOYAGE !== undefined ? voyageEmbedQuery : makeDummyEmbedQuery(dims)
const ssl =
  process.env.DATABASE_URI !== undefined
    ? {
        rejectUnauthorized: false,
        ca: process.env.SSL_CA_CERT,
      }
    : undefined

const { afterSchemaInitHook, payloadcmsVectorize } = createVectorizeIntegration({
  default: {
    dims,
    ivfflatLists, // Rule of thumb: ivfflatLists = sqrt(total_number_of_vectors). Helps with working memory usage.
  },
})

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
        ssl,
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
        knowledgePools: {
          default: {
            collections: {
              posts: {
                toKnowledgePool: async (doc, payload) => {
                  const chunks: Array<{ chunk: string }> = []
                  // Process title
                  if (doc.title) {
                    const titleChunks = chunkText(doc.title)
                    chunks.push(...titleChunks.map((chunk) => ({ chunk })))
                  }
                  // Process content
                  if (doc.content) {
                    const contentChunks = await chunkRichText(doc.content, payload)
                    chunks.push(...contentChunks.map((chunk) => ({ chunk })))
                  }
                  return chunks
                },
              },
            },
            embedDocs,
            embedQuery,
            embeddingVersion: testEmbeddingVersion,
            bulkEmbeddings: {
              ...makeLocalBulkEmbeddingsCallbacks(dims),
              ingestMode: 'realtime',
            },
          },
        },
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
