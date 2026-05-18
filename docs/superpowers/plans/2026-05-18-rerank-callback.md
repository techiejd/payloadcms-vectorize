# Rerank Callback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in per-knowledge-pool `rerank` callback to `payloadcms-vectorize`, letting users widen the candidate pool, reorder via their own reranker, then return the top `limit`.

**Architecture:** A `RerankConfig` (`{ multiplier, callback }`) lives on each pool's `EmbeddingConfig`. The `vectorSearch` function fetches `Math.floor(limit * multiplier)` candidates from the adapter, passes them through the user callback, and trims to `limit`. No adapter changes. Errors propagate. Validation runs at plugin init.

**Tech Stack:** TypeScript, Vitest, Payload CMS plugin runtime, Postgres test infra via existing `createMockAdapter`.

**Spec:** [docs/superpowers/specs/2026-05-18-rerank-callback-design.md](../specs/2026-05-18-rerank-callback-design.md)

---

## File Structure

- **Modify** `src/types.ts` — add `RerankFn` and `RerankConfig` types; add optional `rerank` field on `EmbeddingConfig`.
- **Modify** `src/endpoints/vectorSearch.ts` — wire rerank into the search pipeline.
- **Modify** `src/index.ts` — validate `rerank` config inside the existing pool-iteration loop (around line 124).
- **Create** `dev/specs/vectorSearchRerank.spec.ts` — full behavior coverage.
- **Modify** `README.md` — add a "Reranking" section under the search docs.

---

## Task 1: Add types

**Files:**
- Modify: `src/types.ts:130-146` (extend `EmbeddingConfig`); insert new types just above it.

- [ ] **Step 1: Add `RerankFn` and `RerankConfig` types**

In `src/types.ts`, just before the `EmbeddingConfig` type declaration, add:

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

- [ ] **Step 2: Add optional `rerank` field on `EmbeddingConfig`**

Inside the existing `EmbeddingConfig` type, add as the last field:

```ts
  /** Optional reranker. When set, the search pipeline fetches
   *  Math.floor(limit * rerank.multiplier) candidates, passes them
   *  to rerank.callback, then trims to the requested limit. */
  rerank?: RerankConfig
```

- [ ] **Step 3: Re-export the new types from the package root**

In `src/index.ts`, find the `export type { ... } from './types.js'` block (starts around line 38). Inside it, find the `// EmbeddingConfig` comment marker and add `RerankFn` and `RerankConfig` underneath the existing `BulkEmbeddingsFns` line, so that block reads:

```ts
  // EmbeddingConfig
  EmbedQueryFn,
  EmbedDocsFn,
  BulkEmbeddingsFns,
  RerankFn,
  RerankConfig,
```

- [ ] **Step 4: Verify type-only compile**

Run: `pnpm tsc --noEmit -p tsconfig.json`
Expected: PASS (no errors). If the repo uses a different typecheck command (e.g. `pnpm typecheck`), use that.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/index.ts
git commit -m "feat(types): add and re-export RerankFn and RerankConfig types"
```

---

## Task 2: Test — rerank callback is called and reorders results

**Files:**
- Create: `dev/specs/vectorSearchRerank.spec.ts`

This task uses TDD. The test will fail because the wiring doesn't exist yet — Task 3 implements the wiring.

- [ ] **Step 1: Write the failing test file**

Create `dev/specs/vectorSearchRerank.spec.ts`:

```ts
import type { Payload, BasePayload, Where } from 'payload'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { getPayload, buildConfig } from 'payload'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { makeDummyEmbedDocs, makeDummyEmbedQuery, testEmbeddingVersion } from 'helpers/embed.js'
import { chunkText } from 'helpers/chunkers.js'
import { createMockAdapter } from 'helpers/mockAdapter.js'
import {
  createTestDb,
  destroyPayload,
  waitForVectorizationJobs,
} from './utils.js'
import { DIMS } from './constants.js'
import payloadcmsVectorize, {
  type DbAdapter,
  type KnowledgePoolDynamicConfig,
  type RerankFn,
  type VectorSearchResult,
} from 'payloadcms-vectorize'
import { createVectorSearchHandlers } from '../../src/endpoints/vectorSearch.js'

const dbName = 'rerank_test'

type AdapterCall = { limit: number | undefined }

