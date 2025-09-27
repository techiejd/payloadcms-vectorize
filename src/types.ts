import type { CollectionSlug } from 'payload'

export type EmbedFn = (text: string) => Promise<number[] | Float32Array>

export type FieldVectorizeOption = {
  /** Optional per-field chunker override */
  chunker?: (text: string) => string[]
}

export type CollectionVectorizeOption = {
  /** Map of field paths to enable vectorization. `true` uses default settings. */
  fields: Record<string, true | FieldVectorizeOption>
}

export type PayloadcmsVectorizeConfig = {
  /** Collections and fields to vectorize */
  collections: Partial<Record<CollectionSlug, CollectionVectorizeOption>>
  /** Embedding function provided by the user */
  embed: EmbedFn
  /** Version string to track embedding model/version - stored in each embedding document */
  embeddingVersion: string
  /** Default chunker used for all fields unless overridden */
  chunker?: (text: string) => string[]
  /** Name of the embeddings collection created by the plugin */
  embeddingsSlugOverride?: string
  /** Vector dimensions for pgvector column */
  /** Note current limitation: not allowed to be changed after initial creation */
  dims: number
  /** IVFFLAT lists parameter used when creating the index */
  /** Note current limitation: not allowed to be changed after initial creation */
  ivfflatLists?: number
  /** Set true to disable runtime behavior but keep schema */
  disabled?: boolean
}

// Type guard to check if Payload is using Postgres adapter
export function isPostgresPayload(payload: any): payload is any & {
  db: {
    pool?: { query: (sql: string, params?: any[]) => Promise<any> }
    drizzle?: { execute: (sql: string) => Promise<any> }
  }
} {
  return (
    typeof payload?.db?.pool?.query === 'function' ||
    typeof payload?.db?.drizzle?.execute === 'function'
  )
}

// Type for Payload with Postgres database
export type PostgresPayload = any & {
  db: {
    pool?: { query: (sql: string, params?: any[]) => Promise<any> }
    drizzle?: { execute: (sql: string) => Promise<any> }
  }
}

// Job task argument types
export type VectorizeTaskArgs = {
  payload: any
  pluginOptions: PayloadcmsVectorizeConfig & { embeddingsCollectionSlug?: string }
  doc: Record<string, any>
  collection: string
  fieldsConfig: Record<string, true | FieldVectorizeOption>
}

export type DeleteTaskArgs = {
  payload: any
  embeddingsSlug: string
  collection: string
  docId: string
}

export type JobContext = {
  inlineTask: any
  job: any
  req: any
  tasks: any
}
