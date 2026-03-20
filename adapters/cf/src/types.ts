import type { BasePayload } from 'payload'
import { getVectorizedPayload } from 'payloadcms-vectorize'

/**
 * Retrieve the Cloudflare Vectorize binding from a Payload instance.
 * Throws if the binding is not found.
 */
export function getVectorizeBinding(payload: BasePayload): CloudflareVectorizeBinding {
  const binding = getVectorizedPayload(payload)?.getDbAdapterCustom()
    ?._vectorizeBinding as CloudflareVectorizeBinding | undefined
  if (!binding) {
    throw new Error('[@payloadcms-vectorize/cf] Cloudflare Vectorize binding not found')
  }
  return binding
}

/**
 * Configuration for a knowledge pool in Cloudflare Vectorize
 */
export interface CloudflareVectorizePoolConfig {
  /** Vector dimensions for this pool (must match embedding model output) */
  dims: number
}

/**
 * All knowledge pools configuration for Cloudflare Vectorize
 */
export type KnowledgePoolsConfig = Record<string, CloudflareVectorizePoolConfig>

/** A single vector match returned by a Vectorize query */
export interface VectorizeMatch {
  id: string
  score?: number
  metadata?: Record<string, unknown>
}

/** Result of a Vectorize query */
export interface VectorizeQueryResult {
  matches: VectorizeMatch[]
  count: number
}

/** Vector to upsert into Vectorize */
export interface VectorizeVector {
  id: string
  values: number[]
  metadata?: Record<string, unknown>
}

/**
 * Cloudflare Vectorize binding interface.
 * Mirrors the subset of the Vectorize API we use.
 * For the full type, install `@cloudflare/workers-types`.
 */
export interface CloudflareVectorizeBinding {
  query(vector: number[], options?: {
    topK?: number
    returnMetadata?: boolean | 'indexed' | 'all'
    filter?: Record<string, unknown>
    /** Vectorize metadata filtering */
    where?: Record<string, unknown>
  }): Promise<VectorizeQueryResult>
  upsert(vectors: VectorizeVector[]): Promise<unknown>
  deleteByIds(ids: string[]): Promise<unknown>
}
