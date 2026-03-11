# Adapter Owns Storage — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move chunk storage, deletion, and version checking from the main plugin into the DbAdapter interface. Fix CF adapter's broken metadata filtering by using Vectorize's native filter parameter.

**Architecture:** The `DbAdapter` interface gains three new methods (`storeChunk`, `deleteChunks`, `hasEmbeddingVersion`) and loses two (`storeEmbedding`, `deleteEmbeddings`). The main plugin stops calling `payload.create()` / `payload.delete()` on the embeddings collection directly — adapters own that. The embeddings collection creation moves from the main plugin into PG adapter's `getConfigExtension`. CF adapter stores metadata on Vectorize vectors and uses native filtering.

**Tech Stack:** TypeScript, Payload CMS 3.x, Drizzle ORM (PG), Cloudflare Vectorize API

---

### Task 1: Update DbAdapter type in src/types.ts

**Files:**
- Modify: `src/types.ts:374-406`

**Step 1: Update the DbAdapter type**

Replace the current `storeEmbedding` and `deleteEmbeddings` with:

```typescript
export type StoreChunkData = {
  sourceCollection: string
  docId: string
  chunkIndex: number
  chunkText: string
  embeddingVersion: string
  embedding: number[] | Float32Array
  extensionFields: Record<string, any>
}

export type DbAdapter = {
  getConfigExtension: (payloadCmsConfig: Config) => {
    bins?: { key: string; scriptPath: string }[]
    custom?: Record<string, any>
    collections?: Record<string, CollectionConfig>
  }
  storeChunk: (
    payload: Payload,
    poolName: KnowledgePoolName,
    data: StoreChunkData,
  ) => Promise<void>
  deleteChunks: (
    payload: Payload,
    poolName: KnowledgePoolName,
    sourceCollection: string,
    docId: string,
  ) => Promise<void>
  hasEmbeddingVersion: (
    payload: Payload,
    poolName: KnowledgePoolName,
    sourceCollection: string,
    docId: string,
    embeddingVersion: string,
  ) => Promise<boolean>
  search: (
    payload: BasePayload,
    queryEmbedding: number[],
    poolName: KnowledgePoolName,
    limit?: number,
    where?: Where,
  ) => Promise<Array<VectorSearchResult>>
}
```

**Step 2: Verify types compile**

Run: `pnpm build:types:all`
Expected: Type errors in files that still reference `storeEmbedding` / `deleteEmbeddings` — this is expected and will be fixed in subsequent tasks.

**Step 3: Commit**

```bash
git add src/types.ts
git commit -m "refactor: update DbAdapter type — storeChunk, deleteChunks, hasEmbeddingVersion"
```

---

### Task 2: Update mock adapter for tests

**Files:**
- Modify: `dev/helpers/mockAdapter.ts`

**Step 1: Update createMockAdapter to implement new interface**

Replace `storeEmbedding` with `storeChunk`, add `deleteChunks` and `hasEmbeddingVersion`:

```typescript
import type { DbAdapter, KnowledgePoolName, VectorSearchResult, StoreChunkData } from 'payloadcms-vectorize'
import type { Payload, BasePayload, CollectionSlug, Where, Config } from 'payload'

type StoredEmbedding = {
  poolName: string
  id: string
  embedding: number[]
}

type MockAdapterOptions = {
  bins?: { key: string; scriptPath: string }[]
  custom?: Record<string, any>
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`)
  }
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

