import type { Config, SanitizedConfig } from 'payload'
import { buildConfig } from 'payload'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { createPostgresVectorIntegration } from '../../src/index.js'
import payloadcmsVectorize from 'payloadcms-vectorize'
import { makeDummyEmbedDocs, makeDummyEmbedQuery, testEmbeddingVersion } from './helpers/embed.js'

export const DIMS = 8

const integrationResult = createPostgresVectorIntegration({
  default: {
    dims: DIMS,
    ivfflatLists: 1,
  },
})

export const integration = integrationResult

/** Create the plugin with the pg adapter pre-configured */
export const plugin = (
  options: Omit<Parameters<typeof payloadcmsVectorize>[0], 'dbAdapter'>,
): ReturnType<typeof payloadcmsVectorize> => {
  return payloadcmsVectorize({
    ...options,
    dbAdapter: integrationResult.adapter,
  })
}

export async function buildDummyConfig(cfg: Partial<Config>): Promise<SanitizedConfig> {
  const built = await buildConfig({
    secret: process.env.PAYLOAD_SECRET || 'test-secret',
    collections: [],
    editor: lexicalEditor(),
    ...cfg,
  })
  return built
}
