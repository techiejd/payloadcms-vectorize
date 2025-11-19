import type { CollectionSlug, Payload, Field, Where } from 'payload'

export type EmbedDocsFn = (texts: string[]) => Promise<number[][] | Float32Array[]>
export type EmbedQueryFn = (text: string) => Promise<number[] | Float32Array>

export type ToKnowledgePoolFn = (
  doc: Record<string, any>,
  payload: Payload,
) => Promise<Array<{ chunk: string; [key: string]: any }>>

export type CollectionVectorizeOption = {
  /** Function that converts a document to an array of chunks with optional extension field values */
  toKnowledgePool: ToKnowledgePoolFn
  /** Optional fields to extend the embeddings collection schema */
  extensionFields?: Field[]
}

/** Knowledge pool name identifier */
export type KnowledgePoolName = string

/** Static configuration for a knowledge pool */
/** Note current limitation: needs a migration in order to change after initial creation */
export type KnowledgePoolStaticConfig = {
  /** Vector dimensions for pgvector column */
  dims: number
  /** IVFFLAT lists parameter used when creating the index */
  ivfflatLists: number
}

/** Dynamic configuration for a knowledge pool */
/** Does not need a migration in order to change after initial creation */
export type KnowledgePoolDynamicConfig = {
  /** Collections and fields to vectorize */
  collections: Partial<Record<CollectionSlug, CollectionVectorizeOption>>
  /** Embedding function for document provided by the user */
  embedDocs: EmbedDocsFn
  /** Embedding function for query provided by the user */
  embedQuery: EmbedQueryFn
  /** Version string to track embedding model/version - stored in each embedding document */
  embeddingVersion: string
}

export type PayloadcmsVectorizeConfig = {
  /** Knowledge pools and their dynamic configurations */
  knowledgePools: Record<KnowledgePoolName, KnowledgePoolDynamicConfig>
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
  knowledgePool: KnowledgePoolName
  toKnowledgePoolFn: ToKnowledgePoolFn
}

export interface VectorSearchResult {
  id: string
  similarity: number
  sourceCollection: string // The collection that this embedding belongs to
  docId: string // The ID of the source document
  chunkIndex: number // The index of this chunk
  chunkText: string // The original text that was vectorized
  embeddingVersion: string // The version of the embedding model used
  [key: string]: any // Extension fields and other dynamic fields
}

export interface VectorSearchResponse {
  results: VectorSearchResult[]
}

export interface VectorSearchQuery {
  /** The knowledge pool to search in */
  knowledgePool: KnowledgePoolName
  /** The search query string */
  query: string
  /** Optional Payload where clause to filter results. Can rely on embeddings collection fields or extension fields. */
  where?: Where
  /** Optional limit for number of results (default: 10) */
  limit?: number
}

export type JobContext = {
  inlineTask: any
  job: any
  req: any
  tasks: any
}