export const createMockAdapter = (options: MockAdapterOptions = {}): DbAdapter => {
  const { bins = [], custom = {} } = options
  const storage = new Map<string, StoredEmbedding>()

  return {
    getConfigExtension: (_config: Config) => ({
      bins,
      custom: { _isMockAdapter: true, ...custom },
    }),

    storeChunk: async (
      payload: Payload,
      poolName: KnowledgePoolName,
      data: StoreChunkData,
    ): Promise<void> => {
      const embeddingArray = Array.isArray(data.embedding) ? data.embedding : Array.from(data.embedding)

      const created = await payload.create({
        collection: poolName as CollectionSlug,
        data: {
          sourceCollection: data.sourceCollection,
          docId: data.docId,
          chunkIndex: data.chunkIndex,
          chunkText: data.chunkText,
          embeddingVersion: data.embeddingVersion,
          ...data.extensionFields,
          embedding: embeddingArray,
        },
      })

      const key = `${poolName}:${String(created.id)}`
      storage.set(key, {
        poolName,
        id: String(created.id),
        embedding: embeddingArray,
      })
    },

    deleteChunks: async (
      payload: Payload,
      poolName: KnowledgePoolName,
      sourceCollection: string,
      docId: string,
    ): Promise<void> => {
      const existing = await payload.find({
        collection: poolName as CollectionSlug,
        where: {
          and: [
            { sourceCollection: { equals: sourceCollection } },
            { docId: { equals: String(docId) } },
          ],
        },
        limit: 1000,
      })
      for (const doc of existing.docs) {
        storage.delete(`${poolName}:${String(doc.id)}`)
      }
      await payload.delete({
        collection: poolName as CollectionSlug,
        where: {
          and: [
            { sourceCollection: { equals: sourceCollection } },
            { docId: { equals: String(docId) } },
          ],
        },
      })
    },

    hasEmbeddingVersion: async (
      payload: Payload,
      poolName: KnowledgePoolName,
      sourceCollection: string,
      docId: string,
      embeddingVersion: string,
    ): Promise<boolean> => {
      const existing = await payload.find({
        collection: poolName as CollectionSlug,
        where: {
          and: [
            { sourceCollection: { equals: sourceCollection } },
            { docId: { equals: String(docId) } },
            { embeddingVersion: { equals: embeddingVersion } },
          ],
        },
        limit: 1,
      })
      return existing.totalDocs > 0
    },

    search: async (
      payload: BasePayload,
      queryEmbedding: number[],
      poolName: string,
      limit: number = 10,
      where?: Where,
    ): Promise<VectorSearchResult[]> => {
      const results: Array<VectorSearchResult & { _score: number }> = []

      for (const [_key, stored] of storage) {
        if (stored.poolName !== poolName) continue

        const score = cosineSimilarity(queryEmbedding, stored.embedding)

        try {
          const doc = await payload.findByID({
            collection: poolName as any,
            id: stored.id,
          })

          if (doc) {
            if (where && !matchesWhere(doc, where)) {
              continue
            }

            const {
              id: _id,
              createdAt: _createdAt,
              updatedAt: _updatedAt,
              embedding: _embedding,
              ...docFields
            } = doc as any

            results.push({
              id: stored.id,
              score,
              _score: score,
              ...docFields,
            })
          }
        } catch (_e) {
          // Document not found, skip
        }
      }

      return results
        .sort((a, b) => b._score - a._score)
        .slice(0, limit)
        .map(({ _score, ...rest }) => rest)
    },
  }
}

function matchesWhere(doc: Record<string, any>, where: Where): boolean {
  if (!where || Object.keys(where).length === 0) return true

  if ('and' in where && Array.isArray(where.and)) {
    return where.and.every((clause: Where) => matchesWhere(doc, clause))
  }

  if ('or' in where && Array.isArray(where.or)) {
    return where.or.some((clause: Where) => matchesWhere(doc, clause))
  }

  for (const [field, condition] of Object.entries(where)) {
    if (field === 'and' || field === 'or') continue

    const value = doc[field]

    if (typeof condition === 'object' && condition !== null) {
      if ('equals' in condition && value !== condition.equals) {
        return false
      }
      if ('in' in condition && Array.isArray(condition.in) && !condition.in.includes(value)) {
        return false
      }
      if ('exists' in condition) {
        const exists = value !== undefined && value !== null
        if (condition.exists !== exists) return false
      }
    }
  }

  return true
}
```

**Step 2: Commit**

```bash
git add dev/helpers/mockAdapter.ts
git commit -m "refactor: update mock adapter to new DbAdapter interface"
```

---

### Task 3: Update main plugin — vectorize.ts

**Files:**
- Modify: `src/tasks/vectorize.ts`

**Step 1: Replace payload.create() + adapter.storeEmbedding() with adapter.storeChunk()**

Replace lines 96-137 in `runVectorizeTask` with:

```typescript
  await adapter.deleteChunks(payload, poolName, collection, String(sourceDoc.id))

  const chunkData = await toKnowledgePoolFn(sourceDoc, payload)

  validateChunkData(chunkData, String(sourceDoc.id), collection)

  const chunkTexts = chunkData.map((item) => item.chunk)
  const vectors = await dynamicConfig.embeddingConfig.realTimeIngestionFn!(chunkTexts)

  await Promise.all(
    vectors.map(async (vector, index) => {
      const { chunk, ...extensionFields } = chunkData[index]
      await adapter.storeChunk(payload, poolName, {
        sourceCollection: collection,
        docId: String(sourceDoc.id),
        chunkIndex: index,
        chunkText: chunk,
        embeddingVersion,
        embedding: vector,
        extensionFields,
      })
    }),
  )