/** Wrap an adapter to record the limit passed to search(). */
function wrapAdapter(adapter: DbAdapter): { adapter: DbAdapter; calls: AdapterCall[] } {
  const calls: AdapterCall[] = []
  const origSearch = adapter.search
  const wrapped: DbAdapter = {
    ...adapter,
    search: async (
      payload: BasePayload,
      queryEmbedding: number[],
      poolName: string,
      limit?: number,
      where?: Where,
    ): Promise<VectorSearchResult[]> => {
      calls.push({ limit })
      return origSearch(payload, queryEmbedding, poolName, limit, where)
    },
  }
  return { adapter: wrapped, calls }
}

function buildPools(rerank?: {
  multiplier: number
  callback: RerankFn
}): Record<string, KnowledgePoolDynamicConfig> {
  return {
    default: {
      collections: {
        posts: {
          toKnowledgePool: async (doc) => {
            const chunks: Array<{ chunk: string }> = []
            if (doc.title) chunks.push(...chunkText(doc.title).map((c) => ({ chunk: c })))
            return chunks
          },
        },
      },
      embeddingConfig: {
        version: testEmbeddingVersion,
        queryFn: makeDummyEmbedQuery(DIMS),
        realTimeIngestionFn: makeDummyEmbedDocs(DIMS),
        ...(rerank ? { rerank } : {}),
      },
    },
  }
}

describe('rerank callback', () => {
  let payload: Payload
  let baseAdapter: DbAdapter

  beforeAll(async () => {
    await createTestDb({ dbName })
    baseAdapter = createMockAdapter()

    const config = await buildConfig({
      collections: [
        {
          slug: 'posts',
          fields: [{ name: 'title', type: 'text' }],
        },
      ],
      db: postgresAdapter({
        pool: {
          connectionString: `postgresql://postgres:password@localhost:5433/${dbName}`,
        },
      }),
      plugins: [
        payloadcmsVectorize({
          dbAdapter: baseAdapter,
          knowledgePools: buildPools(),
        }),
      ],
      secret: 'rerank-test-secret',
      jobs: { tasks: [] },
    })

    payload = await getPayload({
      config,
      key: `rerank-test-${Date.now()}`,
      cron: false,
    })

    // Seed three posts so we have multiple results to reorder.
    for (const title of ['alpha', 'bravo', 'charlie']) {
      await payload.create({ collection: 'posts', data: { title } })
    }
    await waitForVectorizationJobs(payload)
  })

  afterAll(async () => {
    await destroyPayload(payload)
  })

  test('callback is invoked and its order is preserved', async () => {
    const callback = vi.fn(async (_query: string, results: VectorSearchResult[]) => {
      // Reverse — proves the plugin honored the callback's order.
      return [...results].reverse()
    })

    // Baseline: a separate handlers with NO rerank, so the callback only fires once total.
    const baselinePools = buildPools()
    const baselineAdapter = wrapAdapter(baseAdapter).adapter
    const baselineHandlers = createVectorSearchHandlers(baselinePools, baselineAdapter)

    const rerankPools = buildPools({ multiplier: 1, callback })
    const { adapter: rerankAdapter } = wrapAdapter(baseAdapter)
    const rerankHandlers = createVectorSearchHandlers(rerankPools, rerankAdapter)

    const baseline = await baselineHandlers.vectorSearch(payload, 'alpha', 'default', 3)
    const reranked = await rerankHandlers.vectorSearch(payload, 'alpha', 'default', 3)

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback.mock.calls[0][0]).toBe('alpha')
    expect(reranked.map((r) => r.id)).toEqual([...baseline.map((r) => r.id)].reverse())
  })
})
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm test dev/specs/vectorSearchRerank.spec.ts`
Expected: FAIL on the assertion `expect(callback).toHaveBeenCalledTimes(1)` — the callback is never invoked because the wiring in `vectorSearch` doesn't exist yet. (Imports resolve because Task 1 already re-exports `RerankFn`.)

- [ ] **Step 3: Commit the failing test**

```bash
git add dev/specs/vectorSearchRerank.spec.ts
git commit -m "test(rerank): add failing test for callback invocation and ordering"
```

---

## Task 3: Wire rerank into `vectorSearch`

**Files:**
- Modify: `src/endpoints/vectorSearch.ts:14-30`

- [ ] **Step 1: Update `vectorSearch` to call the rerank callback**

Replace the body of the `vectorSearch` function in `src/endpoints/vectorSearch.ts` with:

```ts
  const vectorSearch = async (
    payload: BasePayload,
    query: string,
    knowledgePool: KnowledgePoolName,
    limit?: number,
    where?: Where,
  ) => {
    const poolConfig = knowledgePools[knowledgePool]
    const queryEmbedding = await (async () => {
      const qE = await poolConfig.embeddingConfig.queryFn(query)
      return Array.isArray(qE) ? qE : Array.from(qE)
    })()

    const rerank = poolConfig.embeddingConfig.rerank

    // Non-rerank path: preserve existing behavior. Forward `limit` as-is
    // (possibly undefined) so the adapter keeps deciding its own default.
    if (!rerank) {
      return adapter.search(payload, queryEmbedding, knowledgePool, limit, where)
    }

    // Rerank path: we must materialize a concrete fetch size, so apply the
    // default of 10 only here.
    const effectiveLimit = limit ?? 10
    const fetchLimit = Math.floor(effectiveLimit * rerank.multiplier)

    const candidates = await adapter.search(
      payload,
      queryEmbedding,
      knowledgePool,
      fetchLimit,
      where,
    )

    const reranked = await rerank.callback(query, candidates)
    return reranked.slice(0, effectiveLimit)
  }
