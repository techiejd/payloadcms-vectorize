import { Payload } from 'payload'

/**
 * Store an embedding vector in Cloudflare Vectorize
 * Also creates a Payload document for the metadata
 */
export default async (
  payload: Payload,
  poolName: string,
  id: string,
  embedding: number[] | Float32Array,
) => {
  // Get Cloudflare bindings from context or environment
  const vectorizeBinding = (payload?.context as any)?.vectorize
  if (!vectorizeBinding) {
    throw new Error('[@payloadcms-vectorize/cf] Cloudflare Vectorize binding not found')
  }

  try {
    const vector = Array.isArray(embedding) ? embedding : Array.from(embedding)

    // Upsert the vector in Cloudflare Vectorize
    // The vector will be stored with the document ID as its ID
    await vectorizeBinding.upsert([
      {
        id,
        values: vector,
      },
    ])
  } catch (e) {
    const errorMessage = (e as Error).message || (e as any).toString()
    payload.logger.error(`[@payloadcms-vectorize/cf] Failed to store embedding: ${errorMessage}`)
    throw new Error(`[@payloadcms-vectorize/cf] Failed to store embedding: ${errorMessage}`)
  }
}