```

Remove the import of `deleteDocumentEmbeddings`.

**Step 2: Commit**

```bash
git add src/tasks/vectorize.ts
git commit -m "refactor: vectorize task uses adapter.storeChunk and adapter.deleteChunks"
```

---

### Task 4: Update main plugin — deleteDocumentEmbeddings.ts

**Files:**
- Modify: `src/utils/deleteDocumentEmbeddings.ts`

**Step 1: Replace two-step deletion with adapter.deleteChunks()**

```typescript
import type { Payload } from 'payload'
import type { DbAdapter, KnowledgePoolName } from '../types.js'

export async function deleteDocumentEmbeddings(args: {
  payload: Payload
  poolName: KnowledgePoolName
  collection: string
  docId: string
  adapter: DbAdapter
}): Promise<void> {
  const { payload, poolName, collection, docId, adapter } = args
  await adapter.deleteChunks(payload, poolName, collection, String(docId))
}
```

**Step 2: Commit**

```bash
git add src/utils/deleteDocumentEmbeddings.ts
git commit -m "refactor: deleteDocumentEmbeddings delegates to adapter.deleteChunks"
```

---

### Task 5: Update main plugin — bulkEmbedAll.ts

**Files:**
- Modify: `src/tasks/bulkEmbedAll.ts`

**Step 1: Replace docHasEmbeddingVersion with adapter.hasEmbeddingVersion**

In `streamAndBatchDocs` (around line 622), replace:

```typescript
        const hasCurrentEmbedding = await docHasEmbeddingVersion({
          payload,
          poolName,
          sourceCollection: collectionSlug,
          docId: String(doc.id),
          embeddingVersion,
        })
```

with:

```typescript
        const hasCurrentEmbedding = await adapter.hasEmbeddingVersion(
          payload,
          poolName,
          collectionSlug,
          String(doc.id),
          embeddingVersion,
        )
```

This requires adding `adapter` to the `streamAndBatchDocs` args and passing it through from the task handler.

**Step 2: Replace docHasEmbeddingVersion in pollAndCompleteSingleBatch (around line 882)**

Same replacement pattern:

```typescript
        const hasCurrentEmbedding = await adapter.hasEmbeddingVersion(
          payload,
          poolName,
          meta.sourceCollection,
          meta.docId,
          meta.embeddingVersion,
        )
```

**Step 3: Replace payload.create() + adapter.storeEmbedding() in pollAndCompleteSingleBatch (around line 907-927)**

Replace:

```typescript
      const created = await payload.create({
        collection: poolName as CollectionSlug,
        data: {
          sourceCollection: meta.sourceCollection,
          docId: String(meta.docId),
          chunkIndex: meta.chunkIndex,
          chunkText: meta.text,
          embeddingVersion: meta.embeddingVersion,
          ...(meta.extensionFields || {}),
          embedding: embeddingArray,
        },
      })

      await adapter.storeEmbedding(
        payload,
        poolName,
        meta.sourceCollection,
        String(meta.docId),
        String(created.id),
        embeddingArray,
      )
```

with:

```typescript
      await adapter.storeChunk(payload, poolName, {
        sourceCollection: meta.sourceCollection,
        docId: String(meta.docId),
        chunkIndex: meta.chunkIndex,
        chunkText: meta.text,
        embeddingVersion: meta.embeddingVersion,
        embedding: embeddingArray,
        extensionFields: (meta.extensionFields || {}) as Record<string, any>,
      })
