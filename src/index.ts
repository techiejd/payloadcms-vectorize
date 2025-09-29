import type { Config, Payload } from 'payload'

import { createEmbeddingsCollection } from './collections/embeddings.js'
import type {
  PayloadcmsVectorizeConfig,
  PostgresPayload,
  VectorizeTaskArgs,
  DeleteTaskArgs,
  JobContext,
} from './types.js'
import { isPostgresPayload } from './types.js'

const DEFAULT_EMBEDDINGS_COLLECTION = 'embeddings'

function defaultChunker(text: string): string[] {
  // Naive sentence-based chunker with ~1,000 char soft cap per chunk
  if (!text) return []
  const sentences = text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)

  const chunks: string[] = []
  let current = ''
  for (const sentence of sentences) {
    if ((current + ' ' + sentence).trim().length > 1000) {
      if (current) chunks.push(current)
      current = sentence
    } else {
      current = current ? current + ' ' + sentence : sentence
    }
  }
  if (current) chunks.push(current)
  return chunks.length > 0 ? chunks : [text]
}

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
    `ALTER TABLE "${tableName}" ADD COLUMN IF NOT EXISTS embedding_version text;`,
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

function getFieldChunker(
  fieldCfg: true | import('./types.js').FieldVectorizeOption | undefined,
  fallback: (text: string) => string[],
): (text: string) => string[] {
  if (fieldCfg && fieldCfg !== true && typeof fieldCfg.chunker === 'function')
    return fieldCfg.chunker
  return fallback
}

// ==================
// Plugin entry point
// ==================

