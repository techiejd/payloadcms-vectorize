import { Payload } from 'payload'
import { getVectorizedPayload } from 'payloadcms-vectorize'
import type { CloudflareVectorizeBinding } from './types.js'

/**
 * Store an embedding vector in Cloudflare Vectorize
 */
export default async (
  payload: Payload,
  poolName: string,
  id: string,
  embedding: number[] | Float32Array,
) => {
  // Get Cloudflare binding from config
  const vectorizeBinding = getVectorizedPayload(payload)?.getDbAdapterCustom()?._vectorizeBinding as
    | CloudflareVectorizeBinding
    | undefined
  if (!vectorizeBinding) {
    throw new Error('[@payloadcms-vectorize/cf] Cloudflare Vectorize binding not found')
  }

  try {
    const vector = Array.isArray(embedding) ? embedding : Array.from(embedding)

    // Upsert the vector in Cloudflare Vectorize
    await vectorizeBinding.upsert([
      {
        id,
        values: vector,
      },
    ])
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e)
    payload.logger.error(`[@payloadcms-vectorize/cf] Failed to store embedding: ${errorMessage}`)
    throw new Error(`[@payloadcms-vectorize/cf] Failed to store embedding: ${errorMessage}`)
  }
}