```

**Step 4: Remove the local docHasEmbeddingVersion function** (lines 942-962)

**Step 5: Thread `adapter` through to `streamAndBatchDocs`**

Add `adapter: DbAdapter` to the `streamAndBatchDocs` args type and pass it from `createPrepareBulkEmbeddingTask`. The prepare task needs `adapter` added to its factory args (same as `createPollOrCompleteSingleBatchTask` already has).

Update `createPrepareBulkEmbeddingTask` signature:

```typescript
export const createPrepareBulkEmbeddingTask = ({
  knowledgePools,
  pollOrCompleteQueueName,
  prepareBulkEmbedQueueName,
  adapter,
}: {
  knowledgePools: Record<KnowledgePoolName, KnowledgePoolDynamicConfig>
  pollOrCompleteQueueName?: string
  prepareBulkEmbedQueueName?: string
  adapter: DbAdapter
}): TaskConfig<PrepareBulkEmbeddingTaskInputOutput> => {
```

**Step 6: Commit**

```bash
git add src/tasks/bulkEmbedAll.ts
git commit -m "refactor: bulk embed uses adapter.storeChunk, deleteChunks, hasEmbeddingVersion"
```

---

### Task 6: Update main plugin — src/index.ts (pass adapter to prepare task, move embeddings collection)

**Files:**
- Modify: `src/index.ts`

**Step 1: Pass adapter to createPrepareBulkEmbeddingTask**

Around line 174, add `adapter: pluginOptions.dbAdapter`:

```typescript
    const prepareBulkEmbedTask = createPrepareBulkEmbeddingTask({
      knowledgePools: pluginOptions.knowledgePools,
      pollOrCompleteQueueName: pluginOptions.bulkQueueNames?.pollOrCompleteQueueName,
      prepareBulkEmbedQueueName: pluginOptions.bulkQueueNames?.prepareBulkEmbedQueueName,
      adapter: pluginOptions.dbAdapter,
    })
```

**Step 2: Commit**

```bash
git add src/index.ts
git commit -m "refactor: pass adapter to prepare bulk embedding task"
```

---

### Task 7: Run existing tests to verify no regressions

**Step 1: Build**

Run: `pnpm build`
Expected: PASS (no type errors)

**Step 2: Run core tests**

Run: `pnpm test` (or the project's test command)
Expected: All existing tests pass. The mock adapter now handles `payload.create()` / `payload.delete()` internally, so test behavior should be identical.

**Step 3: Commit if any fixes needed**

---

### Task 8: Update PG adapter

**Files:**
- Modify: `adapters/pg/src/index.ts`
- Modify: `adapters/pg/src/embed.ts`

**Step 1: Add storeChunk, deleteChunks, hasEmbeddingVersion to PG adapter**

In `adapters/pg/src/index.ts`, replace:

```typescript
    search,
    storeEmbedding: embed,
```

with:

```typescript
    search,

    storeChunk: async (payload, poolName, data) => {
      const embeddingArray = Array.isArray(data.embedding) ? data.embedding : Array.from(data.embedding)

      const created = await payload.create({
        collection: poolName as any,
        data: {
          sourceCollection: data.sourceCollection,
          docId: data.docId,
          chunkIndex: data.chunkIndex,
          chunkText: data.chunkText,
          embeddingVersion: data.embeddingVersion,
          ...data.extensionFields,
          embedding: embeddingArray,
        },
      })

      await embed(payload, poolName, data.sourceCollection, data.docId, String(created.id), embeddingArray)
    },

    deleteChunks: async (payload, poolName, sourceCollection, docId) => {
      await payload.delete({
        collection: poolName as any,
        where: {
          and: [
            { sourceCollection: { equals: sourceCollection } },
            { docId: { equals: String(docId) } },
          ],
        },
      })
    },

    hasEmbeddingVersion: async (payload, poolName, sourceCollection, docId, embeddingVersion) => {
      const existing = await payload.find({
        collection: poolName as any,
        where: {
          and: [
            { sourceCollection: { equals: sourceCollection } },
            { docId: { equals: String(docId) } },
            { embeddingVersion: { equals: embeddingVersion } },
          ],
        },
        limit: 1,
      })
      return existing.totalDocs > 0
    },
```

**Step 2: Commit**

```bash
git add adapters/pg/src/index.ts
git commit -m "refactor: PG adapter implements storeChunk, deleteChunks, hasEmbeddingVersion"
```

---

### Task 9: Update CF adapter — storeChunk with metadata

**Files:**
- Modify: `adapters/cf/src/index.ts`
- Modify: `adapters/cf/src/embed.ts`

**Step 1: Update embed.ts to accept and store metadata**

```typescript
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
      },
    })
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e)
    payload.logger.error(`[@payloadcms-vectorize/cf] Failed to store embedding: ${errorMessage}`)
    throw new Error(`[@payloadcms-vectorize/cf] Failed to store embedding: ${errorMessage}`)
  }
}
```

**Step 2: Update index.ts — replace storeEmbedding, add deleteChunks and hasEmbeddingVersion**

Replace `storeEmbedding: embed` with `storeChunk: embed` (embed now has the new signature).

Replace `deleteEmbeddings` with `deleteChunks` (same logic, renamed).

Add `hasEmbeddingVersion`:

```typescript
    hasEmbeddingVersion: async (payload, poolName, sourceCollection, docId, embeddingVersion) => {
      const vectorizeBinding = getVectorizeBinding(payload)
      const dummyVector = new Array(Object.values(poolConfig)[0]?.dims || 384).fill(0)

      const results = await vectorizeBinding.query(dummyVector, {
        topK: 1,
        returnMetadata: 'all',
        filter: {
          docId: { $eq: docId },
          sourceCollection: { $eq: sourceCollection },
          embeddingVersion: { $eq: embeddingVersion },
        },
      })

      return (results.matches?.length ?? 0) > 0
    },
