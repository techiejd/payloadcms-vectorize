import type { Payload } from 'payload'
import type { StoreChunkData } from 'payloadcms-vectorize'
import { getMongoClient } from './client.js'
import { ensureSearchIndex } from './indexes.js'
import { getMongoConfig } from './types.js'

export default async function storeChunk(
  payload: Payload,
  poolName: string,
  data: StoreChunkData,
): Promise<void> {
  const cfg = getMongoConfig(payload)
  const pool = cfg.pools[poolName]
  if (!pool) {
    throw new Error(
      `[@payloadcms-vectorize/mongodb] Unknown pool "${poolName}". Configured pools: ${Object.keys(cfg.pools).join(', ')}`,
    )
  }
  const client = await getMongoClient(cfg.uri)
  await ensureSearchIndex(client, cfg.dbName, pool)

  const embeddingArray = Array.from(data.embedding)

  const now = new Date()
  const collection = client.db(cfg.dbName).collection(pool.collectionName)
  await collection.insertOne({
    sourceCollection: data.sourceCollection,
    docId: String(data.docId),
    chunkIndex: data.chunkIndex,
    chunkText: data.chunkText,
    embeddingVersion: data.embeddingVersion,
    ...data.extensionFields,
    embedding: embeddingArray,
    createdAt: now,
    updatedAt: now,
  })
}
