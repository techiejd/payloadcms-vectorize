# Design: Adapter Owns Storage

## Problem

The main plugin assumes all adapters use a PayloadCMS collection for embedding storage. It calls `payload.create()` and `payload.delete()` on the embeddings collection directly, then calls `adapter.storeEmbedding()` as a second step. This leaks storage concerns into adapter-agnostic code.

For the PG adapter this works — it just updates a vector column on the row the main plugin created. For the CF adapter, the PayloadCMS row is dead weight — CF stores vectors in Cloudflare Vectorize, a separate service. The embeddings collection row is never read by CF search.

Additionally, the CF adapter's search has broken metadata filtering:
- Only supports 3 of 11 WHERE operators (equals, in, exists)
- Post-filters after topK instead of using Vectorize's native filter parameter
- topK is capped at 100 (or 20 with metadata), making post-filtering unviable
- Fetches from the main collection instead of embeddings-specific data

## Solution

Make the adapter responsible for all chunk storage, deletion, and version checking. The main plugin delegates these operations entirely.

## New DbAdapter API

```ts
type DbAdapter = {
  getConfigExtension: (config: Config) => {
    bins?: { key: string; scriptPath: string }[]
    custom?: Record<string, any>
    collections?: Record<string, CollectionConfig>
  }

  storeChunk: (
    payload: Payload,
    poolName: string,
    data: {
      sourceCollection: string
      docId: string
      chunkIndex: number
      chunkText: string
      embeddingVersion: string
      embedding: number[] | Float32Array
      extensionFields: Record<string, any>
    },
  ) => Promise<void>

  deleteChunks: (
    payload: Payload,
    poolName: string,
    sourceCollection: string,
    docId: string,
  ) => Promise<void>

  hasEmbeddingVersion: (
    payload: Payload,
    poolName: string,
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

Removed: `storeEmbedding`, `deleteEmbeddings`

## PG Adapter Changes

- `storeChunk`: `payload.create()` on embeddings collection + UPDATE vector column (combines current two-step flow)
- `deleteChunks`: `payload.delete()` on embeddings collection (moved from main plugin's `deleteDocumentEmbeddings`)
- `hasEmbeddingVersion`: `payload.find()` on embeddings collection (moved from main plugin's `docHasEmbeddingVersion`)
- `search`: unchanged

## CF Adapter Changes

- `storeChunk`: upserts to Vectorize with metadata on the vector + creates cfMapping row. No embeddings collection.
- `deleteChunks`: existing flow — query cfMappings, `deleteByIds` from Vectorize, delete cfMappings
- `hasEmbeddingVersion`: queries Vectorize by metadata filter for docId + embeddingVersion
- `search`: converts Payload `where` to Vectorize `filter` format, queries with `returnMetadata: "all"`, builds results from vector metadata. Post-filters only for `like`, `contains`, `exists` (no native CF equivalent).

## Main Plugin Changes

- `src/tasks/vectorize.ts`: remove `payload.create()`, call `adapter.storeChunk()`
- `src/tasks/bulkEmbedAll.ts`: replace `payload.create()` + `adapter.storeEmbedding()` with `adapter.storeChunk()`. Replace `docHasEmbeddingVersion()` with `adapter.hasEmbeddingVersion()`
- `src/utils/deleteDocumentEmbeddings.ts`: replace both steps with `adapter.deleteChunks()`
- Embeddings collection creation moves to adapter's `getConfigExtension` (PG provides it, CF doesn't need it)

## CF Vectorize Filter Mapping

| Payload Operator | Vectorize Filter | Implementation |
|---|---|---|
| equals | $eq | Native filter |
| not_equals | $ne | Native filter |
| in | $in | Native filter |
| notIn | $nin | Native filter |
| greater_than | $gt | Native filter |
| greater_than_equal | $gte | Native filter |
| less_than | $lt | Native filter |
| less_than_equal | $lte | Native filter |
| like | — | JS post-filter |
| contains | — | JS post-filter |
| exists | — | JS post-filter |

## CF Adapter Limitations (for README)

- String metadata indexed only for first 64 bytes (truncated at UTF-8 boundaries)
- `like`, `contains`, `exists` operators applied post-query, constrained by topK
- topK max 20 when returning metadata, 100 without
- Range queries on ~10M+ vectors may have reduced accuracy
- Filter objects must be under 2048 bytes JSON-encoded
- Metadata indexes must exist before vectors are inserted