```

**Step 3: Commit**

```bash
git add adapters/cf/src/index.ts adapters/cf/src/embed.ts
git commit -m "refactor: CF adapter implements storeChunk with metadata, deleteChunks, hasEmbeddingVersion"
```

---

### Task 10: Update CF adapter — search with native filtering

**Files:**
- Modify: `adapters/cf/src/search.ts`

**Step 1: Rewrite search to use native Vectorize filtering and metadata**

```typescript
import { BasePayload, Where } from 'payload'
import { KnowledgePoolName, VectorSearchResult } from 'payloadcms-vectorize'
import { getVectorizeBinding } from './types.js'

export default async (
  payload: BasePayload,
  queryEmbedding: number[],
  poolName: KnowledgePoolName,
  limit: number = 10,
  where?: Where,
): Promise<Array<VectorSearchResult>> => {
  const vectorizeBinding = getVectorizeBinding(payload)

  try {
    const queryOptions: Record<string, any> = {
      topK: limit,
      returnMetadata: 'all' as const,
    }

    if (where) {
      const { nativeFilter, postFilter } = convertWhereToVectorizeFilter(where)
      if (nativeFilter && Object.keys(nativeFilter).length > 0) {
        queryOptions.filter = nativeFilter
      }
      if (postFilter) {
        // Will apply after query
      }
    }

    const results = await vectorizeBinding.query(queryEmbedding, queryOptions)

    if (!results.matches) {
      return []
    }

    let searchResults: VectorSearchResult[] = results.matches.map((match) => {
      const metadata = match.metadata || {}
      return {
        id: match.id,
        score: match.score || 0,
        sourceCollection: String(metadata.sourceCollection || ''),
        docId: String(metadata.docId || ''),
        chunkIndex: typeof metadata.chunkIndex === 'number' ? metadata.chunkIndex : parseInt(String(metadata.chunkIndex || '0'), 10),
        chunkText: String(metadata.chunkText || ''),
        embeddingVersion: String(metadata.embeddingVersion || ''),
        ...Object.fromEntries(
          Object.entries(metadata).filter(([k]) =>
            !['sourceCollection', 'docId', 'chunkIndex', 'chunkText', 'embeddingVersion'].includes(k)
          )
        ),
      }
    })

    if (where) {
      const { postFilter } = convertWhereToVectorizeFilter(where)
      if (postFilter) {
        searchResults = searchResults.filter((r) => matchesPostFilter(r, postFilter))
      }
    }

    return searchResults
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e)
    payload.logger.error(`[@payloadcms-vectorize/cf] Search failed: ${errorMessage}`)
    throw new Error(`[@payloadcms-vectorize/cf] Search failed: ${errorMessage}`)
  }
}