```

- [ ] **Step 2: Run the test and verify it passes**

Run: `pnpm test dev/specs/vectorSearchRerank.spec.ts`
Expected: PASS — the `'callback is invoked and its order is preserved'` test passes.

- [ ] **Step 3: Commit**

```bash
git add src/endpoints/vectorSearch.ts
git commit -m "feat(rerank): wire rerank callback into vectorSearch pipeline"
```

---

## Task 4: Test + verify multiplier expands fetch size

**Files:**
- Modify: `dev/specs/vectorSearchRerank.spec.ts`

- [ ] **Step 1: Add tests for fetch-size expansion**

Append inside the `describe('rerank callback', () => { ... })` block:

```ts
  test('multiplier=3 fetches limit*3 candidates from the adapter', async () => {
    const callback = vi.fn(async (_q: string, results: VectorSearchResult[]) => results)
    const pools = buildPools({ multiplier: 3, callback })
    const { adapter, calls } = wrapAdapter(baseAdapter)
    const handlers = createVectorSearchHandlers(pools, adapter)

    await handlers.vectorSearch(payload, 'alpha', 'default', 2)

    expect(calls).toHaveLength(1)
    expect(calls[0].limit).toBe(6)
  })

  test('float multiplier=1.5 with limit=10 fetches 15 candidates (Math.floor)', async () => {
    const callback = vi.fn(async (_q: string, results: VectorSearchResult[]) => results)
    const pools = buildPools({ multiplier: 1.5, callback })
    const { adapter, calls } = wrapAdapter(baseAdapter)
    const handlers = createVectorSearchHandlers(pools, adapter)

    await handlers.vectorSearch(payload, 'alpha', 'default', 10)

    expect(calls).toHaveLength(1)
    expect(calls[0].limit).toBe(15)
  })

  test('no rerank configured: adapter receives the unmodified limit', async () => {
    const pools = buildPools()
    const { adapter, calls } = wrapAdapter(baseAdapter)
    const handlers = createVectorSearchHandlers(pools, adapter)

    await handlers.vectorSearch(payload, 'alpha', 'default', 4)

    expect(calls).toHaveLength(1)
    expect(calls[0].limit).toBe(4)
  })
```

- [ ] **Step 2: Run the tests and verify they pass**

Run: `pnpm test dev/specs/vectorSearchRerank.spec.ts`
Expected: PASS (all four tests).

- [ ] **Step 3: Commit**

```bash
git add dev/specs/vectorSearchRerank.spec.ts
git commit -m "test(rerank): verify multiplier expands adapter fetch size"
```

---

## Task 5: Test trimming behaviors

**Files:**
- Modify: `dev/specs/vectorSearchRerank.spec.ts`

- [ ] **Step 1: Add tests for trimming**

Append to the `describe` block:

```ts
  test('callback returning more than limit: plugin trims to limit', async () => {
    const callback = vi.fn(async (_q: string, results: VectorSearchResult[]) => results)
    const pools = buildPools({ multiplier: 3, callback })
    const { adapter } = wrapAdapter(baseAdapter)
    const handlers = createVectorSearchHandlers(pools, adapter)

    const out = await handlers.vectorSearch(payload, 'alpha', 'default', 2)

    // Callback receives up to 6 candidates and returns them all; plugin slices to 2.
    expect(out).toHaveLength(2)
  })

  test('callback returning fewer than limit: plugin returns the smaller count', async () => {
    const callback = vi.fn(async (_q: string, results: VectorSearchResult[]) => results.slice(0, 1))
    const pools = buildPools({ multiplier: 3, callback })
    const { adapter } = wrapAdapter(baseAdapter)
    const handlers = createVectorSearchHandlers(pools, adapter)

    const out = await handlers.vectorSearch(payload, 'alpha', 'default', 3)

    expect(out).toHaveLength(1)
  })
