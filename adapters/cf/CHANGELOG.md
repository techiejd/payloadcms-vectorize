# @payloadcms-vectorize/cf

## 1.1.0

### Minor Changes

- [#71](https://github.com/techiejd/payloadcms-vectorize/pull/71) [`98bc41b`](https://github.com/techiejd/payloadcms-vectorize/commit/98bc41b696dbb7f5762ee16589f208ad0d97ec9b) Thanks [@techiejd](https://github.com/techiejd)! - Add vector read primitives and the ability to retrieve stored embedding vectors.
  - **`vectorizedPayload.findByIds({ knowledgePool, ids, populateEmbedding })`** — batch-fetch embedding records by id, returning `Record<string, EmbeddingRecord | undefined>` (misses map to `undefined`). Implemented across the pg, cf, and mongodb adapters.
  - **`vectorizedPayload.searchByEmbedding({ knowledgePool, embedding, where, limit, populateEmbedding })`** — run a vector search directly from a raw embedding vector, skipping the query-embedding step. This is the "more like this" primitive: feed it the `embedding` returned by `findByIds({ populateEmbedding: true })` to find similar content. Result shape and `where` filtering match `search()`. Unlike `search()`, it does not run reranking even on a pool configured with `rerank`, since rerankers operate on the original query text. Local API only.
  - **`populateEmbedding?: boolean`** option (default `false`) on `search()` and `searchByEmbedding()` — when `true`, each result includes its stored embedding vector. `VectorSearchResult` and `EmbeddingRecord` now expose `embedding?: number[]`.

  Fix:
  - **mongodb adapter** `search()` now returns all stored fields (including extension fields) on each result, matching the pg and cf adapters for cross-adapter parity.

## 1.0.1

### Patch Changes

- [#65](https://github.com/techiejd/payloadcms-vectorize/pull/65) [`d8fea7a`](https://github.com/techiejd/payloadcms-vectorize/commit/d8fea7ad3b696285d9e7dada62704e25dd9760ba) Thanks [@techiejd](https://github.com/techiejd)! - Defer adapter config validation to call-time instead of throwing at construction.

  The mongodb and cf adapter factories previously threw on missing config (e.g. `uri`, `dbName`, `binding`) the moment they were called, which happens while the Payload config is being built. That broke `payload generate:types` and `generate:importmap` in environments without runtime variables — such as CI that builds `payload-types` to publish as a separate package. Validation now runs when an adapter method is actually invoked, so config-time codegen no longer requires runtime credentials. Valid configurations behave exactly as before.

  Closes #64.

- Updated dependencies [[`d8fea7a`](https://github.com/techiejd/payloadcms-vectorize/commit/d8fea7ad3b696285d9e7dada62704e25dd9760ba)]:
  - payloadcms-vectorize@1.0.1

## 1.0.0

### Minor Changes

- [#57](https://github.com/techiejd/payloadcms-vectorize/pull/57) [`19ea3a0`](https://github.com/techiejd/payloadcms-vectorize/commit/19ea3a0f2a0d2a94407c600000f8a46839d9c379) Thanks [@techiejd](https://github.com/techiejd)! - Add optional `rerank` callback on `EmbeddingConfig` for per-pool reranking. When configured, the plugin fetches `Math.floor(limit * multiplier)` candidates from the adapter, hands them to the user-supplied callback (`(query, results) => Promise<results>`), and trims the callback's output back down to the caller's `limit`. Provider-agnostic — bring your own Voyage / Cohere / local cross-encoder. `multiplier` must be a finite number `>= 1`; invalid configs are rejected at plugin init. Callback errors propagate to the caller.

### Patch Changes

- Updated dependencies [[`19ea3a0`](https://github.com/techiejd/payloadcms-vectorize/commit/19ea3a0f2a0d2a94407c600000f8a46839d9c379)]:
  - payloadcms-vectorize@1.0.0

## 0.7.4

### Patch Changes

- [#55](https://github.com/techiejd/payloadcms-vectorize/pull/55) [`b7862c7`](https://github.com/techiejd/payloadcms-vectorize/commit/b7862c77ba45a0867a337cf249c3cb8c8f71f511) Thanks [@techiejd](https://github.com/techiejd)! - Fix: reorder the vectorize task so existing chunks are deleted only after `toKnowledgePool` + embeddings succeed. Previously, a transient embedding-provider failure during re-vectorization would wipe a document's existing chunks before the new ones were ready, leaving the document temporarily unsearchable. Also documents a first-class Localization (i18n) pattern in the README.

- Updated dependencies [[`b7862c7`](https://github.com/techiejd/payloadcms-vectorize/commit/b7862c77ba45a0867a337cf249c3cb8c8f71f511)]:
  - payloadcms-vectorize@0.7.4

## 0.7.3

### Patch Changes

- [#52](https://github.com/techiejd/payloadcms-vectorize/pull/52) [`39076db`](https://github.com/techiejd/payloadcms-vectorize/commit/39076db031a224c46decf691eca7fe5569361895) Thanks [@techiejd](https://github.com/techiejd)! - Add `@payloadcms-vectorize/mongodb` adapter (Atlas + self-hosted Community 8.2+) backed by `$vectorSearch`, with pre/post filter splitting and full WHERE-clause parity across operators (equals, not_equals, in, notIn, like, contains, gt/gte/lt/lte, exists, and/or). Search indexes are auto-ensured on first use.

- Updated dependencies [[`39076db`](https://github.com/techiejd/payloadcms-vectorize/commit/39076db031a224c46decf691eca7fe5569361895)]:
  - payloadcms-vectorize@0.7.3

## 0.7.2

### Patch Changes

- [#46](https://github.com/techiejd/payloadcms-vectorize/pull/46) [`664b2b6`](https://github.com/techiejd/payloadcms-vectorize/commit/664b2b6965d8b9a80f315042fbdd4cd97a793dca) Thanks [@stevenlafl](https://github.com/stevenlafl)! - Fix missing TypeScript declarations in `@payloadcms-vectorize/pg` and `@payloadcms-vectorize/cf`. The build now runs `tsc` before SWC so `dist/index.d.ts` is actually emitted, and both adapters expose modern conditional `exports` with a types-first condition.

- Updated dependencies [[`664b2b6`](https://github.com/techiejd/payloadcms-vectorize/commit/664b2b6965d8b9a80f315042fbdd4cd97a793dca)]:
  - payloadcms-vectorize@0.7.2

## 0.7.0

### Patch Changes

- Fix CF adapter hasEmbeddingVersion ignoring version param, escape regex in like operator, handle empty WHERE in PG adapter, remove to-snake-case from root package.

- Updated dependencies []:
  - payloadcms-vectorize@0.7.0
