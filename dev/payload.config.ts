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

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

if (!process.env.ROOT_DIR) {
  process.env.ROOT_DIR = dirname
}

const EMBEDDINGS_SLUG = 'embeddings'
const DIMS = 8

const integrationConfig: StaticIntegrationConfig = {
  embeddingsSlugOverride: EMBEDDINGS_SLUG,
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
      {
        slug: 'media',
        fields: [],
        upload: {
          staticDir: path.resolve(dirname, 'media'),
        },
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
    onInit: async (payload) => {
      await seed(payload)
    },
    plugins: [
      payloadcmsVectorize({
        collections: {
          posts: {
            fields: {
              title: true,
              content: true,
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
