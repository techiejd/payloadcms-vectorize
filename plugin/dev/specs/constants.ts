import type { Config } from 'payload'

import { buildConfig } from 'payload'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { createVectorizeIntegration } from 'payloadcms-vectorize'

export const DIMS = 8

export const embeddingsCollection = 'default'

export const integration = createVectorizeIntegration({
  default: {
    dims: DIMS,
    ivfflatLists: 1,
  },
})
export const vectorizeCronJob = { cron: '*/10 * * * * *', limit: 5, queue: 'default' }
export const plugin = integration.payloadcmsVectorize

export const dummyPluginOptions = {
  knowledgePools: {
    default: {
      collections: {},
      embeddingConfig: {
        version: 'test',
        queryFn: async (text: string) => [0, 0, 0, 0, 0, 0, 0, 0],
        realTimeIngestionFn: async (texts: string[]) => texts.map(() => [0, 0, 0, 0, 0, 0, 0, 0]),
      },
    },
  },
  queueNameOrCronJob: vectorizeCronJob,
}

export async function buildDummyConfig(cfg: Partial<Config>) {
  const built = await buildConfig({
    secret: 'test-secret',
    collections: [],
    editor: lexicalEditor(),
    // Provide a dummy db adapter to satisfy types; not used by these tests
    db: {} as any,
    plugins: [plugin(dummyPluginOptions)],
    ...cfg,
  })
  return built
}
