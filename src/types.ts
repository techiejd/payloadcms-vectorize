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
}

export type IngestMode = 'realtime' | 'bulk'

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
  /** Optional fields to extend the knowledge pool collection schema */
  extensionFields?: Field[]
  /** Embedding configuration for the knowledge pool */
  embeddingConfig: EmbeddingConfig
}

type EmbeddingConfig = {
  /** Version string to track embedding model/version - stored in each embedding document */
  version: string
  /** Embedding function for query provided by the user
   * TODO(techiejd): Should be optional? Maybe if not provided then we can disable the search endpoint?
   */
  queryFn: EmbedQueryFn
  /** Embedding function for real-time ingestion of documents provided by the user
   * If not provided, then there is no real-time ingestion of documents provided by the user
   */
  realTimeIngestionFn?: EmbedDocsFn
  /** Bulk embedding configuration provided by the user
   * If not provided, then there bulk embedding is not available
   */
  bulkEmbeddingsFns?: BulkEmbeddingsFns
  /** If both realTimeIngestionFn and bulkEmbeddingsConfig are not provided, then embedding is essentially disabled */
}

export type BulkEmbeddingRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'

export type BulkEmbeddingInput = {
  /** Stable identifier for correlating outputs (should be unique per chunk) */
  id: string
  /** Raw text to embed */
  text: string
}

/** Internal metadata we persist per input to rebuild embeddings after provider returns outputs */
export type BulkEmbeddingInputMetadata = {
  sourceCollection: string
  docId: string
  chunkIndex: number
  embeddingVersion: string
  /** Arbitrary extension fields returned by toKnowledgePool */
  extensionFields?: Record<string, any>
}

export type CollectedEmbeddingInput = BulkEmbeddingInput & { metadata: BulkEmbeddingInputMetadata }

export type BulkEmbeddingOutput = {
  id: string
  embedding?: number[] | Float32Array
  error?: string | null
}

export type BulkEmbeddingCounts = {
  inputs?: number
  succeeded?: number
  failed?: number
}

export type PrepareBulkEmbeddingsArgs = {
  payload: Payload
  knowledgePool: KnowledgePoolName
  embeddingVersion: string
  inputs: BulkEmbeddingInput[]
}

export type PrepareBulkEmbeddingsResult = {
  providerBatchId: string
  inputFileRef?: string
  status?: BulkEmbeddingRunStatus
  counts?: BulkEmbeddingCounts
}

export type PollBulkEmbeddingsArgs = {
  payload: Payload
  knowledgePool: KnowledgePoolName
  providerBatchId: string
}

export type PollBulkEmbeddingsResult = {
  status: BulkEmbeddingRunStatus
  counts?: BulkEmbeddingCounts
  error?: string
  /** Optional delay hint in ms before the next poll */
  nextPollMs?: number
}

export type CompleteBulkEmbeddingsArgs = {
  payload: Payload
  knowledgePool: KnowledgePoolName
  providerBatchId: string
}

export type CompleteBulkEmbeddingsResult = {
  status: BulkEmbeddingRunStatus
  outputs: BulkEmbeddingOutput[]
  counts?: BulkEmbeddingCounts
  error?: string
}

export type BulkEmbeddingsFns = {
  prepareBulkEmbeddings: (
    args: PrepareBulkEmbeddingsArgs,
  ) => Promise<PrepareBulkEmbeddingsResult | void>
  pollBulkEmbeddings: (args: PollBulkEmbeddingsArgs) => Promise<PollBulkEmbeddingsResult>
  completeBulkEmbeddings: (
    args: CompleteBulkEmbeddingsArgs,
  ) => Promise<CompleteBulkEmbeddingsResult | void>
}

export type PayloadcmsVectorizeConfig<TPoolNames extends KnowledgePoolName = KnowledgePoolName> = {
  /** Knowledge pools and their dynamic configurations */
  knowledgePools: Record<TPoolNames, KnowledgePoolDynamicConfig>
  /** Queue name for realtime vectorization jobs.
   * Default is Payload's default queue (undefined). */
  realtimeQueueName?: string
  /** Queue name for bulk embedding jobs.
   * Required at runtime if any knowledge pool uses any bulk ingestion (`bulkEmbeddings !== undefined`). */
  bulkQueueNames?: {
    prepareBulkEmbedQueueName: string
    pollOrCompleteQueueName: string
  }
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

export interface VectorSearchQuery<TPoolNames extends KnowledgePoolName = KnowledgePoolName> {
  /** The knowledge pool to search in */
  knowledgePool: TPoolNames
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
