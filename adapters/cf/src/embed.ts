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
  // Get Cloudflare binding from config
  const vectorizeBinding = (payload?.config?.custom as any)?._vectorizeBinding
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
    const errorMessage = (e as Error).message || (e as any).toString()
    payload.logger.error(`[@payloadcms-vectorize/cf] Failed to store embedding: ${errorMessage}`)
    throw new Error(`[@payloadcms-vectorize/cf] Failed to store embedding: ${errorMessage}`)
  }
}
