import type { CollectionSlug, Payload, Field, Where } from 'payload'

/** Result from bulkEmbed method */
export type BulkEmbedResult =
  | {
      /** ID of the created run */
      runId: string
      /** Status of the run */
      status: 'queued'
    }
  | {
      /** ID of existing active run */
      runId: string
      /** Status of existing run */
      status: 'queued' | 'running'
      /** Message explaining why a new run wasn't started */
      message: string
      /** Indicates a conflict occurred */
      conflict: true
    }

/** Result from retryFailedBatch method */
export type RetryFailedBatchResult =
  | {
      /** ID of the batch being retried */
      batchId: string
      /** ID of the new batch created from retry (if batch was already retried, returns existing retry batch) */
      newBatchId?: string
      /** ID of the parent run */
      runId: string
      /** New status of the batch */
      status: 'queued'
      /** Confirmation message */
      message: string
    }
  | {
      /** Error message */
      error: string
      /** Indicates a conflict occurred (e.g., run still active) */
      conflict?: true
    }

/**
 * Extended Payload type with vectorize plugin methods
 */
export type VectorizedPayload<TPoolNames extends KnowledgePoolName = KnowledgePoolName> = {
  /** Check if bulk embedding is enabled for a knowledge pool */
  _isBulkEmbedEnabled: (knowledgePool: TPoolNames) => boolean
  /** Static configs for migration helper access */
  _staticConfigs: Record<TPoolNames, KnowledgePoolStaticConfig>
  search: (params: VectorSearchQuery<TPoolNames>) => Promise<Array<VectorSearchResult>>
  queueEmbed: (
    params:
      | {
          collection: string
          docId: string
        }
      | {
          collection: string
          doc: Record<string, any>
        },
  ) => Promise<void>
  /** Start a bulk embedding run for a knowledge pool */
  bulkEmbed: (params: { knowledgePool: TPoolNames }) => Promise<BulkEmbedResult>
  /** Retry a failed batch */
  retryFailedBatch: (params: { batchId: string }) => Promise<RetryFailedBatchResult>
}

/**
 * Get the vectorized payload object from config.custom
 * Returns null if the payload instance doesn't have vectorize extensions
 */
export function getVectorizedPayload<TPoolNames extends KnowledgePoolName = KnowledgePoolName>(
  payload: Payload,
): VectorizedPayload<TPoolNames> | null {
  const custom = (payload.config as any)?.custom
  const vectorizedPayloadFactory = custom?.createVectorizedPayloadObject
  if (vectorizedPayloadFactory && typeof vectorizedPayloadFactory === 'function') {
    return vectorizedPayloadFactory(payload) as VectorizedPayload<TPoolNames>
  }
  return null
}

export type EmbedDocsFn = (texts: string[]) => Promise<number[][] | Float32Array[]>
export type EmbedQueryFn = (text: string) => Promise<number[] | Float32Array>

export type ToKnowledgePoolFn = (
  doc: Record<string, any>,
  payload: Payload,
) => Promise<Array<{ chunk: string; [key: string]: any }>>

export type ShouldEmbedFn = (
  doc: Record<string, any>,
  payload: Payload,
) => Promise<boolean> | boolean

export type CollectionVectorizeOption = {
  /** Optional filter: return false to skip embedding this document.
   * For bulk embeddings, runs before job is queued.
   * If undefined, defaults to embedding all documents. */
  shouldEmbedFn?: ShouldEmbedFn
  /** Function that converts a document to an array of chunks with optional extension field values */
  toKnowledgePool: ToKnowledgePoolFn
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
  /** Optional fields to extend the knowledge pool collection schema */
  extensionFields?: Field[]
  /** Embedding configuration for the knowledge pool */
  embeddingConfig: EmbeddingConfig
}

export type EmbeddingConfig = {
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
  /** If both realTimeIngestionFn and bulkEmbeddingsConfig are not provided, then embedding for this knowledge pool is essentially disabled */
}

export type BulkEmbeddingRunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'retried'

export type BulkEmbeddingInput = {
  /** Stable identifier for correlating outputs (is unique per chunk) */
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

export type PollBulkEmbeddingsResult = {
  status: BulkEmbeddingRunStatus
  error?: string
}

/** Arguments passed to addChunk callback */
export type AddChunkArgs = {
  /** The chunk to add */
  chunk: BulkEmbeddingInput
  /** True if this is the last chunk in the run */
  isLastChunk: boolean
}

/** Result when user decides to submit a batch */
export type BatchSubmission = {
  /** Provider-specific batch identifier */
  providerBatchId: string
}

/** Arguments for polling or completing a single batch */
export type PollOrCompleteBatchArgs = {
  /** Provider-specific batch identifier */
  providerBatchId: string
  /** Callback function to stream completed chunks as they become available */
  onChunk: (chunk: BulkEmbeddingOutput) => Promise<void>
}

/** Data about a failed chunk during bulk embedding completion */
export type FailedChunkData = {
  /** Source collection slug */
  collection: string
  /** Source document ID */
  documentId: string
  /** Index of the chunk within the document */
  chunkIndex: number
}

/** Arguments passed to onError callback */
export type OnBulkErrorArgs = {
  /** All provider batch IDs that were created during this run */
  providerBatchIds: string[]
  /** The error that caused the failure */
  error: Error
  /** Optional: Data about chunks that failed during completion */
  failedChunkData?: FailedChunkData[]
  /** Optional: Count of failed chunks (for quick summary without iterating failedChunkData) */
  failedChunkCount?: number
}

/**
 * Bulk embeddings API with user-controlled batching.
 * User accumulates chunks internally and decides when to flush based on file size.
 */
export type BulkEmbeddingsFns = {
  /**
   * Called for each chunk. User accumulates internally based on file size/line limits.
   * - Return null to keep accumulating
   * - Return BatchSubmission when ready to submit a batch
   *
   * **Important contract:**
   * When you return a submission, all chunks that you've accumulated (and decided to submit)
   * are considered submitted. The plugin tracks chunks in `pendingChunks` and assumes all
   * of them were submitted when you return a BatchSubmission.
   *
   * **About `isLastChunk`:**
   * - `isLastChunk=true` indicates this is the final chunk in the run
   * - Use this to flush any remaining accumulated chunks before the run completes
   * - The plugin uses this only to know when to stop iterating, not to determine which chunks were submitted
   *
   * **Example flow when chunk would exceed limit:**
   * 1. Check if adding current chunk == limit or if isLastChunk is true
   * 2. If yes: submit accumulated chunks and return the BatchSubmission
   * 3. Start fresh in the next call
   */
  addChunk: (args: AddChunkArgs) => Promise<BatchSubmission | null>

  /**
   * Poll a specific batch by providerBatchId, and stream outputs when complete.
   * Call onChunk for each output as it becomes available once the batch completes.
   * The function completes when all chunks have been streamed.
   */
  pollOrCompleteBatch: (args: PollOrCompleteBatchArgs) => Promise<PollBulkEmbeddingsResult>

  /**
   * Called when the bulk run fails. Use this to clean up provider-side resources
   * (e.g., delete uploaded files, cancel batches). The run can be re-queued after cleanup.
   */
  onError?: (args: OnBulkErrorArgs) => Promise<void>
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
  pluginOptions: PayloadcmsVectorizeConfig
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
