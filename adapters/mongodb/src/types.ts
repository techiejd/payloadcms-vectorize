export type Similarity = 'cosine' | 'euclidean' | 'dotProduct'

export interface MongoPoolConfig {
  /** Vector dimensions for this pool (must match embedding model output). */
  dimensions: number
  /** Similarity metric for the search index. Default 'cosine'. */
  similarity?: Similarity
  /** ANN candidate set size. Default at search time: max(limit * 20, 100). */
  numCandidates?: number
  /** Extension fields to declare as filterable in the search index. */
  filterableFields?: string[]
  /** ENN exact search (full scan) instead of HNSW ANN. Default false. */
  forceExact?: boolean
  /** Override Mongo collection name. Default `vectorize_${poolName}`. */
  collectionName?: string
  /** Override search index name. Default `${collectionName}_idx`. */
  indexName?: string
}

export interface MongoVectorIntegrationConfig {
  /** Any valid MongoDB connection string (Atlas SRV or self-hosted). */
  uri: string
  /** Database that holds the per-pool vector collections. */
  dbName: string
  /** Pools keyed by knowledge pool name. */
  pools: Record<string, MongoPoolConfig>
}

/** Resolved per-pool config used internally (defaults applied). */
export interface ResolvedPoolConfig {
  dimensions: number
  similarity: Similarity
  numCandidates?: number
  filterableFields: string[]
  forceExact: boolean
  collectionName: string
  indexName: string
}

/**
 * Stored on `getConfigExtension().custom._mongoConfig` for introspection.
 * The connection URI is intentionally NOT included — credentials live in
 * the adapter closure, never on `payload.config`.
 */
export interface MongoConfigCustom {
  dbName: string
  pools: Record<string, ResolvedPoolConfig>
}

export const RESERVED_FILTER_FIELDS = [
  'sourceCollection',
  'docId',
  'embeddingVersion',
] as const

export const RESERVED_FIELDS = [
  'sourceCollection',
  'docId',
  'chunkIndex',
  'chunkText',
  'embeddingVersion',
  'embedding',
] as const

export function resolvePoolConfig(
  poolName: string,
  cfg: MongoPoolConfig,
): ResolvedPoolConfig {
  const collectionName = cfg.collectionName ?? `vectorize_${poolName}`
  return {
    dimensions: cfg.dimensions,
    similarity: cfg.similarity ?? 'cosine',
    numCandidates: cfg.numCandidates,
    filterableFields: cfg.filterableFields ?? [],
    forceExact: cfg.forceExact ?? false,
    collectionName,
    indexName: cfg.indexName ?? `${collectionName}_idx`,
  }
}

