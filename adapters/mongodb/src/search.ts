import type { BasePayload, Where } from 'payload'
import type { VectorSearchResult } from 'payloadcms-vectorize'
import { getMongoClient } from './client.js'
import { convertWhereToMongo, evaluatePostFilter } from './convertWhere.js'
import { ensureSearchIndex } from './indexes.js'
import { getMongoConfig, RESERVED_FIELDS } from './types.js'

export default async function search(
  payload: BasePayload,
  queryEmbedding: number[],
  poolName: string,
  limit: number = 10,
  where?: Where,
): Promise<VectorSearchResult[]> {
  const cfg = getMongoConfig(payload)
  const pool = cfg.pools[poolName]
  if (!pool) {
    throw new Error(
      `[@payloadcms-vectorize/mongodb] Unknown pool "${poolName}". Configured pools: ${Object.keys(cfg.pools).join(', ')}`,
    )
  }
  const client = await getMongoClient(cfg.uri)
  await ensureSearchIndex(client, cfg.dbName, pool)

  let preFilter: Record<string, unknown> | null = null
  let postFilter: Where | null = null
  if (where && Object.keys(where).length > 0) {
    const split = convertWhereToMongo(where, pool.filterableFields, poolName)
    preFilter = split.preFilter
    postFilter = split.postFilter
  }

  const numCandidates =
    pool.numCandidates ?? Math.max(limit * 20, 100)

  const vectorSearchStage: Record<string, unknown> = {
    index: pool.indexName,
    path: 'embedding',
    queryVector: queryEmbedding,
    numCandidates,
    limit,
  }
  if (pool.forceExact) vectorSearchStage.exact = true
  if (preFilter) vectorSearchStage.filter = preFilter

  const projection: Record<string, unknown> = {
    _id: 1,
    score: { $meta: 'vectorSearchScore' },
    sourceCollection: 1,
    docId: 1,
    chunkIndex: 1,
    chunkText: 1,
    embeddingVersion: 1,
  }
  for (const f of pool.filterableFields) projection[f] = 1

  const pipeline: Record<string, unknown>[] = [
    { $vectorSearch: vectorSearchStage },
    { $project: projection },
  ]

  const collection = client.db(cfg.dbName).collection(pool.collectionName)
  const rawDocs = await collection.aggregate(pipeline).toArray()

  const filtered = postFilter
    ? rawDocs.filter((d) => evaluatePostFilter(d as Record<string, unknown>, postFilter!))
    : rawDocs

  return filtered.map((d) => mapDocToResult(d as Record<string, unknown>, pool.filterableFields))
}

function mapDocToResult(
  doc: Record<string, unknown>,
  filterable: string[],
): VectorSearchResult {
  const result: Record<string, unknown> = {
    id: String(doc._id),
    score: typeof doc.score === 'number' ? doc.score : Number(doc.score),
    sourceCollection: String(doc.sourceCollection ?? ''),
    docId: String(doc.docId ?? ''),
    chunkIndex:
      typeof doc.chunkIndex === 'number' ? doc.chunkIndex : Number(doc.chunkIndex ?? 0),
    chunkText: String(doc.chunkText ?? ''),
    embeddingVersion: String(doc.embeddingVersion ?? ''),
  }
  for (const f of filterable) {
    if (f in doc && !(RESERVED_FIELDS as readonly string[]).includes(f)) {
      result[f] = doc[f]
    }
  }
  return result as VectorSearchResult
}
