import type { BasePayload } from 'payload'
import type { StoreChunkData } from 'payloadcms-vectorize'
import { getMongoClient } from './client.js'
import { ensureSearchIndex } from './indexes.js'
import type { ResolvedPoolConfig } from './types.js'

export interface MongoStoreCtx {
  uri: string
  dbName: string
  pools: Record<string, ResolvedPoolConfig>
}

export async function storeChunkImpl(
  ctx: MongoStoreCtx,
  _payload: BasePayload,
  poolName: string,
  data: StoreChunkData,
): Promise<void> {
  const pool = ctx.pools[poolName]
  if (!pool) {
    throw new Error(
      `[@payloadcms-vectorize/mongodb] Unknown pool "${poolName}". Configured pools: ${Object.keys(ctx.pools).join(', ')}`,
    )
  }
  const client = await getMongoClient(ctx.uri)
  await ensureSearchIndex(client, ctx.dbName, pool)

  const embeddingArray = Array.from(data.embedding)

  const now = new Date()
  const collection = client.db(ctx.dbName).collection(pool.collectionName)
  await collection.insertOne({
    ...data.extensionFields,
    sourceCollection: data.sourceCollection,
    docId: String(data.docId),
    chunkIndex: data.chunkIndex,
    chunkText: data.chunkText,
    embeddingVersion: data.embeddingVersion,
    embedding: embeddingArray,
    createdAt: now,
    updatedAt: now,
  })
}
