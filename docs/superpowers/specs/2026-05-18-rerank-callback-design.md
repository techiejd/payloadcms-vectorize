# Rerank Callback — Design Spec

**Date:** 2026-05-18
**Status:** Approved for planning
**Scope:** `payloadcms-vectorize` core plugin (no adapter changes)

## Goal

Let users plug a reranker into vector search without coupling the plugin to any specific reranking provider. The plugin runs the vector search, hands the candidates to the user's callback, and returns the reordered top results.

## Non-goals

- Shipping a provider-specific reranker (Voyage, Cohere, etc.). Users wire their own.
- Per-query reranker selection. A single reranker per knowledge pool.
- Streaming or partial results.

## API

### Type additions (`src/types.ts`)

```ts
export type RerankFn = (
  query: string,
  results: VectorSearchResult[],
) => Promise<VectorSearchResult[]>

export type RerankConfig = {
  /** DB fetches Math.floor(limit * multiplier) candidates before reranking.
   *  Must be a finite number >= 1. */
  multiplier: number
  callback: RerankFn
}
```

`EmbeddingConfig` gains an optional field:

```ts
export type EmbeddingConfig = {
  // ...existing fields
  rerank?: RerankConfig
}
```

`rerank` lives per-knowledge-pool inside `EmbeddingConfig`, alongside `queryFn` and `version`. Different pools can have different rerankers (or none).

### Caller-facing behavior

`VectorSearchQuery` is unchanged. `limit` still means "results returned to the caller" (default 10). Reranking is invisible to callers other than through ordering.

## Search pipeline

Implemented in `src/endpoints/vectorSearch.ts` inside the existing `vectorSearch` function.

1. Resolve `rerank = poolConfig.embeddingConfig.rerank`.
2. Compute fetch size:
   - If `rerank`: `fetchLimit = Math.floor(limit * rerank.multiplier)`.
   - Else: `fetchLimit = limit`.
3. Call `adapter.search(payload, queryEmbedding, knowledgePool, fetchLimit, where)`.
4. If `rerank`: `const reranked = await rerank.callback(query, results); return reranked.slice(0, limit)`.
5. Else: return adapter results as-is.

`where` is applied at the DB layer before the reranker sees anything. The reranker only operates on already-filtered candidates.

The `DbAdapter.search` interface is unchanged. Adapters do not know reranking exists; they just receive a larger `limit` when reranking is configured.

## Validation

At plugin initialization, for each pool with `rerank` configured, assert:

- `typeof multiplier === 'number'`
- `Number.isFinite(multiplier)`
- `multiplier >= 1`
- `typeof callback === 'function'`

Failures throw with a message identifying the offending pool. This runs alongside existing pool-config validation.

## Error handling

If the callback throws or rejects, the error propagates to the caller. No silent fallback to unranked results — a silent fallback would mask reranker outages and produce confusing relevance regressions.

## Output handling

The plugin trims the callback's result to `limit` after it returns. Callbacks may return:

- Exactly `limit` results — returned as-is.
- More than `limit` (e.g. all `fetchLimit` candidates re-ordered) — plugin slices to `limit`.
- Fewer than `limit` (e.g. callback dropped low-confidence items) — plugin returns the smaller count.

The callback is trusted to return `VectorSearchResult` shapes. The plugin does not reconstruct or revalidate results.

## Testing

New spec file `dev/specs/vectorSearchRerank.spec.ts`:

1. **No rerank configured** — existing behavior. Adapter receives the user's `limit`; results returned in cosine order.
2. **Rerank configured, integer multiplier** — adapter receives `limit * multiplier`. Use a spy/wrapper around the adapter to assert the fetch size.
3. **Rerank configured, float multiplier (1.5, limit=10)** — adapter receives `15`.
4. **Callback reorders** — callback reverses results; returned order reflects the reversal.
5. **Callback returns more than `limit`** — plugin trims to `limit`.
6. **Callback returns fewer than `limit`** — plugin returns the smaller count.
7. **Callback throws** — error propagates from `search()` to caller.
8. **Invalid multiplier at init** — `0`, `-1`, `NaN`, `Infinity` each throw at plugin init.
9. **Missing callback at init** — throws.

Tests follow the existing pattern in `dev/specs/vectorSearchWhere.spec.ts` (real Postgres, real fixtures).

## Docs

Add a "Reranking" section to the plugin README under the search docs:

- Shape of `RerankConfig`.
- One worked example using Voyage's rerank API (illustrative, not bundled).
- Note that `multiplier` controls the latency/recall tradeoff.

## Files touched

- `src/types.ts` — add `RerankFn`, `RerankConfig`; extend `EmbeddingConfig`.
- `src/endpoints/vectorSearch.ts` — wire rerank into the search function.
- `src/index.ts` — add multiplier/callback validation in the existing pool-config validation path.
- `dev/specs/vectorSearchRerank.spec.ts` — new test file.
- `README.md` — docs section.

No adapter changes (PG or MongoDB).
