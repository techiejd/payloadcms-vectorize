import type { BasePayload } from 'payload'
import type { EmbeddingRecord } from 'payloadcms-vectorize'
import { ObjectId } from 'mongodb'
import { getMongoClient } from './client.js'
import { RESERVED_FIELDS, type ResolvedPoolConfig } from './types.js'

export interface MongoFindByIdsCtx {
  uri: string
  dbName: string
  pools: Record<string, ResolvedPoolConfig>
}

const HEX24 = /^[a-f\d]{24}$/i
const RESERVED_AND_META = new Set<string>([...RESERVED_FIELDS, '_id', 'createdAt', 'updatedAt'])

export async function findByIdsImpl(
  ctx: MongoFindByIdsCtx,
  _payload: BasePayload,
  poolName: string,
  ids: string[],
  populateEmbedding = false,
): Promise<EmbeddingRecord[]> {
  if (ids.length === 0) return []

  const cfg = ctx.pools[poolName]
  if (!cfg) {
    throw new Error(
      `[@payloadcms-vectorize/mongodb] Unknown pool "${poolName}". Configured pools: ${Object.keys(ctx.pools).join(', ')}`,
    )
  }

  const objectIds = ids.filter((id) => HEX24.test(id)).map((id) => new ObjectId(id))
  if (objectIds.length === 0) return []

  const client = await getMongoClient(ctx.uri)
  const docs = await client
    .db(ctx.dbName)
    .collection(cfg.collectionName)
    .find({ _id: { $in: objectIds } }, populateEmbedding ? {} : { projection: { embedding: 0 } })
    .toArray()

  return docs.map((doc) => mapDocToRecord(doc as Record<string, unknown>, populateEmbedding))
}

function mapDocToRecord(
  doc: Record<string, unknown>,
  populateEmbedding: boolean,
): EmbeddingRecord {
  const extensionFields = Object.fromEntries(
    Object.entries(doc).filter(([k]) => !RESERVED_AND_META.has(k)),
  )
  return {
    id: String(doc._id),
    sourceCollection: String(doc.sourceCollection ?? ''),
    docId: String(doc.docId ?? ''),
    chunkIndex:
      typeof doc.chunkIndex === 'number' ? doc.chunkIndex : Number(doc.chunkIndex ?? 0),
    chunkText: String(doc.chunkText ?? ''),
    embeddingVersion: String(doc.embeddingVersion ?? ''),
    ...(populateEmbedding
      ? { embedding: Array.isArray(doc.embedding) ? (doc.embedding as number[]) : [] }
      : {}),
    ...extensionFields,
  }
}