```

- [ ] **Step 2: Run the tests and verify they pass**

Run: `pnpm test dev/specs/vectorSearchRerank.spec.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add dev/specs/vectorSearchRerank.spec.ts
git commit -m "test(rerank): verify post-callback trimming to limit"
```

---

## Task 6: Test error propagation

**Files:**
- Modify: `dev/specs/vectorSearchRerank.spec.ts`

- [ ] **Step 1: Add error-propagation test**

Append to the `describe` block:

```ts
  test('callback rejection propagates to the caller', async () => {
    const callback = vi.fn(async () => {
      throw new Error('reranker down')
    })
    const pools = buildPools({ multiplier: 2, callback })
    const { adapter } = wrapAdapter(baseAdapter)
    const handlers = createVectorSearchHandlers(pools, adapter)

    await expect(handlers.vectorSearch(payload, 'alpha', 'default', 2)).rejects.toThrow(
      'reranker down',
    )
  })
```

- [ ] **Step 2: Run the tests and verify it passes**

Run: `pnpm test dev/specs/vectorSearchRerank.spec.ts`
Expected: PASS — the wiring in Task 3 awaits `rerank.callback(...)`, so a rejection naturally propagates.

- [ ] **Step 3: Commit**

```bash
git add dev/specs/vectorSearchRerank.spec.ts
git commit -m "test(rerank): verify callback errors propagate"
```

---

## Task 7: Init-time validation of `rerank` config

**Files:**
- Create: `dev/specs/rerankValidation.spec.ts`
- Modify: `src/index.ts:124-135` (extend the existing per-pool loop)

- [ ] **Step 1: Write failing validation tests**

Create `dev/specs/rerankValidation.spec.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { buildConfig } from 'payload'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { makeDummyEmbedDocs, makeDummyEmbedQuery, testEmbeddingVersion } from 'helpers/embed.js'
import { createMockAdapter } from 'helpers/mockAdapter.js'
import payloadcmsVectorize, { type RerankFn } from 'payloadcms-vectorize'
import { DIMS } from './constants.js'

const dbName = 'rerank_validation_test'

const buildWithRerank = async (rerank: any) =>
  buildConfig({
    collections: [{ slug: 'posts', fields: [{ name: 'title', type: 'text' }] }],
    db: postgresAdapter({
      pool: {
        connectionString: `postgresql://postgres:password@localhost:5433/${dbName}`,
      },
    }),
    plugins: [
      payloadcmsVectorize({
        dbAdapter: createMockAdapter(),
        knowledgePools: {
          default: {
            collections: {
              posts: {
                toKnowledgePool: async (doc) => (doc.title ? [{ chunk: doc.title }] : []),
              },
            },
            embeddingConfig: {
              version: testEmbeddingVersion,
              queryFn: makeDummyEmbedQuery(DIMS),
              realTimeIngestionFn: makeDummyEmbedDocs(DIMS),
              rerank,
            },
          },
        },
      }),
    ],
    secret: 'rerank-validation-secret',
    jobs: { tasks: [] },
  })

const validCallback: RerankFn = async (_q, r) => r

describe('rerank config validation', () => {
  test('multiplier = 0 throws', async () => {
    await expect(buildWithRerank({ multiplier: 0, callback: validCallback })).rejects.toThrow(
      /multiplier/i,
    )
  })

  test('multiplier = -1 throws', async () => {
    await expect(buildWithRerank({ multiplier: -1, callback: validCallback })).rejects.toThrow(
      /multiplier/i,
    )
  })

  test('multiplier = NaN throws', async () => {
    await expect(buildWithRerank({ multiplier: NaN, callback: validCallback })).rejects.toThrow(
      /multiplier/i,
    )
  })

  test('multiplier = Infinity throws', async () => {
    await expect(
      buildWithRerank({ multiplier: Infinity, callback: validCallback }),
    ).rejects.toThrow(/multiplier/i)
  })

  test('callback not a function throws', async () => {
    await expect(buildWithRerank({ multiplier: 2, callback: 'nope' as any })).rejects.toThrow(
      /callback/i,
    )
  })

  test('valid config does not throw', async () => {
    await expect(
      buildWithRerank({ multiplier: 1.5, callback: validCallback }),
    ).resolves.toBeTruthy()
  })
})
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `pnpm test dev/specs/rerankValidation.spec.ts`
Expected: FAIL — the invalid-config cases resolve instead of throwing because no validation exists yet.

- [ ] **Step 3: Add validation to plugin init**

In `src/index.ts`, find the existing per-pool loop around line 124 (the loop that builds `collectionToPools`). Just before that loop's closing brace, add a validation block. The final loop should look like:

