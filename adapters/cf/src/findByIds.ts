import { BasePayload } from 'payload'
import { KnowledgePoolName, EmbeddingRecord } from 'payloadcms-vectorize'
import { getVectorizeBinding } from './types.js'

const RESERVED_METADATA = ['sourceCollection', 'docId', 'chunkIndex', 'chunkText', 'embeddingVersion']

export default async (
  payload: BasePayload,
  _poolName: KnowledgePoolName,
  ids: string[],
  populateEmbedding = false,
): Promise<Record<string, EmbeddingRecord | undefined>> => {
  const result: Record<string, EmbeddingRecord | undefined> = {}
  for (const id of ids) result[id] = undefined
  if (ids.length === 0) return result

  const binding = getVectorizeBinding(payload)

  try {
    const vectors = await binding.getByIds(ids)
    if (!vectors) return result

    for (const vector of vectors) {
      const metadata = (vector.metadata || {}) as Record<string, unknown>
      const extensionFields = Object.fromEntries(
        Object.entries(metadata).filter(([k]) => !RESERVED_METADATA.includes(k)),
      )
      result[vector.id] = {
        id: vector.id,
        sourceCollection: String(metadata.sourceCollection ?? ''),
        docId: String(metadata.docId ?? ''),
        chunkIndex:
          typeof metadata.chunkIndex === 'number'
            ? metadata.chunkIndex
            : parseInt(String(metadata.chunkIndex ?? '0'), 10),
        chunkText: String(metadata.chunkText ?? ''),
        embeddingVersion: String(metadata.embeddingVersion ?? ''),
        ...(populateEmbedding ? { embedding: Array.from(vector.values ?? []) } : {}),
        ...extensionFields,
      }
    }
    return result
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e)
    payload.logger.error(`[@payloadcms-vectorize/cf] findByIds failed: ${errorMessage}`)
    throw new Error(`[@payloadcms-vectorize/cf] findByIds failed: ${errorMessage}`)
  }
}
