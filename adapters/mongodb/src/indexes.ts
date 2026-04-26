import type { Db, MongoClient } from 'mongodb'
import type { ResolvedPoolConfig } from './types.js'

const ensureCache = new Map<string, Promise<void>>()

function cacheKey(dbName: string, collectionName: string, indexName: string): string {
  return `${dbName}::${collectionName}::${indexName}`
}

function buildDefinition(pool: ResolvedPoolConfig): Record<string, unknown> {
  return {
    fields: [
      {
        type: 'vector',
        path: 'embedding',
        numDimensions: pool.dimensions,
        similarity: pool.similarity,
      },
      { type: 'filter', path: 'sourceCollection' },
      { type: 'filter', path: 'docId' },
      { type: 'filter', path: 'embeddingVersion' },
      ...pool.filterableFields.map((p) => ({ type: 'filter', path: p })),
    ],
  }
}

function definitionsEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

async function ensureCollectionExists(db: Db, name: string): Promise<void> {
  const existing = await db.listCollections({ name }, { nameOnly: true }).toArray()
  if (existing.length === 0) {
    await db.createCollection(name)
  }
}

async function doEnsure(
  client: MongoClient,
  dbName: string,
  pool: ResolvedPoolConfig,
): Promise<void> {
  const db = client.db(dbName)
  const collection = db.collection(pool.collectionName)
  const wantedDefinition = buildDefinition(pool)

  const existing = (await collection
    .listSearchIndexes(pool.indexName)
    .toArray()) as Array<Record<string, unknown>>

  const found = existing.find((idx) => idx.name === pool.indexName)
  if (found) {
    const status = found.status as string | undefined
    if (status === 'READY' || status === 'BUILDING') {
      const latest = (found.latestDefinition as Record<string, unknown>) ?? found.definition
      if (!definitionsEqual(latest, wantedDefinition)) {
        throw new Error(
          `[@payloadcms-vectorize/mongodb] Search index "${pool.indexName}" exists with different definition. Drop it manually with db.collection("${pool.collectionName}").dropSearchIndex("${pool.indexName}") before re-running.`,
        )
      }
      if (status === 'READY') return
    } else {
      throw new Error(
        `[@payloadcms-vectorize/mongodb] Search index "${pool.indexName}" is in unexpected state "${status}". Drop and recreate.`,
      )
    }
  } else {
    await ensureCollectionExists(db, pool.collectionName)
    await collection.createSearchIndex({
      name: pool.indexName,
      type: 'vectorSearch',
      definition: wantedDefinition,
    })
  }

  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const list = (await collection
      .listSearchIndexes(pool.indexName)
      .toArray()) as Array<Record<string, unknown>>
    const idx = list.find((i) => i.name === pool.indexName)
    if (idx?.status === 'READY') return
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(
    `[@payloadcms-vectorize/mongodb] Search index "${pool.indexName}" did not become READY within 60s. Check Mongo logs.`,
  )
}

export function ensureSearchIndex(
  client: MongoClient,
  dbName: string,
  pool: ResolvedPoolConfig,
): Promise<void> {
  const key = cacheKey(dbName, pool.collectionName, pool.indexName)
  let p = ensureCache.get(key)
  if (!p) {
    p = doEnsure(client, dbName, pool).catch((err) => {
      ensureCache.delete(key)
      throw err
    })
    ensureCache.set(key, p)
  }
  return p
}

export function __resetIndexCacheForTests(): void {
  ensureCache.clear()
}
