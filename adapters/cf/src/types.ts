/// <reference types="@cloudflare/workers-types" />
import type { BasePayload } from 'payload'
import { getVectorizedPayload } from 'payloadcms-vectorize'

/**
 * Retrieve the Cloudflare Vectorize binding from a Payload instance.
 * Throws if the binding is not found.
 */
export function getVectorizeBinding(payload: BasePayload): Vectorize {
  const binding = getVectorizedPayload(payload)?.getDbAdapterCustom()
    ?._vectorizeBinding as Vectorize | undefined
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

/** @deprecated Use the official `Vectorize` type from `@cloudflare/workers-types`. */
export type CloudflareVectorizeBinding = Vectorize