type VectorizeFilter = Record<string, Record<string, unknown>>
type PostFilterClause = Where

interface FilterSplit {
  nativeFilter: VectorizeFilter | null
  postFilter: PostFilterClause | null
}

const NATIVE_OPERATOR_MAP: Record<string, string> = {
  equals: '$eq',
  not_equals: '$ne',
  notEquals: '$ne',
  in: '$in',
  not_in: '$nin',
  notIn: '$nin',
  greater_than: '$gt',
  greaterThan: '$gt',
  greater_than_equal: '$gte',
  greaterThanEqual: '$gte',
  less_than: '$lt',
  lessThan: '$lt',
  less_than_equal: '$lte',
  lessThanEqual: '$lte',
}

function convertWhereToVectorizeFilter(where: Where): FilterSplit {
  const nativeFilter: VectorizeFilter = {}
  const postFilterClauses: Where[] = []

  if ('and' in where && Array.isArray(where.and)) {
    for (const clause of where.and) {
      const split = convertWhereToVectorizeFilter(clause)
      if (split.nativeFilter) {
        Object.assign(nativeFilter, split.nativeFilter)
      }
      if (split.postFilter) {
        postFilterClauses.push(split.postFilter)
      }
    }
    return {
      nativeFilter: Object.keys(nativeFilter).length > 0 ? nativeFilter : null,
      postFilter: postFilterClauses.length > 0 ? { and: postFilterClauses } : null,
    }
  }

  if ('or' in where && Array.isArray(where.or)) {
    // OR cannot be split — entire OR goes to post-filter if any clause is non-native
    const allNative = where.or.every((clause) => {
      const split = convertWhereToVectorizeFilter(clause)
      return split.postFilter === null
    })
    if (allNative) {
      // Vectorize doesn't support OR at top level, so post-filter
      return { nativeFilter: null, postFilter: where }
    }
    return { nativeFilter: null, postFilter: where }
  }

  for (const [fieldName, condition] of Object.entries(where)) {
    if (fieldName === 'and' || fieldName === 'or') continue
    if (typeof condition !== 'object' || condition === null || Array.isArray(condition)) continue

    const cond = condition as Record<string, unknown>
    let handled = false

    for (const [payloadOp, cfOp] of Object.entries(NATIVE_OPERATOR_MAP)) {
      if (payloadOp in cond) {
        nativeFilter[fieldName] = { [cfOp]: cond[payloadOp] }
        handled = true
        break
      }
    }

    if (!handled) {
      // like, contains, exists → post-filter
      postFilterClauses.push({ [fieldName]: condition } as Where)
    }
  }

  return {
    nativeFilter: Object.keys(nativeFilter).length > 0 ? nativeFilter : null,
    postFilter: postFilterClauses.length > 0
      ? (postFilterClauses.length === 1 ? postFilterClauses[0] : { and: postFilterClauses })
      : null,
  }
}