export const payloadcmsVectorize =
  (pluginOptions: PayloadcmsVectorizeConfig) =>
  (config: Config): Config => {
    const embeddingsSlug = pluginOptions.embeddingsSlugOverride || DEFAULT_EMBEDDINGS_COLLECTION
    const globalChunker = pluginOptions.chunker || defaultChunker
    const ivfflatLists = pluginOptions.ivfflatLists ?? 100

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

    // Register tasks using Payload Jobs (best-effort, with inline fallback in hooks)
    const incomingJobs = (config as any).jobs || {}
    ;(config as any).jobs = {
      ...incomingJobs,
      tasks: {
        ...(incomingJobs.tasks || {}),
        'payloadcms-vectorize:vectorize': async (args: VectorizeTaskArgs, ctx: JobContext) => {
          const { payload, pluginOptions: opts, doc, collection, fieldsConfig } = args
          await runVectorizeTask({
            payload,
            pluginOptions: opts,
            job: { doc, collection, fieldsConfig },
          })
        },
        'payloadcms-vectorize:delete': async (args: DeleteTaskArgs, ctx: JobContext) => {
          const { payload, embeddingsSlug: slug, collection, docId } = args
          await payload.delete({
            collection: slug,
            where: {
              and: [{ sourceCollection: { equals: collection } }, { docId: { equals: docId } }],
            },
          })
        },
      },
      workflows: { ...(incomingJobs.workflows || {}) },
    }

    // Extend configured collections with hooks
    for (const [collectionSlug, cv] of Object.entries(pluginOptions.collections || {})) {
      const collection = config.collections.find((c) => c.slug === collectionSlug)
      if (!collection) continue

      collection.hooks = {
        ...(collection.hooks || {}),
        afterChange: [
          ...((collection.hooks?.afterChange as any[]) || []),
          async (args) => {
            const { doc, req } = args as any
            const payload = (args as any).payload || req?.payload
            const fieldsConfig = (cv as import('./types.js').CollectionVectorizeOption).fields || {}
            const jobPayload = {
              payload,
              pluginOptions: {
                ...pluginOptions,
                embeddingsCollectionSlug: embeddingsSlug,
              },
              doc,
              collection: collectionSlug,
              fieldsConfig,
            }

            try {
              const jobsApi = (payload as any)?.jobs
              if (jobsApi && typeof jobsApi.enqueue === 'function') {
                await jobsApi.enqueue('payloadcms-vectorize:vectorize', jobPayload)
                return
              }
              if (jobsApi && typeof jobsApi.queue === 'function') {
                await jobsApi.queue('payloadcms-vectorize:vectorize', jobPayload)
                return
              }
            } catch (e) {
              payload?.logger?.warn?.(
                '[payloadcms-vectorize] Jobs enqueue failed, running inline',
                e as Error,
              )
            }
            await runVectorizeTask({
              payload,
              pluginOptions: pluginOptions as any,
              job: jobPayload,
            })
          },
        ],
        afterDelete: [
          ...((collection.hooks?.afterDelete as any[]) || []),
          async ({ id, payload: pld, req }: any) => {
            const payload = (pld as any) || (req as any)?.payload
            try {
              const jobsApi = (payload as any)?.jobs
              const args = {
                payload,
                embeddingsSlug,
                collection: collectionSlug,
                docId: String(id),
              }
              if (jobsApi && typeof jobsApi.enqueue === 'function') {
                await jobsApi.enqueue('payloadcms-vectorize:delete', args)
                return
              }
              if (jobsApi && typeof jobsApi.queue === 'function') {
                await jobsApi.queue('payloadcms-vectorize:delete', args)
                return
              }
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
        dims: pluginOptions.dims,
        ivfflatLists,
      })
    }

    return config
  }

// ============
// Task runners
// ============

async function runVectorizeTask(args: {
  payload: Payload
  pluginOptions: PayloadcmsVectorizeConfig & { embeddingsCollectionSlug?: string }
  job: {
    doc: Record<string, any>
    collection: string
    fieldsConfig: Record<string, true | import('./types.js').FieldVectorizeOption>
  }
}) {
  const { payload, pluginOptions, job } = args
  const embeddingsSlug = pluginOptions.embeddingsSlugOverride || DEFAULT_EMBEDDINGS_COLLECTION
  const embeddingVersion = pluginOptions.embeddingVersion
  const sourceDoc = job.doc
  const collection = job.collection
  const fieldsConfig = job.fieldsConfig

  const isPostgres = isPostgresPayload(payload)
  if (!isPostgres) {
    throw new Error('[payloadcms-vectorize] Only works with Postgres')
  }
  const runSQL = async (sql: string, params?: any[]) => {
    const postgresPayload = payload as PostgresPayload
    if (postgresPayload.db.pool?.query) return postgresPayload.db.pool.query(sql, params)
    if (postgresPayload.db.drizzle?.execute) return postgresPayload.db.drizzle.execute(sql)
    throw new Error('[payloadcms-vectorize] Failed to persist vector column')
  }

  for (const [fieldPath, fieldCfg] of Object.entries(fieldsConfig)) {
    // Delete existing embeddings for this doc/field combination to keep one set per doc/field
    // The embeddingVersion is stored in each document and can be updated by re-vectorizing
    await payload.delete({
      collection: embeddingsSlug,
      where: {
        and: [
          { sourceCollection: { equals: collection } },
          { docId: { equals: String(sourceDoc.id) } },
          { fieldPath: { equals: fieldPath } },
        ],
      },
    })
    const value = getByPath(sourceDoc, fieldPath)
    if (typeof value !== 'string' || !value) continue

    const chunker = getFieldChunker(fieldCfg, pluginOptions.chunker || defaultChunker)
    const chunks = chunker(value)

    let chunkIndex = 0
    for (const chunkText of chunks) {
      const vector = await pluginOptions.embed(chunkText)
      const created = await payload.create({
        collection: embeddingsSlug,
        data: {
          sourceCollection: collection,
          docId: String(sourceDoc.id),
          fieldPath,
          chunkIndex,
          chunkText,
          embeddingVersion,
          embedding: Array.isArray(vector) ? vector : Array.from(vector),
        },
      })

      const id = String(created.id)
      const literal = `[${Array.from(vector).join(',')}]`
      const sql =
        `UPDATE "${embeddingsSlug}" SET embedding = '${literal}', embedding_version = $1 WHERE id = $2` as string
      try {
        await runSQL(sql, [embeddingVersion, id])
      } catch (e) {
        payload.logger.error('[payloadcms-vectorize] Failed to persist vector column', e as Error)
        throw new Error(`[payloadcms-vectorize] Failed to persist vector column: ${e}`)
      }

      chunkIndex += 1
    }
  }
}

function getByPath(obj: any, path: string): any {
  if (!obj) return undefined
  return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj)
}
