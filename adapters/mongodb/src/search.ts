import type { BasePayload, Where } from 'payload'
import type { VectorSearchResult } from 'payloadcms-vectorize'
import { getMongoClient } from './client.js'
import { convertWhereToMongo, evaluatePostFilter } from './convertWhere.js'
import { ensureSearchIndex } from './indexes.js'
import { RESERVED_FIELDS, type ResolvedPoolConfig } from './types.js'

const RESERVED_AND_META = new Set<string>([
  ...RESERVED_FIELDS,
  '_id',
  'score',
  'createdAt',
  'updatedAt',
])

export interface MongoSearchCtx {
  uri: string
  dbName: string
  pools: Record<string, ResolvedPoolConfig>
}

export async function searchImpl(
  ctx: MongoSearchCtx,
  _payload: BasePayload,
  queryEmbedding: number[],
  poolName: string,
  limit: number = 10,
  where?: Where,
): Promise<VectorSearchResult[]> {
  const pool = ctx.pools[poolName]
  if (!pool) {
    throw new Error(
      `[@payloadcms-vectorize/mongodb] Unknown pool "${poolName}". Configured pools: ${Object.keys(ctx.pools).join(', ')}`,
    )
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(
      `[@payloadcms-vectorize/mongodb] limit must be a positive integer; got ${limit}`,
    )
  }
  const client = await getMongoClient(ctx.uri)
  await ensureSearchIndex(client, ctx.dbName, pool)

  let preFilter: Record<string, unknown> | null = null
  let postFilter: Where | null = null
  if (where && Object.keys(where).length > 0) {
    const split = convertWhereToMongo(where, pool.filterableFields, poolName)
    preFilter = split.preFilter
    postFilter = split.postFilter
  }

  const numCandidates = pool.numCandidates ?? limit * 10

  const vectorSearchStage: Record<string, unknown> = {
    index: pool.indexName,
    path: 'embedding',
    queryVector: queryEmbedding,
    numCandidates,
    limit,
  }
  if (pool.forceExact) vectorSearchStage.exact = true
  if (preFilter) vectorSearchStage.filter = preFilter

  const pipeline: Record<string, unknown>[] = [
    { $vectorSearch: vectorSearchStage },
    { $addFields: { score: { $meta: 'vectorSearchScore' } } },
    { $project: { embedding: 0 } },
  ]

  const collection = client.db(ctx.dbName).collection(pool.collectionName)
  const rawDocs = await collection.aggregate(pipeline).toArray()

  const filtered = postFilter
    ? rawDocs.filter((d) => evaluatePostFilter(d as Record<string, unknown>, postFilter!))
    : rawDocs

  return filtered.map((d) => mapDocToResult(d as Record<string, unknown>))
}

function mapDocToResult(doc: Record<string, unknown>): VectorSearchResult {
  if (typeof doc.score !== 'number') {
    throw new Error(
      `[@payloadcms-vectorize/mongodb] Search result is missing numeric "score" field; ensure the pipeline adds { score: { $meta: 'vectorSearchScore' } }`,
    )
  }
  const extensionFields = Object.fromEntries(
    Object.entries(doc).filter(([k]) => !RESERVED_AND_META.has(k)),
  )
  return {
    id: String(doc._id),
    score: doc.score,
    sourceCollection: String(doc.sourceCollection ?? ''),
    docId: String(doc.docId ?? ''),
    chunkIndex:
      typeof doc.chunkIndex === 'number' ? doc.chunkIndex : Number(doc.chunkIndex ?? 0),
    chunkText: String(doc.chunkText ?? ''),
    embeddingVersion: String(doc.embeddingVersion ?? ''),
    ...extensionFields,
  } as VectorSearchResult
}
