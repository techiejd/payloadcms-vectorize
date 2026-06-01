/// <reference types="@cloudflare/workers-types" />
import type { BasePayload } from 'payload'
import { getVectorizedPayload } from 'payloadcms-vectorize'

export function getVectorizeBinding(payload: BasePayload): Vectorize {
  const binding = getVectorizedPayload(payload)?.getDbAdapterCustom()
    ?._vectorizeBinding as Vectorize | undefined
  if (!binding) {
    throw new Error('[@payloadcms-vectorize/cf] Cloudflare Vectorize binding not found')
  }
  return binding
}

export interface CloudflareVectorizePoolConfig {
  dims: number
}

export type KnowledgePoolsConfig = Record<string, CloudflareVectorizePoolConfig>

/** @deprecated Use the official `Vectorize` type from `@cloudflare/workers-types`. */
export type CloudflareVectorizeBinding = Vectorize
