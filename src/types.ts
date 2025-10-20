import type { CollectionSlug, Payload, Config } from 'payload'
import type { SerializedEditorState } from '@payloadcms/richtext-lexical/lexical'

export type EmbedFn = (texts: string[]) => Promise<number[][] | Float32Array[]>

export type ChunkerFn =
  | ((text: string, payload: Payload) => string[])
  | ((text: string, payload: Payload) => Promise<string[]>)
  | ((richText: SerializedEditorState, payload: Payload) => string[])
  | ((richText: SerializedEditorState, payload: Payload) => Promise<string[]>)

export type FieldVectorizeOption = {
  /** Required per-field chunker override */
  chunker: ChunkerFn
}

export type CollectionVectorizeOption = {
  /** Map of field paths to enable vectorization */
  fields: Record<string, FieldVectorizeOption>
}

/** Note current limitation: needs a migration in order to change after initial creation */
export type StaticIntegrationConfig = {
  /** Name of the embeddings collection created by the plugin */
  embeddingsSlugOverride?: string
  /** Vector dimensions for pgvector column */
  dims: number
  /** IVFFLAT lists parameter used when creating the index */
  ivfflatLists: number
}

export type PayloadcmsVectorizeConfig = {
  /** Collections and fields to vectorize */
  collections: Partial<Record<CollectionSlug, CollectionVectorizeOption>>
  /** Embedding function provided by the user */
  embed: EmbedFn
  /** Version string to track embedding model/version - stored in each embedding document */
  embeddingVersion: string
  /** Task queue name.
   * Default is payloadcms default queue (undefined)
   * You must setup the job in your payload config
   * (with either an undefined or defined queue name). */
  queueName?: string
  /** Endpoint overrides for searching vectorized content */
  endpointOverrides?: {
    // Default is '/vector-search' (which gets turned into '/api/vector-search')
    path?: string
    // Default is true and will not add the endpoint if disabled.
    enabled?: boolean
  }
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
  fieldsConfig: Record<string, FieldVectorizeOption>
}

export interface VectorSearchResult {
  id: string
  similarity: number
  sourceCollection: string // The collection that this embedding belongs to
  docId: string // The ID of the source document
  fieldPath: string // The field path that was vectorized (e.g., "title", "content")
  chunkIndex: number // The index of this chunk within the field
  chunkText: string // The original text that was vectorized
  embeddingVersion: string // The version of the embedding model used
}

export interface VectorSearchResponse {
  results: VectorSearchResult[]
}

export interface VectorSearchQuery {
  // TODO(techiejd): Expand on query API
  // add support for particular collections, fields, etc.
  query: string
}

export type JobContext = {
  inlineTask: any
  job: any
  req: any
  tasks: any
}

export const DEFAULT_EMBEDDINGS_COLLECTION = 'embeddings'
