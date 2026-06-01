import { BasePayload } from 'payload'
import { KnowledgePoolName, EmbeddingRecord } from 'payloadcms-vectorize'
import { getVectorizeBinding } from './types.js'

const RESERVED_METADATA = ['sourceCollection', 'docId', 'chunkIndex', 'chunkText', 'embeddingVersion']

export default async (
  payload: BasePayload,
  _poolName: KnowledgePoolName,
  ids: string[],
): Promise<Array<EmbeddingRecord>> => {
  if (ids.length === 0) return []

  const binding = getVectorizeBinding(payload)

  try {
    const vectors = await binding.getByIds(ids)
    if (!vectors) return []

    return vectors.map((vector) => {
      const metadata = (vector.metadata || {}) as Record<string, unknown>
      const extensionFields = Object.fromEntries(
        Object.entries(metadata).filter(([k]) => !RESERVED_METADATA.includes(k)),
      )
      return {
        id: vector.id,
        sourceCollection: String(metadata.sourceCollection ?? ''),
        docId: String(metadata.docId ?? ''),
        chunkIndex:
          typeof metadata.chunkIndex === 'number'
            ? metadata.chunkIndex
            : parseInt(String(metadata.chunkIndex ?? '0'), 10),
        chunkText: String(metadata.chunkText ?? ''),
        embeddingVersion: String(metadata.embeddingVersion ?? ''),
        embedding: Array.from(vector.values ?? []),
        ...extensionFields,
      }
    })
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e)
    payload.logger.error(`[@payloadcms-vectorize/cf] findByIds failed: ${errorMessage}`)
    throw new Error(`[@payloadcms-vectorize/cf] findByIds failed: ${errorMessage}`)
  }
}
