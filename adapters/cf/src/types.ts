import { BasePayload } from 'payload'

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

/**
 * Cloudflare Vectorize binding for vector storage
 */
export type CloudflareVectorizeBinding = any
