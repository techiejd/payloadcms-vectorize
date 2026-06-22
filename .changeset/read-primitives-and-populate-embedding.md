---
"payloadcms-vectorize": minor
"@payloadcms-vectorize/pg": minor
"@payloadcms-vectorize/cf": minor
"@payloadcms-vectorize/mongodb": minor
---

Add vector read primitives and the ability to retrieve stored embedding vectors.

- **`vectorizedPayload.findByIds({ knowledgePool, ids, populateEmbedding })`** — batch-fetch embedding records by id, returning `Record<string, EmbeddingRecord | undefined>` (misses map to `undefined`). Implemented across the pg, cf, and mongodb adapters.
- **`vectorizedPayload.searchByEmbedding({ knowledgePool, embedding, where, limit, populateEmbedding })`** — run a vector search directly from a raw embedding vector, skipping the query-embedding step. This is the "more like this" primitive: feed it the `embedding` returned by `findByIds({ populateEmbedding: true })` to find similar content. Result shape and `where` filtering match `search()`. Unlike `search()`, it does not run reranking even on a pool configured with `rerank`, since rerankers operate on the original query text. Local API only.
- **`populateEmbedding?: boolean`** option (default `false`) on `search()` and `searchByEmbedding()` — when `true`, each result includes its stored embedding vector. `VectorSearchResult` and `EmbeddingRecord` now expose `embedding?: number[]`.

Fix:

- **mongodb adapter** `search()` now returns all stored fields (including extension fields) on each result, matching the pg and cf adapters for cross-adapter parity.