function matchesPostFilter(doc: Record<string, any>, where: Where): boolean {
  if (!where || Object.keys(where).length === 0) return true

  if ('and' in where && Array.isArray(where.and)) {
    return where.and.every((clause: Where) => matchesPostFilter(doc, clause))
  }

  if ('or' in where && Array.isArray(where.or)) {
    return where.or.some((clause: Where) => matchesPostFilter(doc, clause))
  }

  for (const [field, condition] of Object.entries(where)) {
    if (field === 'and' || field === 'or') continue
    if (typeof condition !== 'object' || condition === null) continue

    const value = doc[field]
    const cond = condition as Record<string, unknown>

    if ('like' in cond && typeof cond.like === 'string') {
      const pattern = String(cond.like).replace(/%/g, '.*')
      if (!new RegExp(`^${pattern}$`, 'i').test(String(value ?? ''))) return false
    }

    if ('contains' in cond && typeof cond.contains === 'string') {
      if (!String(value ?? '').toLowerCase().includes(String(cond.contains).toLowerCase())) return false
    }

    if ('exists' in cond && typeof cond.exists === 'boolean') {
      const exists = value !== undefined && value !== null
      if (cond.exists !== exists) return false
    }

    // Also handle native ops in post-filter for OR clauses
    if ('equals' in cond && value !== cond.equals) return false
    if ('not_equals' in cond && value === cond.not_equals) return false
    if ('notEquals' in cond && value === cond.notEquals) return false
    if ('in' in cond && Array.isArray(cond.in) && !cond.in.includes(value)) return false
    if ('not_in' in cond && Array.isArray(cond.not_in) && cond.not_in.includes(value)) return false
    if ('notIn' in cond && Array.isArray(cond.notIn) && (cond.notIn as any[]).includes(value)) return false
    if ('greater_than' in cond && !(value > (cond.greater_than as any))) return false
    if ('greaterThan' in cond && !(value > (cond.greaterThan as any))) return false
    if ('greater_than_equal' in cond && !(value >= (cond.greater_than_equal as any))) return false
    if ('greaterThanEqual' in cond && !(value >= (cond.greaterThanEqual as any))) return false
    if ('less_than' in cond && !(value < (cond.less_than as any))) return false
    if ('lessThan' in cond && !(value < (cond.lessThan as any))) return false
    if ('less_than_equal' in cond && !(value <= (cond.less_than_equal as any))) return false
    if ('lessThanEqual' in cond && !(value <= (cond.lessThanEqual as any))) return false
  }

  return true
}
```

**Step 2: Commit**

```bash
git add adapters/cf/src/search.ts
git commit -m "feat: CF search uses native Vectorize filtering + metadata"
```

---

### Task 11: Update CF README with limitations

**Files:**
- Modify: `adapters/cf/README.md`

**Step 1: Replace the "Known Limitations" section**

Replace from `## Known Limitations` to end of file with:

```markdown
## Known Limitations

### Metadata Filtering

The CF adapter uses Cloudflare Vectorize's native metadata filtering, which applies filters **before** the topK selection. This means filtering works correctly with the result limit for most operators.

**Natively supported operators** (applied before topK — correct result counts):
- `equals`, `not_equals`, `in`, `notIn`
- `greater_than`, `greater_than_equal`, `less_than`, `less_than_equal`

**Post-filtered operators** (applied after topK — may return fewer results than requested):
- `like`, `contains`, `exists`

### Vectorize Constraints

| Constraint | Limit |
|---|---|
| topK maximum | 100 (or 20 when returning metadata) |
| String metadata indexing | First 64 bytes only (truncated at UTF-8 boundaries) |
| Filter object size | Under 2048 bytes JSON-encoded |
| Range query accuracy | May be reduced on ~10M+ vectors |

Metadata indexes must exist before vectors are inserted for filtering to work.

### OR Queries

Cloudflare Vectorize does not support OR at the filter level. All `or` clauses are evaluated as post-filters, subject to the topK constraint.

## License

MIT
```

**Step 2: Commit**

```bash
git add adapters/cf/README.md
git commit -m "docs: update CF README with metadata filtering limitations"
```

---

### Task 12: Build and verify

**Step 1: Build everything**

Run: `pnpm build`
Expected: PASS

**Step 2: Run all tests**

Run: `pnpm test`
Expected: All tests pass

**Step 3: Final commit if any fixes**

---

### Task 13: Clean up — remove deleteDocumentEmbeddings export if now trivial

**Files:**
- Modify: `src/index.ts` (line 85)

**Step 1: Check if deleteDocumentEmbeddings is still exported and used externally**

If it's only used internally now and is just a pass-through to `adapter.deleteChunks`, consider whether the export is still needed. If it's in the public API, keep it. If not, remove the export from `src/index.ts` line 85.

**Step 2: Commit if changed**

```bash
git add src/index.ts
git commit -m "chore: clean up deleteDocumentEmbeddings export"
```