```ts
    for (const poolName in pluginOptions.knowledgePools) {
      const dynamicConfig = pluginOptions.knowledgePools[poolName]

      // Build reverse mapping for hooks
      const collectionSlugs = Object.keys(dynamicConfig.collections)
      for (const collectionSlug of collectionSlugs) {
        if (!collectionToPools.has(collectionSlug)) {
          collectionToPools.set(collectionSlug, [])
        }
        collectionToPools.get(collectionSlug)!.push({ pool: poolName, dynamic: dynamicConfig })
      }

      // Validate rerank config (if present)
      const rerank = dynamicConfig.embeddingConfig.rerank
      if (rerank !== undefined) {
        if (
          typeof rerank.multiplier !== 'number' ||
          !Number.isFinite(rerank.multiplier) ||
          rerank.multiplier < 1
        ) {
          throw new Error(
            `[payloadcms-vectorize] Pool "${poolName}": rerank.multiplier must be a finite number >= 1 (got ${String(rerank.multiplier)}).`,
          )
        }
        if (typeof rerank.callback !== 'function') {
          throw new Error(
            `[payloadcms-vectorize] Pool "${poolName}": rerank.callback must be a function.`,
          )
        }
      }
    }
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `pnpm test dev/specs/rerankValidation.spec.ts`
Expected: PASS (all six tests).

- [ ] **Step 5: Run the full spec to ensure nothing regressed**

Run: `pnpm test dev/specs/vectorSearchRerank.spec.ts dev/specs/rerankValidation.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts dev/specs/rerankValidation.spec.ts
git commit -m "feat(rerank): validate rerank config at plugin init"
```

---

## Task 8: Run full test suite and typecheck

**Files:** none

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test`
Expected: PASS (no regressions in other specs).

- [ ] **Step 2: Run typecheck**

Run: `pnpm tsc --noEmit -p tsconfig.json` (or the repo's `pnpm typecheck` if it exists — check `package.json` scripts).
Expected: PASS.

- [ ] **Step 3: If anything fails, fix in place and commit**

Diagnose any failure, fix the root cause (do not weaken tests), commit as `fix(rerank): <description>`.

---

## Task 9: README docs

**Files:**
- Modify: `README.md` — add a "Reranking" section beneath the existing search docs.

- [ ] **Step 1: Add the docs section**

Locate the search section in `README.md` (`grep -n "search" README.md`) and append a new subsection:

````markdown
### Reranking (optional)

Pass a `rerank` config on a pool's `embeddingConfig` to reorder candidates with your own reranker (e.g. Voyage, Cohere, a local cross-encoder):

```ts
embeddingConfig: {
  version: 'v1',
  queryFn,
  realTimeIngestionFn,
  rerank: {
    // DB fetches Math.floor(limit * multiplier) candidates before reranking.
    // Higher multiplier = better recall, more latency, more cost.
    multiplier: 4,
    callback: async (query, results) => {
      const ranked = await myReranker.rerank({
        query,
        documents: results.map((r) => r.chunkText),
      })
      // Return VectorSearchResults in your desired order.
      return ranked.map((r) => results[r.index])
    },
  },
}
```

The plugin trims the callback's output to the caller's `limit`. Errors thrown by the callback propagate to the caller.
````

- [ ] **Step 2: Verify markdown renders sensibly**

Run: `grep -n "Reranking" README.md`
Expected: matches the new heading.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(rerank): document RerankConfig usage in README"
```

---

## Task 10: Changeset

**Files:**
- Create: `.changeset/<auto-named>.md`

- [ ] **Step 1: Generate a changeset**

Run: `pnpm changeset` and select `payloadcms-vectorize` with a `minor` bump (new feature, backwards compatible). Summary: `Add optional rerank callback on EmbeddingConfig for per-pool reranking.`

If the repo has a non-interactive changeset convention (look at recent files in `.changeset/`), follow that pattern instead and create the file directly.

- [ ] **Step 2: Commit**

```bash
git add .changeset/
git commit -m "chore(changeset): add minor bump for rerank callback feature"
```

---

## Done

All tasks complete when:
- `pnpm test` passes
- Typecheck passes
- README has the Reranking section
- A changeset is committed
- New tests in `dev/specs/vectorSearchRerank.spec.ts` and `dev/specs/rerankValidation.spec.ts` cover: callback invocation, ordering, multiplier expansion (int + float), no-rerank baseline, trimming (over/under limit), error propagation, init validation (multiplier 0/-1/NaN/Infinity, non-function callback, valid config).
