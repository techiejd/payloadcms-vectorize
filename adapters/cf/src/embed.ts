import { CollectionSlug, Payload } from 'payload'
import { getVectorizeBinding } from './types.js'
import { CF_MAPPINGS_SLUG } from './collections/cfMappings.js'
import type { StoreChunkData } from 'payloadcms-vectorize'

export default async (
  payload: Payload,
  poolName: string,
  data: StoreChunkData,
) => {
  const vectorizeBinding = getVectorizeBinding(payload)

  try {
    const vector = Array.isArray(data.embedding) ? data.embedding : Array.from(data.embedding)
    const id = `${poolName}:${data.sourceCollection}:${data.docId}:${data.chunkIndex}`

    await vectorizeBinding.upsert([
      {
        id,
        values: vector,
        metadata: {
          sourceCollection: data.sourceCollection,
          docId: data.docId,
          chunkIndex: data.chunkIndex,
          chunkText: data.chunkText,
          embeddingVersion: data.embeddingVersion,
          ...data.extensionFields,
        },
      },
    ])

    await payload.create({
      collection: CF_MAPPINGS_SLUG as CollectionSlug,
      data: {
        vectorId: id,
        poolName,
        sourceCollection: data.sourceCollection,
        docId: data.docId,
        embeddingVersion: data.embeddingVersion,
      },
    })
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e)
    payload.logger.error(`[@payloadcms-vectorize/cf] Failed to store embedding: ${errorMessage}`)
    throw new Error(`[@payloadcms-vectorize/cf] Failed to store embedding: ${errorMessage}`)
  }
}
