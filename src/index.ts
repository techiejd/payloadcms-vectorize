import type { Config, Payload } from 'payload'
import { customType } from '@payloadcms/db-postgres/drizzle/pg-core'

import { createEmbeddingsCollection } from './collections/embeddings.js'
import type {
  PayloadcmsVectorizeConfig,
  PostgresPayload,
  StaticIntegrationConfig,
} from './types.js'
import { isPostgresPayload } from './types.js'
import type { PostgresAdapterArgs } from '@payloadcms/db-postgres'
import { createVectorizeTask } from './tasks/vectorize.js'
import { vectorSearch } from './endpoints/vectorSearch.js'

export type * from './types.js'

const DEFAULT_EMBEDDINGS_COLLECTION = 'embeddings'

async function ensurePgvectorArtifacts(args: {
  payload: Payload
  tableName: string
  dims: number
  ivfflatLists: number
}): Promise<void> {
  const { payload, tableName, dims, ivfflatLists } = args

  if (!isPostgresPayload(payload)) {
    throw new Error(
      '[payloadcms-vectorize] This plugin requires the Postgres adapter. Please configure @payloadcms/db-postgres.',
    )
  }

  // Now payload is typed as PostgresPayload
  const postgresPayload = payload as PostgresPayload

  const sqls: string[] = [
    `CREATE EXTENSION IF NOT EXISTS vector;`,
    `ALTER TABLE "${tableName}" ADD COLUMN IF NOT EXISTS embedding vector(${dims});`,
    `CREATE INDEX IF NOT EXISTS ${tableName}_embedding_ivfflat ON "${tableName}" USING ivfflat (embedding vector_cosine_ops) WITH (lists = ${ivfflatLists});`,
  ]

  try {
    if (postgresPayload.db.pool?.query) {
      for (const sql of sqls) {
        await postgresPayload.db.pool.query(sql)
      }
    } else if (postgresPayload.db.drizzle?.execute) {
      for (const sql of sqls) {
        await postgresPayload.db.drizzle.execute(sql)
      }
    }
    postgresPayload.logger.info('[payloadcms-vectorize] pgvector extension/columns/index ensured')
  } catch (err) {
    postgresPayload.logger.error(
      '[payloadcms-vectorize] Failed ensuring pgvector artifacts',
      err as Error,
    )
    throw new Error(`[payloadcms-vectorize] Failed ensuring pgvector artifacts: ${err}`)
  }
}

// ==================
// Plugin entry point
// ==================

export const createVectorizeIntegration = (
  integrationConfig: StaticIntegrationConfig,
): {
  afterSchemaInitHook: Required<PostgresAdapterArgs>['afterSchemaInit'][number]
  payloadcmsVectorize: (pluginOptions: PayloadcmsVectorizeConfig) => (config: Config) => Config
} => {
  const embeddingsSlug = integrationConfig.embeddingsSlugOverride || DEFAULT_EMBEDDINGS_COLLECTION

  // Augment the generated schema so push/migrations are aware of our custom columns
  const afterSchemaInitHook: Required<PostgresAdapterArgs>['afterSchemaInit'][number] = async ({
    schema,
    extendTable,
  }) => {
    const vectorType = customType({
      dataType() {
        return `vector(${integrationConfig.dims})`
      },
    })

    const table = schema?.tables?.[embeddingsSlug]
    if (table && typeof extendTable === 'function') {
      extendTable({
        table,
        columns: {
          embedding: vectorType('embedding'),
        },
      })
    }
    return schema
  }
  const payloadcmsVectorize =
    (pluginOptions: PayloadcmsVectorizeConfig) =>
    (config: Config): Config => {
      // Ensure collections array exists
      config.collections = [...(config.collections || [])]

      // Add the embeddings collection (backed by pgvector column added on init)
      const embeddingsCollection = createEmbeddingsCollection(embeddingsSlug)

      // Only add once
      if (!config.collections.find((c) => c.slug === embeddingsSlug)) {
        config.collections.push(embeddingsCollection)
      }

      // Exit early if disabled, but keep embeddings collection present for migrations
      if (pluginOptions.disabled) return config

      // Register tasks using Payload Jobs
      const incomingJobs = config.jobs || { tasks: [] }

      const vectorizeTask = createVectorizeTask({
        integrationConfig,
        opts: pluginOptions,
        collections: pluginOptions.collections,
      })
      config.jobs = {
        ...incomingJobs,
        tasks: [...incomingJobs.tasks, vectorizeTask],
      }

      // Extend configured collections with hooks
      for (const [collectionSlug, cv] of Object.entries(pluginOptions.collections)) {
        const collection = config.collections.find((c) => c.slug === collectionSlug)
        if (!collection) {
          throw new Error(`[payloadcms-vectorize] Collection ${collectionSlug} not found`)
        }
        if (!cv) {
          throw new Error(`[payloadcms-vectorize] Collection ${collectionSlug} not found`)
        }

        collection.hooks = {
          ...(collection.hooks || {}),
          afterChange: [
            ...((collection.hooks?.afterChange as any[]) || []),
            async (args) => {
              const { doc, req } = args
              const payload = req.payload
              const fieldsConfig = cv.fields

              await payload.jobs.queue<'payloadcms-vectorize:vectorize'>({
                task: 'payloadcms-vectorize:vectorize',
                input: {
                  doc,
                  collection: collectionSlug,
                  fieldsConfig,
                },
                req: req,
                ...(pluginOptions.queueName ? { queue: pluginOptions.queueName } : {}),
              })
              return
            },
          ],
          afterDelete: [
            ...((collection.hooks?.afterDelete as any[]) || []),
            async ({ id, payload: pld, req }: any) => {
              const payload = (pld as any) || (req as any)?.payload
              try {
                await payload.delete({
                  collection: embeddingsSlug,
                  where: {
                    and: [
                      { sourceCollection: { equals: collectionSlug } },
                      { docId: { equals: String(id) } },
                    ],
                  },
                })
              } catch (e) {
                payload?.logger?.warn?.(
                  '[payloadcms-vectorize] Jobs enqueue failed (delete), running inline',
                  e as Error,
                )
              }
              await payload.delete({
                collection: embeddingsSlug,
                where: {
                  and: [
                    { sourceCollection: { equals: collectionSlug } },
                    { docId: { equals: String(id) } },
                  ],
                },
              })
            },
          ],
        }
      }

      const incomingOnInit = config.onInit
      config.onInit = async (payload) => {
        if (incomingOnInit) await incomingOnInit(payload)
        await ensurePgvectorArtifacts({
          payload,
          tableName: embeddingsSlug,
          dims: integrationConfig.dims,
          ivfflatLists: integrationConfig.ivfflatLists,
        })
      }

      if (pluginOptions.endpointOverrides?.enabled !== false) {
        const path = pluginOptions.endpointOverrides?.path || '/api/vector-search'
        const inputEndpoints = config.endpoints || []
        config.endpoints = [
          ...inputEndpoints,
          {
            path,
            method: 'post',
            handler: vectorSearch(pluginOptions.embed),
          },
        ]
      }

      return config
    }
  return {
    afterSchemaInitHook,
    payloadcmsVectorize,
  }
}
