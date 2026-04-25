# MongoDB Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@payloadcms-vectorize/mongodb` — a `DbAdapter` for `payloadcms-vectorize` that targets MongoDB Atlas and self-hosted MongoDB Community 8.2+ via the unified `$vectorSearch` aggregation stage.

**Architecture:** Single npm package under `adapters/mongodb/` mirroring the layout of `adapters/cf/`. The adapter holds a lazy singleton `MongoClient`, manages one Mongo collection per knowledge pool, lazily ensures a `vectorSearch` index, and translates Payload `Where` clauses into a pre-filter (inside `$vectorSearch.filter`) plus a post-filter (`$match` after the vector scan). No Payload `CollectionConfig` is registered — vector documents are managed via the raw MongoDB driver.

**Tech Stack:** TypeScript, Node.js MongoDB driver (`mongodb`), `vitest`, `payload` 3.x peerDep, `mongodb/mongodb-atlas-local` Docker image for local dev + CI.

**Spec:** [`docs/superpowers/specs/2026-04-25-mongodb-adapter.md`](../specs/2026-04-25-mongodb-adapter.md).

---

## File Structure

```
adapters/mongodb/
├── package.json                   # Task 1
├── tsconfig.build.json            # Task 1
├── vitest.config.ts               # Task 1
├── README.md                      # Task 17
├── src/
│   ├── escapeRegExp.ts            # Task 2 — pure utility
│   ├── types.ts                   # Task 3 — public types, getMongoConfig() helper
│   ├── client.ts                  # Task 4 — lazy singleton MongoClient + __closeForTests
│   ├── convertWhere.ts            # Tasks 5–8 — pre/post-filter splitter
│   ├── indexes.ts                 # Task 9 — ensureSearchIndex + cache
│   ├── embed.ts                   # Task 10 — storeChunk
│   ├── search.ts                  # Tasks 11–12 — search aggregation
│   └── index.ts                   # Task 13 — createMongoVectorIntegration wiring
└── dev/
    ├── docker-compose.yml         # Task 14
    └── specs/
        ├── constants.ts           # Task 15
        ├── utils.ts               # Task 15 — waitForVectorSearchReady, dropDb
        ├── compliance.spec.ts     # Task 15
        ├── vectorSearchWhere.spec.ts  # Task 16
        └── integration.spec.ts    # Task 16
```

Top-level files touched:
- `package.json` — add `build:adapters:mongodb`, `test:adapters:mongodb`, chain into `build:adapters`. (Task 18)
- `.changeset/config.json` — add `@payloadcms-vectorize/mongodb` to the `fixed` array. (Task 18)
- `.github/workflows/ci.yml` — add `test_adapters_mongodb` job. (Task 19)

---

## Task 1: Package skeleton (`adapters/mongodb/package.json`, tsconfig, vitest)

**Files:**
- Create: `adapters/mongodb/package.json`
- Create: `adapters/mongodb/tsconfig.build.json`
- Create: `adapters/mongodb/vitest.config.ts`

- [ ] **Step 1: Write `adapters/mongodb/package.json`**

```json
{
  "name": "@payloadcms-vectorize/mongodb",
  "version": "0.7.2",
  "description": "MongoDB Atlas + self-hosted vectorSearch adapter for payloadcms-vectorize",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/techiejd/payloadcms-vectorize.git",
    "directory": "adapters/mongodb"
  },
  "homepage": "https://github.com/techiejd/payloadcms-vectorize/tree/main/adapters/mongodb#readme",
  "bugs": {
    "url": "https://github.com/techiejd/payloadcms-vectorize/issues"
  },
  "type": "module",
  "files": [
    "dist",
    "README.md"
  ],
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "test:setup": "docker-compose -f dev/docker-compose.yml up -d",
    "test:teardown": "docker-compose -f dev/docker-compose.yml down"
  },
  "keywords": [
    "payloadcms",
    "mongodb",
    "vector-search",
    "rag",
    "experimental"
  ],
  "peerDependencies": {
    "mongodb": ">=6.0.0",
    "payload": ">=3.0.0 <4.0.0",
    "payloadcms-vectorize": ">=0.7.2"
  },
  "devDependencies": {
    "mongodb": "^6.10.0",
    "payloadcms-vectorize": "workspace:*"
  },
  "engines": {
    "node": "^18.20.2 || >=20.9.0",
    "pnpm": "^9 || ^10"
  },
  "publishConfig": {
    "exports": {
      ".": {
        "types": "./dist/index.d.ts",
        "import": "./dist/index.js",
        "default": "./dist/index.js"
      }
    },
    "main": "./dist/index.js",
    "types": "./dist/index.d.ts"
  }
}
```

- [ ] **Step 2: Write `adapters/mongodb/tsconfig.build.json`**

```json
{
  "extends": "../tsconfig.adapter.json"
}
```

- [ ] **Step 3: Write `adapters/mongodb/vitest.config.ts`** (mirrors `adapters/cf/vitest.config.ts`)

```ts
import path from 'path'
import { loadEnv } from 'payload/node'
import { fileURLToPath } from 'url'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

export default defineConfig(() => {
  loadEnv(path.resolve(dirname, '../../dev'))

  return {
    plugins: [
      tsconfigPaths({
        ignoreConfigErrors: true,
      }),
    ],
    resolve: {
      alias: {
        'payloadcms-vectorize': path.resolve(dirname, '../../src/index.ts'),
      },
    },
    test: {
      root: dirname,
      environment: 'node',
      hookTimeout: 120_000,
      testTimeout: 120_000,
      include: ['dev/specs/**/*.spec.ts'],
      exclude: ['**/e2e.spec.{ts,js}', '**/node_modules/**'],
      fileParallelism: false,
    },
  }
})
```

- [ ] **Step 4: Install workspace deps**

Run: `pnpm install`
Expected: `mongodb` and `payloadcms-vectorize` linked under `adapters/mongodb/node_modules/`. No errors.

- [ ] **Step 5: Verify build skeleton compiles**

Run: `cd adapters/mongodb && pnpm exec tsc -p tsconfig.build.json --noEmit`
Expected: PASS (no `src/` files yet, but config must parse).

- [ ] **Step 6: Commit**

```bash
git add adapters/mongodb/package.json adapters/mongodb/tsconfig.build.json adapters/mongodb/vitest.config.ts pnpm-lock.yaml
git commit -m "feat(mongodb): scaffold adapter package skeleton"
```

---

## Task 2: `escapeRegExp` utility

**Files:**
- Create: `adapters/mongodb/src/escapeRegExp.ts`
- Create: `adapters/mongodb/dev/specs/escapeRegExp.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// adapters/mongodb/dev/specs/escapeRegExp.spec.ts
import { describe, expect, test } from 'vitest'
import { escapeRegExp } from '../../src/escapeRegExp.js'

describe('escapeRegExp', () => {
  test('escapes regex metacharacters', () => {
    expect(escapeRegExp('foo.bar')).toBe('foo\\.bar')
    expect(escapeRegExp('a*b')).toBe('a\\*b')
    expect(escapeRegExp('(x)')).toBe('\\(x\\)')
    expect(escapeRegExp('a+b?c')).toBe('a\\+b\\?c')
    expect(escapeRegExp('[abc]')).toBe('\\[abc\\]')
    expect(escapeRegExp('a\\b')).toBe('a\\\\b')
    expect(escapeRegExp('a^b$')).toBe('a\\^b\\$')
    expect(escapeRegExp('a|b')).toBe('a\\|b')
    expect(escapeRegExp('{1,2}')).toBe('\\{1,2\\}')
  })

  test('returns plain string unchanged', () => {
    expect(escapeRegExp('hello world')).toBe('hello world')
    expect(escapeRegExp('')).toBe('')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd adapters/mongodb && pnpm exec vitest run dev/specs/escapeRegExp.spec.ts`
Expected: FAIL — module `../../src/escapeRegExp.js` not found.

- [ ] **Step 3: Write the implementation**

```ts
// adapters/mongodb/src/escapeRegExp.ts
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd adapters/mongodb && pnpm exec vitest run dev/specs/escapeRegExp.spec.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add adapters/mongodb/src/escapeRegExp.ts adapters/mongodb/dev/specs/escapeRegExp.spec.ts
git commit -m "feat(mongodb): add escapeRegExp utility"
```

---

## Task 3: Public types + `getMongoConfig` helper

**Files:**
- Create: `adapters/mongodb/src/types.ts`

- [ ] **Step 1: Write `adapters/mongodb/src/types.ts`**

```ts
import type { BasePayload } from 'payload'
import { getVectorizedPayload } from 'payloadcms-vectorize'

export type Similarity = 'cosine' | 'euclidean' | 'dotProduct'

export interface MongoPoolConfig {
  /** Vector dimensions for this pool (must match embedding model output). */
  dimensions: number
  /** Similarity metric for the search index. Default 'cosine'. */
  similarity?: Similarity
  /** ANN candidate set size. Default at search time: max(limit * 20, 100). */
  numCandidates?: number
  /** Extension fields to declare as filterable in the search index. */
  filterableFields?: string[]
  /** ENN exact search (full scan) instead of HNSW ANN. Default false. */
  forceExact?: boolean
  /** Override Mongo collection name. Default `vectorize_${poolName}`. */
  collectionName?: string
  /** Override search index name. Default `${collectionName}_idx`. */
  indexName?: string
}

export interface MongoVectorIntegrationConfig {
  /** Any valid MongoDB connection string (Atlas SRV or self-hosted). */
  uri: string
  /** Database that holds the per-pool vector collections. */
  dbName: string
  /** Pools keyed by knowledge pool name. */
  pools: Record<string, MongoPoolConfig>
}

/** Resolved per-pool config used internally (defaults applied). */
export interface ResolvedPoolConfig {
  dimensions: number
  similarity: Similarity
  numCandidates?: number
  filterableFields: string[]
  forceExact: boolean
  collectionName: string
  indexName: string
}

/**
 * Stored in `getConfigExtension().custom._mongoConfig` so `search()` can
 * recover the same config from a `BasePayload` instance.
 */
export interface MongoConfigCustom {
  uri: string
  dbName: string
  pools: Record<string, ResolvedPoolConfig>
}

export const RESERVED_FILTER_FIELDS = [
  'sourceCollection',
  'docId',
  'embeddingVersion',
] as const

export const RESERVED_FIELDS = [
  'sourceCollection',
  'docId',
  'chunkIndex',
  'chunkText',
  'embeddingVersion',
  'embedding',
] as const

export function resolvePoolConfig(
  poolName: string,
  cfg: MongoPoolConfig,
): ResolvedPoolConfig {
  const collectionName = cfg.collectionName ?? `vectorize_${poolName}`
  return {
    dimensions: cfg.dimensions,
    similarity: cfg.similarity ?? 'cosine',
    numCandidates: cfg.numCandidates,
    filterableFields: cfg.filterableFields ?? [],
    forceExact: cfg.forceExact ?? false,
    collectionName,
    indexName: cfg.indexName ?? `${collectionName}_idx`,
  }
}

export function getMongoConfig(payload: BasePayload): MongoConfigCustom {
  const cfg = getVectorizedPayload(payload)?.getDbAdapterCustom()
    ?._mongoConfig as MongoConfigCustom | undefined
  if (!cfg) {
    throw new Error('[@payloadcms-vectorize/mongodb] _mongoConfig not found on payload — did you register the adapter?')
  }
  return cfg
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd adapters/mongodb && pnpm exec tsc -p tsconfig.build.json --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add adapters/mongodb/src/types.ts
git commit -m "feat(mongodb): add public types and config helpers"
```

---

## Task 4: Lazy singleton MongoClient

**Files:**
- Create: `adapters/mongodb/src/client.ts`

- [ ] **Step 1: Write `adapters/mongodb/src/client.ts`**

```ts
import { MongoClient } from 'mongodb'

const clientCache = new Map<string, Promise<MongoClient>>()

export function getMongoClient(uri: string): Promise<MongoClient> {
  let p = clientCache.get(uri)
  if (!p) {
    p = MongoClient.connect(uri)
    clientCache.set(uri, p)
  }
  return p
}

/**
 * Test-only helper. NOT exported from `index.ts` — referenced by the dev test
 * suites via deep import to avoid leaking into the published API.
 */
export async function __closeForTests(): Promise<void> {
  const promises = Array.from(clientCache.values())
  clientCache.clear()
  for (const p of promises) {
    try {
      const c = await p
      await c.close()
    } catch {
      // ignore; client may not have connected
    }
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd adapters/mongodb && pnpm exec tsc -p tsconfig.build.json --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add adapters/mongodb/src/client.ts
git commit -m "feat(mongodb): add lazy singleton MongoClient with test close helper"
```

---

## Task 5: `convertWhereToMongo` — pre-filter operators on a leaf

**Files:**
- Create: `adapters/mongodb/src/convertWhere.ts`
- Create: `adapters/mongodb/dev/specs/convertWhere.spec.ts`

This task implements the pre-filter operator branch only — `equals`, `not_equals`/`notEquals`, `in`, `not_in`/`notIn`, `gt/gte/lt/lte` (both spellings), and `exists`. Subsequent tasks (6–8) layer on `like`/`contains` post-filter, `and`/`or` recursion, and field validation.

- [ ] **Step 1: Write the failing test**

```ts
// adapters/mongodb/dev/specs/convertWhere.spec.ts
import { describe, expect, test } from 'vitest'
import { convertWhereToMongo } from '../../src/convertWhere.js'

const FILTERABLE = ['status', 'category', 'views', 'rating', 'published', 'tags']

describe('convertWhereToMongo — pre-filter operators', () => {
  test('equals', () => {
    expect(
      convertWhereToMongo({ status: { equals: 'published' } }, FILTERABLE, 'p1'),
    ).toEqual({ preFilter: { status: { $eq: 'published' } }, postFilter: null })
  })

  test('not_equals (snake) and notEquals (camel)', () => {
    expect(
      convertWhereToMongo({ status: { not_equals: 'draft' } }, FILTERABLE, 'p1'),
    ).toEqual({ preFilter: { status: { $ne: 'draft' } }, postFilter: null })
    expect(
      convertWhereToMongo({ status: { notEquals: 'draft' } }, FILTERABLE, 'p1'),
    ).toEqual({ preFilter: { status: { $ne: 'draft' } }, postFilter: null })
  })

  test('in / not_in / notIn', () => {
    expect(
      convertWhereToMongo({ status: { in: ['a', 'b'] } }, FILTERABLE, 'p1'),
    ).toEqual({ preFilter: { status: { $in: ['a', 'b'] } }, postFilter: null })
    expect(
      convertWhereToMongo({ status: { not_in: ['a'] } }, FILTERABLE, 'p1'),
    ).toEqual({ preFilter: { status: { $nin: ['a'] } }, postFilter: null })
    expect(
      convertWhereToMongo({ status: { notIn: ['a'] } }, FILTERABLE, 'p1'),
    ).toEqual({ preFilter: { status: { $nin: ['a'] } }, postFilter: null })
  })

  test('greater_than / greaterThan / less_than_equal etc.', () => {
    expect(
      convertWhereToMongo({ views: { greater_than: 100 } }, FILTERABLE, 'p1'),
    ).toEqual({ preFilter: { views: { $gt: 100 } }, postFilter: null })
    expect(
      convertWhereToMongo({ views: { greaterThan: 100 } }, FILTERABLE, 'p1'),
    ).toEqual({ preFilter: { views: { $gt: 100 } }, postFilter: null })
    expect(
      convertWhereToMongo({ views: { greater_than_equal: 100 } }, FILTERABLE, 'p1'),
    ).toEqual({ preFilter: { views: { $gte: 100 } }, postFilter: null })
    expect(
      convertWhereToMongo({ views: { less_than: 100 } }, FILTERABLE, 'p1'),
    ).toEqual({ preFilter: { views: { $lt: 100 } }, postFilter: null })
    expect(
      convertWhereToMongo({ views: { less_than_equal: 100 } }, FILTERABLE, 'p1'),
    ).toEqual({ preFilter: { views: { $lte: 100 } }, postFilter: null })
  })

  test('exists true → $exists + $ne null', () => {
    expect(
      convertWhereToMongo({ category: { exists: true } }, FILTERABLE, 'p1'),
    ).toEqual({
      preFilter: { category: { $exists: true, $ne: null } },
      postFilter: null,
    })
  })

  test('exists false → $exists false OR $eq null', () => {
    expect(
      convertWhereToMongo({ category: { exists: false } }, FILTERABLE, 'p1'),
    ).toEqual({
      preFilter: { $or: [{ category: { $exists: false } }, { category: { $eq: null } }] },
      postFilter: null,
    })
  })

  test('multiple operators on same field combine via $and', () => {
    const result = convertWhereToMongo(
      { views: { greater_than: 50, less_than: 200 } },
      FILTERABLE,
      'p1',
    )
    expect(result).toEqual({
      preFilter: { $and: [{ views: { $gt: 50 } }, { views: { $lt: 200 } }] },
      postFilter: null,
    })
  })

  test('reserved field always usable even when filterableFields is empty', () => {
    expect(
      convertWhereToMongo(
        { sourceCollection: { equals: 'articles' } },
        [],
        'p1',
      ),
    ).toEqual({
      preFilter: { sourceCollection: { $eq: 'articles' } },
      postFilter: null,
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd adapters/mongodb && pnpm exec vitest run dev/specs/convertWhere.spec.ts`
Expected: FAIL — `convertWhereToMongo` not exported.

- [ ] **Step 3: Write the minimal implementation**

```ts
// adapters/mongodb/src/convertWhere.ts
import type { Where } from 'payload'
import { RESERVED_FILTER_FIELDS } from './types.js'

export interface ConvertResult {
  preFilter: Record<string, unknown> | null
  postFilter: Where | null
}

const PRE_OPS = new Map<string, string>([
  ['equals', '$eq'],
  ['not_equals', '$ne'],
  ['notEquals', '$ne'],
  ['in', '$in'],
  ['not_in', '$nin'],
  ['notIn', '$nin'],
  ['greater_than', '$gt'],
  ['greaterThan', '$gt'],
  ['greater_than_equal', '$gte'],
  ['greaterThanEqual', '$gte'],
  ['less_than', '$lt'],
  ['lessThan', '$lt'],
  ['less_than_equal', '$lte'],
  ['lessThanEqual', '$lte'],
])

const POST_OPS = new Set(['like', 'contains', 'all'])
const UNSUPPORTED_OPS = new Set(['near', 'within', 'intersects'])

function isFilterable(field: string, filterable: string[]): boolean {
  return (
    (RESERVED_FILTER_FIELDS as readonly string[]).includes(field) ||
    filterable.includes(field)
  )
}

function leafToPre(field: string, cond: Record<string, unknown>): Record<string, unknown> {
  const clauses: Record<string, unknown>[] = []
  for (const [op, val] of Object.entries(cond)) {
    if (op === 'exists') {
      if (val === true) {
        clauses.push({ [field]: { $exists: true, $ne: null } })
      } else {
        clauses.push({ $or: [{ [field]: { $exists: false } }, { [field]: { $eq: null } }] })
      }
      continue
    }
    const mongoOp = PRE_OPS.get(op)
    if (!mongoOp) continue
    clauses.push({ [field]: { [mongoOp]: val } })
  }
  if (clauses.length === 0) return {}
  if (clauses.length === 1) return clauses[0]
  return { $and: clauses }
}

export function convertWhereToMongo(
  where: Where,
  filterable: string[],
  poolName: string,
): ConvertResult {
  // Single-field leaf with only pre-filter operators (the simple, most-common path).
  const keys = Object.keys(where).filter((k) => k !== 'and' && k !== 'or')
  if (keys.length === 1) {
    const field = keys[0]
    const cond = where[field] as Record<string, unknown>
    if (!isFilterable(field, filterable)) {
      throw new Error(
        `[@payloadcms-vectorize/mongodb] Field "${field}" is not configured as filterableFields for pool "${poolName}"`,
      )
    }
    for (const op of Object.keys(cond)) {
      if (UNSUPPORTED_OPS.has(op)) {
        throw new Error(
          `[@payloadcms-vectorize/mongodb] Operator "${op}" is not supported`,
        )
      }
    }
    const onlyPreOps = Object.keys(cond).every(
      (op) => PRE_OPS.has(op) || op === 'exists',
    )
    if (onlyPreOps) {
      return { preFilter: leafToPre(field, cond), postFilter: null }
    }
  }
  // Tasks 6–8 expand this; for now, throw for unimplemented paths.
  throw new Error('[@payloadcms-vectorize/mongodb] convertWhereToMongo: path not implemented yet')
}

// POST_OPS is referenced by Task 6 — silences TS unused-symbol warnings until then.
void POST_OPS
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd adapters/mongodb && pnpm exec vitest run dev/specs/convertWhere.spec.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add adapters/mongodb/src/convertWhere.ts adapters/mongodb/dev/specs/convertWhere.spec.ts
git commit -m "feat(mongodb): convertWhereToMongo handles pre-filter leaf operators"
```

---

## Task 6: `convertWhereToMongo` — post-filter operators (`like`, `contains`, `all`)

**Files:**
- Modify: `adapters/mongodb/src/convertWhere.ts`
- Modify: `adapters/mongodb/dev/specs/convertWhere.spec.ts`

- [ ] **Step 1: Add failing tests for post-filter operators**

Append to `adapters/mongodb/dev/specs/convertWhere.spec.ts`:

```ts
describe('convertWhereToMongo — post-filter operators', () => {
  test('like routes the whole leaf to post-filter (verbatim Where)', () => {
    expect(
      convertWhereToMongo({ tags: { like: 'javascript' } }, FILTERABLE, 'p1'),
    ).toEqual({
      preFilter: null,
      postFilter: { tags: { like: 'javascript' } },
    })
  })

  test('contains routes the whole leaf to post-filter', () => {
    expect(
      convertWhereToMongo({ category: { contains: 'tech' } }, FILTERABLE, 'p1'),
    ).toEqual({
      preFilter: null,
      postFilter: { category: { contains: 'tech' } },
    })
  })

  test('mixed pre + post operators on same leaf → entire leaf goes to post', () => {
    expect(
      convertWhereToMongo(
        { tags: { equals: 'a', like: 'javascript' } },
        FILTERABLE,
        'p1',
      ),
    ).toEqual({
      preFilter: null,
      postFilter: { tags: { equals: 'a', like: 'javascript' } },
    })
  })

  test('all routes to post-filter', () => {
    expect(
      convertWhereToMongo({ tags: { all: ['a', 'b'] } }, FILTERABLE, 'p1'),
    ).toEqual({
      preFilter: null,
      postFilter: { tags: { all: ['a', 'b'] } },
    })
  })

  test('unsupported geo op throws', () => {
    expect(() =>
      convertWhereToMongo({ loc: { near: [0, 0] } }, ['loc'], 'p1'),
    ).toThrowError(/not supported/)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd adapters/mongodb && pnpm exec vitest run dev/specs/convertWhere.spec.ts`
Expected: FAIL — leaf with `like`/`contains`/`all` currently throws "not implemented".

- [ ] **Step 3: Update `convertWhereToMongo` to handle post-filter leaves**

Replace the body of `convertWhereToMongo` in `adapters/mongodb/src/convertWhere.ts` with:

```ts
export function convertWhereToMongo(
  where: Where,
  filterable: string[],
  poolName: string,
): ConvertResult {
  const keys = Object.keys(where).filter((k) => k !== 'and' && k !== 'or')
  if (keys.length === 1 && !('and' in where) && !('or' in where)) {
    const field = keys[0]
    const cond = where[field] as Record<string, unknown>
    if (!isFilterable(field, filterable)) {
      throw new Error(
        `[@payloadcms-vectorize/mongodb] Field "${field}" is not configured as filterableFields for pool "${poolName}"`,
      )
    }
    for (const op of Object.keys(cond)) {
      if (UNSUPPORTED_OPS.has(op)) {
        throw new Error(
          `[@payloadcms-vectorize/mongodb] Operator "${op}" is not supported`,
        )
      }
    }
    const hasPostOp = Object.keys(cond).some((op) => POST_OPS.has(op))
    if (hasPostOp) {
      return { preFilter: null, postFilter: { [field]: cond } as Where }
    }
    return { preFilter: leafToPre(field, cond), postFilter: null }
  }
  throw new Error('[@payloadcms-vectorize/mongodb] convertWhereToMongo: and/or not implemented yet')
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd adapters/mongodb && pnpm exec vitest run dev/specs/convertWhere.spec.ts`
Expected: PASS, 13 tests total.

- [ ] **Step 5: Commit**

```bash
git add adapters/mongodb/src/convertWhere.ts adapters/mongodb/dev/specs/convertWhere.spec.ts
git commit -m "feat(mongodb): convertWhereToMongo routes like/contains/all to post-filter"
```

---

## Task 7: `convertWhereToMongo` — `and` / `or` recursion

**Files:**
- Modify: `adapters/mongodb/src/convertWhere.ts`
- Modify: `adapters/mongodb/dev/specs/convertWhere.spec.ts`

- [ ] **Step 1: Add failing tests for `and` / `or`**

Append to `adapters/mongodb/dev/specs/convertWhere.spec.ts`:

```ts
describe('convertWhereToMongo — and/or composition', () => {
  test('and: all branches pre → combined preFilter via $and', () => {
    const result = convertWhereToMongo(
      {
        and: [
          { status: { equals: 'published' } },
          { views: { greater_than: 100 } },
        ],
      },
      FILTERABLE,
      'p1',
    )
    expect(result).toEqual({
      preFilter: {
        $and: [
          { status: { $eq: 'published' } },
          { views: { $gt: 100 } },
        ],
      },
      postFilter: null,
    })
  })

  test('and: mix of pre + post → pre kept native, post in {and:[...]}', () => {
    const result = convertWhereToMongo(
      {
        and: [
          { status: { equals: 'published' } },
          { tags: { like: 'javascript' } },
        ],
      },
      FILTERABLE,
      'p1',
    )
    expect(result).toEqual({
      preFilter: { status: { $eq: 'published' } },
      postFilter: { tags: { like: 'javascript' } },
    })
  })

  test('or: all branches pre → combined preFilter via $or', () => {
    const result = convertWhereToMongo(
      {
        or: [
          { status: { equals: 'draft' } },
          { status: { equals: 'archived' } },
        ],
      },
      FILTERABLE,
      'p1',
    )
    expect(result).toEqual({
      preFilter: {
        $or: [
          { status: { $eq: 'draft' } },
          { status: { $eq: 'archived' } },
        ],
      },
      postFilter: null,
    })
  })

  test('or: any branch is post → entire or goes to post-filter', () => {
    const where: any = {
      or: [
        { status: { equals: 'published' } },
        { tags: { like: 'javascript' } },
      ],
    }
    const result = convertWhereToMongo(where, FILTERABLE, 'p1')
    expect(result.preFilter).toBeNull()
    expect(result.postFilter).toEqual(where)
  })

  test('nested and/or: (published AND tech) OR (archived)', () => {
    const where: any = {
      or: [
        {
          and: [
            { status: { equals: 'published' } },
            { category: { equals: 'tech' } },
          ],
        },
        { status: { equals: 'archived' } },
      ],
    }
    const result = convertWhereToMongo(where, FILTERABLE, 'p1')
    expect(result.preFilter).toEqual({
      $or: [
        { $and: [{ status: { $eq: 'published' } }, { category: { $eq: 'tech' } }] },
        { status: { $eq: 'archived' } },
      ],
    })
    expect(result.postFilter).toBeNull()
  })

  test('and with single condition reduces to that condition', () => {
    const result = convertWhereToMongo(
      { and: [{ status: { equals: 'published' } }] },
      FILTERABLE,
      'p1',
    )
    expect(result).toEqual({
      preFilter: { status: { $eq: 'published' } },
      postFilter: null,
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd adapters/mongodb && pnpm exec vitest run dev/specs/convertWhere.spec.ts`
Expected: FAIL — `and/or not implemented yet`.

- [ ] **Step 3: Implement `and` / `or` recursion**

Replace the implementation in `adapters/mongodb/src/convertWhere.ts` with:

```ts
import type { Where } from 'payload'
import { RESERVED_FILTER_FIELDS } from './types.js'

export interface ConvertResult {
  preFilter: Record<string, unknown> | null
  postFilter: Where | null
}

const PRE_OPS = new Map<string, string>([
  ['equals', '$eq'],
  ['not_equals', '$ne'],
  ['notEquals', '$ne'],
  ['in', '$in'],
  ['not_in', '$nin'],
  ['notIn', '$nin'],
  ['greater_than', '$gt'],
  ['greaterThan', '$gt'],
  ['greater_than_equal', '$gte'],
  ['greaterThanEqual', '$gte'],
  ['less_than', '$lt'],
  ['lessThan', '$lt'],
  ['less_than_equal', '$lte'],
  ['lessThanEqual', '$lte'],
])

const POST_OPS = new Set(['like', 'contains', 'all'])
const UNSUPPORTED_OPS = new Set(['near', 'within', 'intersects'])

function isFilterable(field: string, filterable: string[]): boolean {
  return (
    (RESERVED_FILTER_FIELDS as readonly string[]).includes(field) ||
    filterable.includes(field)
  )
}

function leafToPre(field: string, cond: Record<string, unknown>): Record<string, unknown> {
  const clauses: Record<string, unknown>[] = []
  for (const [op, val] of Object.entries(cond)) {
    if (op === 'exists') {
      if (val === true) {
        clauses.push({ [field]: { $exists: true, $ne: null } })
      } else {
        clauses.push({ $or: [{ [field]: { $exists: false } }, { [field]: { $eq: null } }] })
      }
      continue
    }
    const mongoOp = PRE_OPS.get(op)
    if (!mongoOp) continue
    clauses.push({ [field]: { [mongoOp]: val } })
  }
  if (clauses.length === 0) return {}
  if (clauses.length === 1) return clauses[0]
  return { $and: clauses }
}

function convertLeaf(
  where: Where,
  filterable: string[],
  poolName: string,
): ConvertResult {
  const keys = Object.keys(where)
  if (keys.length !== 1) {
    // Multiple top-level fields on the same object: treat as implicit AND.
    const synthetic: Where = { and: keys.map((k) => ({ [k]: where[k] }) as Where) }
    return convertWhereToMongo(synthetic, filterable, poolName)
  }
  const field = keys[0]
  const cond = where[field] as Record<string, unknown>
  if (!isFilterable(field, filterable)) {
    throw new Error(
      `[@payloadcms-vectorize/mongodb] Field "${field}" is not configured as filterableFields for pool "${poolName}"`,
    )
  }
  for (const op of Object.keys(cond)) {
    if (UNSUPPORTED_OPS.has(op)) {
      throw new Error(`[@payloadcms-vectorize/mongodb] Operator "${op}" is not supported`)
    }
  }
  const hasPostOp = Object.keys(cond).some((op) => POST_OPS.has(op))
  if (hasPostOp) {
    return { preFilter: null, postFilter: { [field]: cond } as Where }
  }
  return { preFilter: leafToPre(field, cond), postFilter: null }
}

export function convertWhereToMongo(
  where: Where,
  filterable: string[],
  poolName: string,
): ConvertResult {
  if ('and' in where && Array.isArray(where.and)) {
    const branches = where.and.map((b) => convertWhereToMongo(b, filterable, poolName))
    const preBranches = branches.filter((b) => b.preFilter).map((b) => b.preFilter!)
    const postBranches = branches.filter((b) => b.postFilter).map((b) => b.postFilter!)
    const preFilter =
      preBranches.length === 0
        ? null
        : preBranches.length === 1
          ? preBranches[0]
          : { $and: preBranches }
    const postFilter =
      postBranches.length === 0
        ? null
        : postBranches.length === 1
          ? postBranches[0]
          : ({ and: postBranches } as Where)
    return { preFilter, postFilter }
  }

  if ('or' in where && Array.isArray(where.or)) {
    const branches = where.or.map((b) => convertWhereToMongo(b, filterable, poolName))
    const anyPost = branches.some((b) => b.postFilter !== null)
    if (anyPost) {
      // Entire OR goes post — semantics require the whole disjunction to apply
      // to the post-vectorSearch document set.
      return { preFilter: null, postFilter: where }
    }
    const preBranches = branches.map((b) => b.preFilter!).filter((p) => p)
    const preFilter =
      preBranches.length === 0
        ? null
        : preBranches.length === 1
          ? preBranches[0]
          : { $or: preBranches }
    return { preFilter, postFilter: null }
  }

  return convertLeaf(where, filterable, poolName)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd adapters/mongodb && pnpm exec vitest run dev/specs/convertWhere.spec.ts`
Expected: PASS — 19 tests total.

- [ ] **Step 5: Commit**

```bash
git add adapters/mongodb/src/convertWhere.ts adapters/mongodb/dev/specs/convertWhere.spec.ts
git commit -m "feat(mongodb): convertWhereToMongo handles and/or composition with pre/post split"
```

---

## Task 8: `evaluatePostFilter` — runtime post-filter matcher

**Files:**
- Modify: `adapters/mongodb/src/convertWhere.ts`
- Modify: `adapters/mongodb/dev/specs/convertWhere.spec.ts`

The post-filter is applied in JS against the result rows (not as a `$match` — Mongo's `$match` cannot natively express `like`/`contains`/regex with our exact semantics, and we already need JS evaluation for nested-`or` cases). This task adds `evaluatePostFilter`.

- [ ] **Step 1: Add failing tests**

Append to `adapters/mongodb/dev/specs/convertWhere.spec.ts`:

```ts
import { evaluatePostFilter } from '../../src/convertWhere.js'

describe('evaluatePostFilter', () => {
  test('like with case-insensitive substring match', () => {
    expect(
      evaluatePostFilter({ tags: 'JavaScript' }, { tags: { like: 'javascript' } }),
    ).toBe(true)
    expect(
      evaluatePostFilter({ tags: 'python' }, { tags: { like: 'javascript' } }),
    ).toBe(false)
  })

  test('contains works on scalar string', () => {
    expect(
      evaluatePostFilter({ category: 'technology' }, { category: { contains: 'tech' } }),
    ).toBe(true)
    expect(
      evaluatePostFilter({ category: 'design' }, { category: { contains: 'tech' } }),
    ).toBe(false)
  })

  test('contains on array uses elemMatch-style', () => {
    expect(
      evaluatePostFilter({ tags: ['react', 'javascript'] }, { tags: { contains: 'java' } }),
    ).toBe(true)
    expect(
      evaluatePostFilter({ tags: ['python'] }, { tags: { contains: 'java' } }),
    ).toBe(false)
  })

  test('like with regex special chars does NOT match unintended values', () => {
    // Pattern "foo.bar" must match the literal dot, not any char.
    expect(
      evaluatePostFilter({ tags: 'fooXbar' }, { tags: { like: 'foo.bar' } }),
    ).toBe(false)
    expect(
      evaluatePostFilter({ tags: 'foo.bar' }, { tags: { like: 'foo.bar' } }),
    ).toBe(true)
  })

  test('all on array', () => {
    expect(
      evaluatePostFilter({ tags: ['a', 'b', 'c'] }, { tags: { all: ['a', 'b'] } }),
    ).toBe(true)
    expect(
      evaluatePostFilter({ tags: ['a'] }, { tags: { all: ['a', 'b'] } }),
    ).toBe(false)
  })

  test('and combinator', () => {
    const w: any = {
      and: [
        { status: { equals: 'published' } },
        { tags: { like: 'javascript' } },
      ],
    }
    expect(
      evaluatePostFilter({ status: 'published', tags: 'JavaScript,react' }, w),
    ).toBe(true)
    expect(
      evaluatePostFilter({ status: 'draft', tags: 'JavaScript,react' }, w),
    ).toBe(false)
  })

  test('or combinator', () => {
    const w: any = {
      or: [
        { status: { equals: 'published' } },
        { tags: { like: 'javascript' } },
      ],
    }
    expect(evaluatePostFilter({ status: 'published', tags: 'python' }, w)).toBe(true)
    expect(evaluatePostFilter({ status: 'draft', tags: 'JavaScript' }, w)).toBe(true)
    expect(evaluatePostFilter({ status: 'draft', tags: 'python' }, w)).toBe(false)
  })

  test('pre-filter operators also evaluable in post path (for OR mixed branches)', () => {
    expect(
      evaluatePostFilter({ status: 'published' }, { status: { equals: 'published' } }),
    ).toBe(true)
    expect(
      evaluatePostFilter({ views: 150 }, { views: { greater_than: 100 } }),
    ).toBe(true)
    expect(
      evaluatePostFilter({ views: 50 }, { views: { greater_than: 100 } }),
    ).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd adapters/mongodb && pnpm exec vitest run dev/specs/convertWhere.spec.ts`
Expected: FAIL — `evaluatePostFilter` not exported.

- [ ] **Step 3: Implement `evaluatePostFilter`**

Append to `adapters/mongodb/src/convertWhere.ts`:

```ts
import { escapeRegExp } from './escapeRegExp.js'

function valueMatchesOp(value: unknown, op: string, operand: unknown): boolean {
  switch (op) {
    case 'equals':
      return value === operand
    case 'not_equals':
    case 'notEquals':
      return value !== operand
    case 'in':
      return Array.isArray(operand) && operand.includes(value as never)
    case 'not_in':
    case 'notIn':
      return Array.isArray(operand) && !operand.includes(value as never)
    case 'greater_than':
    case 'greaterThan':
      return typeof value === 'number' && typeof operand === 'number' && value > operand
    case 'greater_than_equal':
    case 'greaterThanEqual':
      return typeof value === 'number' && typeof operand === 'number' && value >= operand
    case 'less_than':
    case 'lessThan':
      return typeof value === 'number' && typeof operand === 'number' && value < operand
    case 'less_than_equal':
    case 'lessThanEqual':
      return typeof value === 'number' && typeof operand === 'number' && value <= operand
    case 'exists':
      return operand
        ? value !== undefined && value !== null
        : value === undefined || value === null
    case 'like':
    case 'contains': {
      if (typeof operand !== 'string') return false
      const re = new RegExp(escapeRegExp(operand), 'i')
      if (Array.isArray(value)) {
        return value.some((v) => typeof v === 'string' && re.test(v))
      }
      return typeof value === 'string' && re.test(value)
    }
    case 'all':
      return (
        Array.isArray(value) &&
        Array.isArray(operand) &&
        operand.every((o) => value.includes(o as never))
      )
    default:
      return false
  }
}

export function evaluatePostFilter(doc: Record<string, unknown>, where: Where): boolean {
  if (!where || Object.keys(where).length === 0) return true
  if ('and' in where && Array.isArray(where.and)) {
    return where.and.every((c: Where) => evaluatePostFilter(doc, c))
  }
  if ('or' in where && Array.isArray(where.or)) {
    return where.or.some((c: Where) => evaluatePostFilter(doc, c))
  }
  for (const [field, condition] of Object.entries(where)) {
    if (field === 'and' || field === 'or') continue
    if (typeof condition !== 'object' || condition === null) continue
    const cond = condition as Record<string, unknown>
    for (const [op, operand] of Object.entries(cond)) {
      if (!valueMatchesOp(doc[field], op, operand)) return false
    }
  }
  return true
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd adapters/mongodb && pnpm exec vitest run dev/specs/convertWhere.spec.ts`
Expected: PASS — 27 tests total.

- [ ] **Step 5: Commit**

```bash
git add adapters/mongodb/src/convertWhere.ts adapters/mongodb/dev/specs/convertWhere.spec.ts
git commit -m "feat(mongodb): add evaluatePostFilter for runtime post-filter matching"
```

---

## Task 9: `ensureSearchIndex` — index lifecycle with cache

**Files:**
- Create: `adapters/mongodb/src/indexes.ts`

This is verified end-to-end via the integration suite (Task 16). No unit test here because the function is a thin wrapper around the Mongo driver's `listSearchIndexes` / `createSearchIndex`, both of which require a live `mongot`.

- [ ] **Step 1: Write `adapters/mongodb/src/indexes.ts`**

```ts
import type { MongoClient } from 'mongodb'
import type { ResolvedPoolConfig } from './types.js'

const ensureCache = new Set<string>()

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

export async function ensureSearchIndex(
  client: MongoClient,
  dbName: string,
  pool: ResolvedPoolConfig,
): Promise<void> {
  const key = cacheKey(dbName, pool.collectionName, pool.indexName)
  if (ensureCache.has(key)) return

  const db = client.db(dbName)
  const collection = db.collection(pool.collectionName)

  const wantedDefinition = buildDefinition(pool)

  let existing: Array<Record<string, unknown>>
  try {
    existing = (await collection.listSearchIndexes(pool.indexName).toArray()) as Array<
      Record<string, unknown>
    >
  } catch {
    existing = []
  }

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
      if (status === 'READY') {
        ensureCache.add(key)
        return
      }
      // BUILDING: fall through to polling
    } else {
      throw new Error(
        `[@payloadcms-vectorize/mongodb] Search index "${pool.indexName}" is in unexpected state "${status}". Drop and recreate.`,
      )
    }
  } else {
    await collection.createSearchIndex({
      name: pool.indexName,
      type: 'vectorSearch',
      definition: wantedDefinition,
    })
  }

  // Poll for READY (≤ 60s)
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const list = (await collection.listSearchIndexes(pool.indexName).toArray()) as Array<
      Record<string, unknown>
    >
    const idx = list.find((i) => i.name === pool.indexName)
    if (idx?.status === 'READY') {
      ensureCache.add(key)
      return
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(
    `[@payloadcms-vectorize/mongodb] Search index "${pool.indexName}" did not become READY within 60s. Check Mongo logs.`,
  )
}

/** Test-only: clear the in-memory ensure cache. */
export function __resetIndexCacheForTests(): void {
  ensureCache.clear()
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd adapters/mongodb && pnpm exec tsc -p tsconfig.build.json --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add adapters/mongodb/src/indexes.ts
git commit -m "feat(mongodb): ensureSearchIndex with definition-mismatch detection and READY polling"
```

---

## Task 10: `storeChunk`

**Files:**
- Create: `adapters/mongodb/src/embed.ts`

- [ ] **Step 1: Write `adapters/mongodb/src/embed.ts`**

```ts
import type { Payload } from 'payload'
import type { StoreChunkData } from 'payloadcms-vectorize'
import { getMongoClient } from './client.js'
import { ensureSearchIndex } from './indexes.js'
import { getMongoConfig } from './types.js'

export default async function storeChunk(
  payload: Payload,
  poolName: string,
  data: StoreChunkData,
): Promise<void> {
  const cfg = getMongoConfig(payload)
  const pool = cfg.pools[poolName]
  if (!pool) {
    throw new Error(
      `[@payloadcms-vectorize/mongodb] Unknown pool "${poolName}". Configured pools: ${Object.keys(cfg.pools).join(', ')}`,
    )
  }
  const client = await getMongoClient(cfg.uri)
  await ensureSearchIndex(client, cfg.dbName, pool)

  const embeddingArray = Array.isArray(data.embedding)
    ? Array.from(data.embedding)
    : Array.from(data.embedding)

  const now = new Date()
  const collection = client.db(cfg.dbName).collection(pool.collectionName)
  await collection.insertOne({
    sourceCollection: data.sourceCollection,
    docId: String(data.docId),
    chunkIndex: data.chunkIndex,
    chunkText: data.chunkText,
    embeddingVersion: data.embeddingVersion,
    ...data.extensionFields,
    embedding: embeddingArray,
    createdAt: now,
    updatedAt: now,
  })
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd adapters/mongodb && pnpm exec tsc -p tsconfig.build.json --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add adapters/mongodb/src/embed.ts
git commit -m "feat(mongodb): add storeChunk that ensures index then inserts document"
```

---

## Task 11: `search` — `$vectorSearch` aggregation

**Files:**
- Create: `adapters/mongodb/src/search.ts`

- [ ] **Step 1: Write `adapters/mongodb/src/search.ts`**

```ts
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
```

- [ ] **Step 2: Verify it compiles**

Run: `cd adapters/mongodb && pnpm exec tsc -p tsconfig.build.json --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add adapters/mongodb/src/search.ts
git commit -m "feat(mongodb): implement search via \$vectorSearch with pre/post split"
```

---

## Task 12: `id` → `_id` `ObjectId` casting in `convertWhereToMongo`

**Files:**
- Modify: `adapters/mongodb/src/convertWhere.ts`
- Modify: `adapters/mongodb/dev/specs/convertWhere.spec.ts`

The Payload `id` field maps to Mongo `_id`. When users filter by `id`, cast to `ObjectId` if the value is a 24-hex string; otherwise pass through as-is.

- [ ] **Step 1: Add failing tests**

Append to `adapters/mongodb/dev/specs/convertWhere.spec.ts`:

```ts
import { ObjectId } from 'mongodb'

describe('convertWhereToMongo — id mapping', () => {
  test('id with 24-hex string maps to _id with ObjectId cast', () => {
    const hex = '507f1f77bcf86cd799439011'
    const result = convertWhereToMongo({ id: { equals: hex } }, [], 'p1')
    expect(result.preFilter).toEqual({ _id: { $eq: new ObjectId(hex) } })
    expect(result.postFilter).toBeNull()
  })

  test('id with non-hex string maps to _id with raw value', () => {
    const result = convertWhereToMongo({ id: { equals: 'not-an-objectid' } }, [], 'p1')
    expect(result.preFilter).toEqual({ _id: { $eq: 'not-an-objectid' } })
  })

  test('id with in array casts each 24-hex string', () => {
    const a = '507f1f77bcf86cd799439011'
    const b = 'plain-string-id'
    const result = convertWhereToMongo({ id: { in: [a, b] } }, [], 'p1')
    expect(result.preFilter).toEqual({
      _id: { $in: [new ObjectId(a), b] },
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd adapters/mongodb && pnpm exec vitest run dev/specs/convertWhere.spec.ts`
Expected: FAIL — `id` field not in `RESERVED_FILTER_FIELDS`, throws "not configured" or maps to `id` not `_id`.

- [ ] **Step 3: Update `convertWhere.ts`**

In `adapters/mongodb/src/convertWhere.ts`:

a) At the top of the file, add:

```ts
import { ObjectId } from 'mongodb'

const HEX24 = /^[a-f\d]{24}$/i

function castIdValue(v: unknown): unknown {
  if (typeof v === 'string' && HEX24.test(v)) return new ObjectId(v)
  return v
}

function castIdOperand(op: string, v: unknown): unknown {
  if (op === 'in' || op === 'not_in' || op === 'notIn') {
    return Array.isArray(v) ? v.map(castIdValue) : v
  }
  return castIdValue(v)
}
```

b) Update `isFilterable` to recognize `id`:

```ts
function isFilterable(field: string, filterable: string[]): boolean {
  if (field === 'id') return true
  return (
    (RESERVED_FILTER_FIELDS as readonly string[]).includes(field) ||
    filterable.includes(field)
  )
}
```

c) Update `leafToPre` to remap `id` → `_id` and cast:

```ts
function leafToPre(field: string, cond: Record<string, unknown>): Record<string, unknown> {
  const targetField = field === 'id' ? '_id' : field
  const clauses: Record<string, unknown>[] = []
  for (const [op, val] of Object.entries(cond)) {
    if (op === 'exists') {
      if (val === true) {
        clauses.push({ [targetField]: { $exists: true, $ne: null } })
      } else {
        clauses.push({
          $or: [
            { [targetField]: { $exists: false } },
            { [targetField]: { $eq: null } },
          ],
        })
      }
      continue
    }
    const mongoOp = PRE_OPS.get(op)
    if (!mongoOp) continue
    const operand = field === 'id' ? castIdOperand(op, val) : val
    clauses.push({ [targetField]: { [mongoOp]: operand } })
  }
  if (clauses.length === 0) return {}
  if (clauses.length === 1) return clauses[0]
  return { $and: clauses }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd adapters/mongodb && pnpm exec vitest run dev/specs/convertWhere.spec.ts`
Expected: PASS — 30 tests total.

- [ ] **Step 5: Commit**

```bash
git add adapters/mongodb/src/convertWhere.ts adapters/mongodb/dev/specs/convertWhere.spec.ts
git commit -m "feat(mongodb): map Payload id → Mongo _id with ObjectId casting"
```

---

## Task 13: `createMongoVectorIntegration` factory + barrel exports

**Files:**
- Create: `adapters/mongodb/src/index.ts`

- [ ] **Step 1: Write `adapters/mongodb/src/index.ts`**

```ts
import type { DbAdapter } from 'payloadcms-vectorize'
import { getMongoClient } from './client.js'
import storeChunk from './embed.js'
import search from './search.js'
import {
  resolvePoolConfig,
  type MongoVectorIntegrationConfig,
  type ResolvedPoolConfig,
} from './types.js'

export type {
  MongoPoolConfig,
  MongoVectorIntegrationConfig,
  Similarity,
} from './types.js'

export const createMongoVectorIntegration = (
  options: MongoVectorIntegrationConfig,
): { adapter: DbAdapter } => {
  if (!options.uri) {
    throw new Error('[@payloadcms-vectorize/mongodb] `uri` is required')
  }
  if (!options.dbName) {
    throw new Error('[@payloadcms-vectorize/mongodb] `dbName` is required')
  }
  if (!options.pools || Object.keys(options.pools).length === 0) {
    throw new Error('[@payloadcms-vectorize/mongodb] `pools` must contain at least one pool')
  }

  const resolvedPools: Record<string, ResolvedPoolConfig> = {}
  for (const [name, p] of Object.entries(options.pools)) {
    if (typeof p.dimensions !== 'number' || p.dimensions <= 0) {
      throw new Error(
        `[@payloadcms-vectorize/mongodb] pool "${name}" requires a positive numeric \`dimensions\``,
      )
    }
    resolvedPools[name] = resolvePoolConfig(name, p)
  }

  const adapter: DbAdapter = {
    getConfigExtension: () => ({
      custom: {
        _mongoConfig: {
          uri: options.uri,
          dbName: options.dbName,
          pools: resolvedPools,
        },
      },
    }),

    storeChunk,

    deleteChunks: async (payload, poolName, sourceCollection, docId) => {
      const cfg = resolvedPools[poolName]
      if (!cfg) {
        throw new Error(
          `[@payloadcms-vectorize/mongodb] Unknown pool "${poolName}"`,
        )
      }
      const client = await getMongoClient(options.uri)
      await client
        .db(options.dbName)
        .collection(cfg.collectionName)
        .deleteMany({ sourceCollection, docId: String(docId) })
    },

    hasEmbeddingVersion: async (
      payload,
      poolName,
      sourceCollection,
      docId,
      embeddingVersion,
    ) => {
      const cfg = resolvedPools[poolName]
      if (!cfg) {
        throw new Error(
          `[@payloadcms-vectorize/mongodb] Unknown pool "${poolName}"`,
        )
      }
      const client = await getMongoClient(options.uri)
      const count = await client
        .db(options.dbName)
        .collection(cfg.collectionName)
        .countDocuments(
          { sourceCollection, docId: String(docId), embeddingVersion },
          { limit: 1 },
        )
      return count > 0
    },

    search,
  }

  return { adapter }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd adapters/mongodb && pnpm exec tsc -p tsconfig.build.json --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add adapters/mongodb/src/index.ts
git commit -m "feat(mongodb): add createMongoVectorIntegration factory and adapter wiring"
```

---

## Task 14: `docker-compose.yml` for local Mongo Atlas

**Files:**
- Create: `adapters/mongodb/dev/docker-compose.yml`

- [ ] **Step 1: Write `adapters/mongodb/dev/docker-compose.yml`**

```yaml
services:
  mongodb-atlas:
    image: mongodb/mongodb-atlas-local:latest
    container_name: vectorize-mongodb-test
    ports:
      - "27018:27017"
    healthcheck:
      test: ["CMD", "mongosh", "--quiet", "--eval", "db.runCommand({ping:1})"]
      interval: 2s
      timeout: 5s
      retries: 30
```

- [ ] **Step 2: Sanity check that the compose file parses**

Run: `cd adapters/mongodb && docker compose -f dev/docker-compose.yml config`
Expected: prints normalized YAML with no errors.

- [ ] **Step 3: Bring the container up and verify health**

Run: `cd adapters/mongodb && pnpm test:setup`
Then: `docker inspect --format='{{.State.Health.Status}}' vectorize-mongodb-test`
Expected: `healthy` within ~30s.

- [ ] **Step 4: Bring the container down**

Run: `cd adapters/mongodb && pnpm test:teardown`
Expected: container removed, no errors.

- [ ] **Step 5: Commit**

```bash
git add adapters/mongodb/dev/docker-compose.yml
git commit -m "feat(mongodb): add docker-compose for local mongodb-atlas-local stack"
```

---

## Task 15: Compliance suite

**Files:**
- Create: `adapters/mongodb/dev/specs/constants.ts`
- Create: `adapters/mongodb/dev/specs/utils.ts`
- Create: `adapters/mongodb/dev/specs/compliance.spec.ts`

The Mongo adapter does NOT register a Payload collection, so unlike PG we don't spin up the full plugin in compliance tests — we exercise the `DbAdapter` directly with a minimal Payload instance whose only role is to surface `_mongoConfig` via the plugin's `getVectorizedPayload` helper. We use the dummy in-memory `payload` shape `payloadcms-vectorize` looks for.

- [ ] **Step 1: Write `adapters/mongodb/dev/specs/constants.ts`**

```ts
import { createMongoVectorIntegration } from '../../src/index.js'

export const DIMS = 8
export const MONGO_URI =
  process.env.MONGODB_URI || 'mongodb://localhost:27018/?directConnection=true'

export const TEST_DB = `vectorize_mongo_test_${Date.now()}`

export function makeIntegration(filterableFields: string[] = []) {
  return createMongoVectorIntegration({
    uri: MONGO_URI,
    dbName: TEST_DB,
    pools: {
      default: {
        dimensions: DIMS,
        filterableFields,
        // Smaller candidate set so HNSW build/scan stays fast on tiny datasets.
        numCandidates: 50,
      },
    },
  })
}
```

- [ ] **Step 2: Write `adapters/mongodb/dev/specs/utils.ts`**

```ts
import { MongoClient } from 'mongodb'
import type { BasePayload } from 'payload'
import { __closeForTests } from '../../src/client.js'
import { __resetIndexCacheForTests } from '../../src/indexes.js'

/**
 * Minimal payload-shaped object that satisfies `getVectorizedPayload(payload).getDbAdapterCustom()`.
 *
 * `getVectorizedPayload` (src/types.ts) reads `payload.config.custom.createVectorizedPayloadObject`
 * and calls it with the payload to produce a `VectorizedPayload` whose `getDbAdapterCustom()`
 * returns the adapter's `getConfigExtension().custom`. We mirror that contract exactly.
 */
export function makeFakePayload(custom: Record<string, unknown>): BasePayload {
  const payload = {
    config: {
      custom: {
        createVectorizedPayloadObject: () => ({
          getDbAdapterCustom: () => custom,
        }),
      },
    },
    logger: {
      error: console.error.bind(console),
      info: console.log.bind(console),
    },
  } as unknown as BasePayload
  return payload
}

/** Spin up an admin client and drop the test DB. */
export async function dropTestDb(uri: string, dbName: string): Promise<void> {
  const c = new MongoClient(uri)
  try {
    await c.connect()
    await c.db(dbName).dropDatabase()
  } catch {
    // ignore — DB may not exist
  } finally {
    await c.close()
  }
}

export async function teardown(): Promise<void> {
  __resetIndexCacheForTests()
  await __closeForTests()
}
```

- [ ] **Step 3: Write `adapters/mongodb/dev/specs/compliance.spec.ts`**

```ts
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { MongoClient } from 'mongodb'
import type { BasePayload } from 'payload'
import type { DbAdapter } from 'payloadcms-vectorize'
import { DIMS, MONGO_URI, TEST_DB, makeIntegration } from './constants.js'
import { dropTestDb, makeFakePayload, teardown } from './utils.js'

describe('Mongo Adapter Compliance Tests', () => {
  let adapter: DbAdapter
  let payload: BasePayload

  beforeAll(async () => {
    await dropTestDb(MONGO_URI, TEST_DB)
    const integration = makeIntegration()
    adapter = integration.adapter
    const ext = adapter.getConfigExtension({} as any)
    payload = makeFakePayload(ext.custom!)
  })

  afterAll(async () => {
    await dropTestDb(MONGO_URI, TEST_DB)
    await teardown()
  })

  describe('getConfigExtension()', () => {
    test('returns object with custom._mongoConfig', () => {
      const ext = adapter.getConfigExtension({} as any)
      expect(ext.custom?._mongoConfig).toBeDefined()
      expect(ext.custom!._mongoConfig.uri).toBe(MONGO_URI)
      expect(ext.custom!._mongoConfig.dbName).toBe(TEST_DB)
      expect(ext.custom!._mongoConfig.pools.default.dimensions).toBe(DIMS)
    })

    test('does NOT include any collections (Mongo manages docs via raw driver)', () => {
      const ext = adapter.getConfigExtension({} as any)
      expect(ext.collections).toBeUndefined()
    })
  })

  describe('storeChunk()', () => {
    test('persists embedding (number[])', async () => {
      const embedding = Array(DIMS)
        .fill(0)
        .map(() => Math.random())
      await expect(
        adapter.storeChunk(payload, 'default', {
          sourceCollection: 'test-collection',
          docId: `embed-1-${Date.now()}`,
          chunkIndex: 0,
          chunkText: 'test text',
          embeddingVersion: 'v1',
          embedding,
          extensionFields: {},
        }),
      ).resolves.not.toThrow()
    })

    test('persists embedding (Float32Array)', async () => {
      const embedding = new Float32Array(
        Array(DIMS)
          .fill(0)
          .map(() => Math.random()),
      )
      await expect(
        adapter.storeChunk(payload, 'default', {
          sourceCollection: 'test-collection',
          docId: `embed-2-${Date.now()}`,
          chunkIndex: 0,
          chunkText: 'test text float32',
          embeddingVersion: 'v1',
          embedding,
          extensionFields: {},
        }),
      ).resolves.not.toThrow()
    })
  })

  describe('search()', () => {
    let target: number[]
    beforeAll(async () => {
      target = Array(DIMS).fill(0.5)
      const similar = target.map((v) => v + Math.random() * 0.05)
      await adapter.storeChunk(payload, 'default', {
        sourceCollection: 'test-collection',
        docId: `search-similar-${Date.now()}`,
        chunkIndex: 0,
        chunkText: 'similar doc',
        embeddingVersion: 'v1',
        embedding: similar,
        extensionFields: {},
      })
    })

    test('returns an array of results', async () => {
      const results = await adapter.search(payload, target, 'default')
      expect(Array.isArray(results)).toBe(true)
    })

    test('results have all required fields with correct types', async () => {
      const results = await adapter.search(payload, target, 'default')
      for (const r of results) {
        expect(typeof r.id).toBe('string')
        expect(typeof r.score).toBe('number')
        expect(typeof r.sourceCollection).toBe('string')
        expect(typeof r.docId).toBe('string')
        expect(typeof r.chunkIndex).toBe('number')
        expect(typeof r.chunkText).toBe('string')
        expect(typeof r.embeddingVersion).toBe('string')
      }
    })

    test('results are ordered by score (highest first)', async () => {
      const results = await adapter.search(payload, target, 'default', 10)
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score)
      }
    })

    test('respects limit parameter', async () => {
      const results = await adapter.search(payload, target, 'default', 1)
      expect(results.length).toBeLessThanOrEqual(1)
    })
  })

  describe('deleteChunks()', () => {
    test('removes chunks for a doc', async () => {
      const docId = `to-delete-${Date.now()}`
      await adapter.storeChunk(payload, 'default', {
        sourceCollection: 'delete-test',
        docId,
        chunkIndex: 0,
        chunkText: 'doc to delete',
        embeddingVersion: 'v1',
        embedding: Array(DIMS).fill(0.7),
        extensionFields: {},
      })

      const c = new MongoClient(MONGO_URI)
      await c.connect()
      const before = await c
        .db(TEST_DB)
        .collection('vectorize_default')
        .countDocuments({ sourceCollection: 'delete-test', docId })
      expect(before).toBeGreaterThan(0)

      await adapter.deleteChunks(payload, 'default', 'delete-test', docId)

      const after = await c
        .db(TEST_DB)
        .collection('vectorize_default')
        .countDocuments({ sourceCollection: 'delete-test', docId })
      expect(after).toBe(0)
      await c.close()
    })

    test('handles missing doc gracefully', async () => {
      await expect(
        adapter.deleteChunks(payload, 'default', 'never-existed', 'fake-id'),
      ).resolves.not.toThrow()
    })
  })

  describe('hasEmbeddingVersion()', () => {
    test('true when chunk exists', async () => {
      const docId = `has-version-${Date.now()}`
      await adapter.storeChunk(payload, 'default', {
        sourceCollection: 'test-collection',
        docId,
        chunkIndex: 0,
        chunkText: 'has version test',
        embeddingVersion: 'v1',
        embedding: Array(DIMS).fill(0.5),
        extensionFields: {},
      })
      const r = await adapter.hasEmbeddingVersion(
        payload, 'default', 'test-collection', docId, 'v1',
      )
      expect(r).toBe(true)
    })

    test('false when no chunk exists', async () => {
      const r = await adapter.hasEmbeddingVersion(
        payload, 'default', 'test-collection', 'never-existed', 'v1',
      )
      expect(r).toBe(false)
    })
  })
})
```

- [ ] **Step 4: Run compliance suite (requires `pnpm test:setup` running)**

Run: `cd adapters/mongodb && pnpm test:setup && pnpm exec vitest run dev/specs/compliance.spec.ts`
Expected: all tests PASS. The first run may take ~30s while the search index builds.

- [ ] **Step 5: Commit**

```bash
git add adapters/mongodb/dev/specs/constants.ts adapters/mongodb/dev/specs/utils.ts adapters/mongodb/dev/specs/compliance.spec.ts
git commit -m "test(mongodb): port compliance suite from PG, exercise adapter directly"
```

---

## Task 16: WHERE-clause + integration suites against live Mongo

**Files:**
- Create: `adapters/mongodb/dev/specs/vectorSearchWhere.spec.ts`
- Create: `adapters/mongodb/dev/specs/integration.spec.ts`

The PG `vectorSearchWhere.spec.ts` runs end-to-end through the plugin's HTTP handler. For Mongo we exercise `adapter.search` directly because we don't register a Payload collection. The fixture data and assertions are otherwise identical so the suite mirrors PG's coverage of all 9 operators.

- [ ] **Step 1: Write `adapters/mongodb/dev/specs/vectorSearchWhere.spec.ts`**

```ts
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { BasePayload, Where } from 'payload'
import type { DbAdapter, VectorSearchResult } from 'payloadcms-vectorize'
import { createMongoVectorIntegration } from '../../src/index.js'
import { DIMS, MONGO_URI } from './constants.js'
import { dropTestDb, makeFakePayload, teardown } from './utils.js'

const TEST_DB = `vectorize_mongo_where_${Date.now()}`
const FILTERABLE = ['status', 'category', 'views', 'rating', 'published', 'tags']

const articles = [
  {
    title: 'Published Tech Article',
    status: 'published', category: 'tech', views: 150,
    rating: 4.5, published: true, tags: 'javascript,nodejs,programming',
  },
  {
    title: 'Draft Tech Article',
    status: 'draft', category: 'tech', views: 0,
    rating: 0, published: false, tags: 'javascript',
  },
  {
    title: 'Published Design Article',
    status: 'published', category: 'design', views: 300,
    rating: 4.8, published: true, tags: 'ui,design,ux',
  },
  {
    title: 'Archived Tech Article',
    status: 'archived', category: 'tech', views: 50,
    rating: 3.5, published: false, tags: 'python,legacy',
  },
]

async function performVectorSearch(
  payload: BasePayload,
  adapter: DbAdapter,
  where?: Where,
  limit = 100,
): Promise<VectorSearchResult[]> {
  const queryEmbedding = Array(DIMS).fill(0.5)
  return adapter.search(payload, queryEmbedding, 'default', limit, where)
}

describe('Mongo adapter — WHERE clause operators', () => {
  let adapter: DbAdapter
  let payload: BasePayload

  beforeAll(async () => {
    await dropTestDb(MONGO_URI, TEST_DB)
    const { adapter: a } = createMongoVectorIntegration({
      uri: MONGO_URI,
      dbName: TEST_DB,
      pools: {
        default: {
          dimensions: DIMS,
          filterableFields: FILTERABLE,
          numCandidates: 50,
        },
      },
    })
    adapter = a
    const ext = adapter.getConfigExtension({} as any)
    payload = makeFakePayload(ext.custom!)

    let i = 0
    for (const a of articles) {
      const embedding = Array(DIMS).fill(0.5).map((v) => v + Math.random() * 0.05)
      await adapter.storeChunk(payload, 'default', {
        sourceCollection: 'articles',
        docId: `art-${i++}`,
        chunkIndex: 0,
        chunkText: a.title,
        embeddingVersion: 'v1',
        embedding,
        extensionFields: {
          status: a.status,
          category: a.category,
          views: a.views,
          rating: a.rating,
          published: a.published,
          tags: a.tags,
        },
      })
    }
  })

  afterAll(async () => {
    await dropTestDb(MONGO_URI, TEST_DB)
    await teardown()
  })

  describe('equals operator', () => {
    test('filters by exact text match', async () => {
      const r = await performVectorSearch(payload, adapter, { status: { equals: 'published' } })
      expect(r.length).toBeGreaterThan(0)
      r.forEach((x) => expect(x.status).toBe('published'))
    })

    test('returns empty when no match', async () => {
      const r = await performVectorSearch(payload, adapter, { status: { equals: 'missing' } })
      expect(r).toEqual([])
    })
  })

  describe('not_equals / notEquals operator', () => {
    test('filters by non-equal text match', async () => {
      const r = await performVectorSearch(payload, adapter, { status: { not_equals: 'draft' } })
      expect(r.length).toBeGreaterThan(0)
      r.forEach((x) => expect(x.status).not.toBe('draft'))
    })

    test('notEquals variant', async () => {
      const r = await performVectorSearch(payload, adapter, { status: { notEquals: 'archived' } })
      expect(r.length).toBeGreaterThan(0)
      r.forEach((x) => expect(x.status).not.toBe('archived'))
    })
  })

  describe('in / not_in / notIn operators', () => {
    test('in', async () => {
      const r = await performVectorSearch(payload, adapter, { status: { in: ['published', 'draft'] } })
      expect(r.length).toBeGreaterThan(0)
      r.forEach((x) => expect(['published', 'draft']).toContain(x.status))
    })
    test('not_in', async () => {
      const r = await performVectorSearch(payload, adapter, { status: { not_in: ['draft', 'archived'] } })
      expect(r.length).toBeGreaterThan(0)
      r.forEach((x) => expect(['draft', 'archived']).not.toContain(x.status))
    })
    test('notIn', async () => {
      const r = await performVectorSearch(payload, adapter, { status: { notIn: ['archived'] } })
      expect(r.length).toBeGreaterThan(0)
      r.forEach((x) => expect(x.status).not.toBe('archived'))
    })
  })

  describe('like / contains operators (post-filter)', () => {
    test('like substring match', async () => {
      const r = await performVectorSearch(payload, adapter, { tags: { like: 'javascript' } })
      expect(r.length).toBeGreaterThan(0)
      r.forEach((x) => expect((x.tags as string).toLowerCase()).toContain('javascript'))
    })
    test('contains substring match', async () => {
      const r = await performVectorSearch(payload, adapter, { category: { contains: 'tech' } })
      expect(r.length).toBeGreaterThan(0)
      r.forEach((x) => expect(x.category).toContain('tech'))
    })
    test('like regex special chars do NOT match unintended values', async () => {
      // None of our fixtures contain "foo.bar" — the dot must be escaped.
      const r = await performVectorSearch(payload, adapter, { tags: { like: 'foo.bar' } })
      expect(r).toEqual([])
    })
  })

  describe('comparison operators (numbers)', () => {
    test('greater_than', async () => {
      const r = await performVectorSearch(payload, adapter, { views: { greater_than: 100 } })
      expect(r.length).toBeGreaterThan(0)
      r.forEach((x) => expect(x.views).toBeGreaterThan(100))
    })
    test('greaterThan variant', async () => {
      const r = await performVectorSearch(payload, adapter, { views: { greaterThan: 100 } })
      r.forEach((x) => expect(x.views).toBeGreaterThan(100))
    })
    test('greater_than_equal', async () => {
      const r = await performVectorSearch(payload, adapter, { views: { greater_than_equal: 150 } })
      r.forEach((x) => expect(x.views).toBeGreaterThanOrEqual(150))
    })
    test('less_than', async () => {
      const r = await performVectorSearch(payload, adapter, { views: { less_than: 200 } })
      r.forEach((x) => expect(x.views).toBeLessThan(200))
    })
    test('less_than_equal', async () => {
      const r = await performVectorSearch(payload, adapter, { views: { less_than_equal: 150 } })
      r.forEach((x) => expect(x.views).toBeLessThanOrEqual(150))
    })
    test('lessThan variant on float', async () => {
      const r = await performVectorSearch(payload, adapter, { rating: { lessThan: 4.6 } })
      r.forEach((x) => expect(x.rating).toBeLessThan(4.6))
    })
    test('range via and', async () => {
      const r = await performVectorSearch(payload, adapter, {
        and: [{ views: { greater_than: 50 } }, { views: { less_than: 200 } }],
      })
      expect(r.length).toBeGreaterThan(0)
      r.forEach((x) => {
        expect(x.views).toBeGreaterThan(50)
        expect(x.views).toBeLessThan(200)
      })
    })
  })

  describe('exists operator', () => {
    test('exists true', async () => {
      const r = await performVectorSearch(payload, adapter, { category: { exists: true } })
      r.forEach((x) => expect(x.category != null).toBe(true))
    })
    test('exists false', async () => {
      const r = await performVectorSearch(payload, adapter, { category: { exists: false } })
      r.forEach((x) => expect(x.category == null).toBe(true))
    })
  })

  describe('AND operator', () => {
    test('text + text', async () => {
      const r = await performVectorSearch(payload, adapter, {
        and: [{ status: { equals: 'published' } }, { category: { equals: 'tech' } }],
      })
      expect(r.length).toBeGreaterThan(0)
      r.forEach((x) => {
        expect(x.status).toBe('published')
        expect(x.category).toBe('tech')
      })
    })
    test('text + numeric', async () => {
      const r = await performVectorSearch(payload, adapter, {
        and: [{ status: { equals: 'published' } }, { views: { greater_than: 100 } }],
      })
      r.forEach((x) => {
        expect(x.status).toBe('published')
        expect(x.views).toBeGreaterThan(100)
      })
    })
    test('and with single condition', async () => {
      const r = await performVectorSearch(payload, adapter, {
        and: [{ status: { equals: 'published' } }],
      })
      r.forEach((x) => expect(x.status).toBe('published'))
    })
    test('and with one pre + one post operator', async () => {
      const r = await performVectorSearch(payload, adapter, {
        and: [{ status: { equals: 'published' } }, { tags: { like: 'javascript' } }],
      })
      r.forEach((x) => {
        expect(x.status).toBe('published')
        expect((x.tags as string).toLowerCase()).toContain('javascript')
      })
    })
  })

  describe('OR operator', () => {
    test('two text branches', async () => {
      const r = await performVectorSearch(payload, adapter, {
        or: [{ status: { equals: 'draft' } }, { status: { equals: 'archived' } }],
      })
      r.forEach((x) => expect(['draft', 'archived']).toContain(x.status))
    })
    test('two numeric branches', async () => {
      const r = await performVectorSearch(payload, adapter, {
        or: [{ views: { greater_than: 200 } }, { rating: { greater_than: 4.7 } }],
      })
      r.forEach((x) => {
        const a = (x.views as number) > 200
        const b = (x.rating as number) > 4.7
        expect(a || b).toBe(true)
      })
    })
    test('or with single condition', async () => {
      const r = await performVectorSearch(payload, adapter, {
        or: [{ status: { equals: 'published' } }],
      })
      r.forEach((x) => expect(x.status).toBe('published'))
    })
    test('or with one post-filter branch routes whole or to post', async () => {
      const r = await performVectorSearch(payload, adapter, {
        or: [{ status: { equals: 'published' } }, { tags: { like: 'python' } }],
      })
      r.forEach((x) => {
        const a = x.status === 'published'
        const b = (x.tags as string).toLowerCase().includes('python')
        expect(a || b).toBe(true)
      })
    })
  })

  describe('complex nested logic', () => {
    test('(published AND tech) OR archived', async () => {
      const r = await performVectorSearch(payload, adapter, {
        or: [
          {
            and: [
              { status: { equals: 'published' } },
              { category: { equals: 'tech' } },
            ],
          },
          { status: { equals: 'archived' } },
        ],
      })
      r.forEach((x) => {
        const tech = x.status === 'published' && x.category === 'tech'
        const arch = x.status === 'archived'
        expect(tech || arch).toBe(true)
      })
    })
  })

  describe('reserved fields filterable without declaration', () => {
    test('sourceCollection equals works on a pool that did not declare it', async () => {
      const r = await performVectorSearch(payload, adapter, {
        sourceCollection: { equals: 'articles' },
      })
      r.forEach((x) => expect(x.sourceCollection).toBe('articles'))
    })
  })

  describe('configuration errors', () => {
    test('filtering on undeclared field throws clearly', async () => {
      await expect(
        performVectorSearch(payload, adapter, {
          undeclared: { equals: 'x' },
        } as any),
      ).rejects.toThrowError(/not configured as filterableFields/)
    })
  })

  describe('limit', () => {
    test('returns at most `limit` results ordered by score', async () => {
      const r = await performVectorSearch(payload, adapter, undefined, 2)
      expect(r.length).toBeLessThanOrEqual(2)
      for (let i = 1; i < r.length; i++) {
        expect(r[i - 1].score).toBeGreaterThanOrEqual(r[i].score)
      }
    })
  })
})
```

- [ ] **Step 2: Write `adapters/mongodb/dev/specs/integration.spec.ts`**

```ts
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { MongoClient } from 'mongodb'
import type { BasePayload } from 'payload'
import type { DbAdapter } from 'payloadcms-vectorize'
import { createMongoVectorIntegration } from '../../src/index.js'
import { DIMS, MONGO_URI } from './constants.js'
import { dropTestDb, makeFakePayload, teardown } from './utils.js'

const DB1 = `vectorize_mongo_int_${Date.now()}_a`

describe('Mongo-specific integration tests', () => {
  let adapter: DbAdapter
  let payload: BasePayload

  beforeAll(async () => {
    await dropTestDb(MONGO_URI, DB1)
    const { adapter: a } = createMongoVectorIntegration({
      uri: MONGO_URI,
      dbName: DB1,
      pools: {
        default: {
          dimensions: DIMS,
          numCandidates: 50,
        },
        secondary: {
          dimensions: DIMS,
          numCandidates: 50,
        },
      },
    })
    adapter = a
    const ext = adapter.getConfigExtension({} as any)
    payload = makeFakePayload(ext.custom!)
  })

  afterAll(async () => {
    await dropTestDb(MONGO_URI, DB1)
    await teardown()
  })

  test('ensureSearchIndex is idempotent across multiple storeChunk calls', async () => {
    for (let i = 0; i < 3; i++) {
      await adapter.storeChunk(payload, 'default', {
        sourceCollection: 'idempotent',
        docId: `id-${i}`,
        chunkIndex: 0,
        chunkText: `chunk ${i}`,
        embeddingVersion: 'v1',
        embedding: Array(DIMS).fill(0.1 + i * 0.01),
        extensionFields: {},
      })
    }

    const c = new MongoClient(MONGO_URI)
    await c.connect()
    const indexes = (await c
      .db(DB1)
      .collection('vectorize_default')
      .listSearchIndexes()
      .toArray()) as Array<{ name: string }>
    const matches = indexes.filter((i) => i.name === 'vectorize_default_idx')
    expect(matches.length).toBe(1)
    await c.close()
  })

  test('storeChunk → immediate search returns the inserted doc', async () => {
    const docId = `imm-${Date.now()}`
    const target = Array(DIMS).fill(0.42)
    await adapter.storeChunk(payload, 'default', {
      sourceCollection: 'immediate',
      docId,
      chunkIndex: 0,
      chunkText: 'immediate test',
      embeddingVersion: 'v1',
      embedding: target,
      extensionFields: {},
    })
    const r = await adapter.search(payload, target, 'default', 5)
    const found = r.some((x) => x.docId === docId)
    expect(found).toBe(true)
  })

  test('multiple pools coexist without collision', async () => {
    await adapter.storeChunk(payload, 'secondary', {
      sourceCollection: 'sec',
      docId: 'sec-1',
      chunkIndex: 0,
      chunkText: 'secondary pool',
      embeddingVersion: 'v1',
      embedding: Array(DIMS).fill(0.9),
      extensionFields: {},
    })

    const c = new MongoClient(MONGO_URI)
    await c.connect()
    const a = await c.db(DB1).collection('vectorize_default').countDocuments()
    const b = await c.db(DB1).collection('vectorize_secondary').countDocuments()
    expect(a).toBeGreaterThan(0)
    expect(b).toBeGreaterThan(0)
    await c.close()
  })

  test('conflicting index definition throws actionable error', async () => {
    // Manually create an index with a different definition on a fresh pool.
    const dbName = `${DB1}_conflict`
    await dropTestDb(MONGO_URI, dbName)
    const c = new MongoClient(MONGO_URI)
    await c.connect()
    const coll = c.db(dbName).collection('vectorize_default')
    // Ensure the collection exists by inserting a sentinel doc, then drop it.
    await coll.insertOne({ _bootstrap: true })
    await coll.deleteMany({ _bootstrap: true })
    await coll.createSearchIndex({
      name: 'vectorize_default_idx',
      type: 'vectorSearch',
      definition: {
        fields: [
          { type: 'vector', path: 'embedding', numDimensions: DIMS, similarity: 'euclidean' },
          { type: 'filter', path: 'sourceCollection' },
          { type: 'filter', path: 'docId' },
          { type: 'filter', path: 'embeddingVersion' },
        ],
      },
    })

    const { adapter: badAdapter } = createMongoVectorIntegration({
      uri: MONGO_URI,
      dbName,
      pools: { default: { dimensions: DIMS, similarity: 'cosine', numCandidates: 50 } },
    })
    const badExt = badAdapter.getConfigExtension({} as any)
    const badPayload = makeFakePayload(badExt.custom!)

    await expect(
      badAdapter.storeChunk(badPayload, 'default', {
        sourceCollection: 'x',
        docId: 'x-1',
        chunkIndex: 0,
        chunkText: 'should fail',
        embeddingVersion: 'v1',
        embedding: Array(DIMS).fill(0.5),
        extensionFields: {},
      }),
    ).rejects.toThrowError(/different definition/)

    await c.db(dbName).dropDatabase()
    await c.close()
  })
})
```

- [ ] **Step 3: Run the integration + where suites**

Run: `cd adapters/mongodb && pnpm test:setup && pnpm exec vitest run`
Expected: all suites PASS. Total runtime ~2–3 min on first run (multiple search indexes built).

- [ ] **Step 4: Commit**

```bash
git add adapters/mongodb/dev/specs/vectorSearchWhere.spec.ts adapters/mongodb/dev/specs/integration.spec.ts
git commit -m "test(mongodb): add WHERE-clause + integration suites against live Mongo"
```

---

## Task 17: README

**Files:**
- Create: `adapters/mongodb/README.md`

- [ ] **Step 1: Write `adapters/mongodb/README.md`**

```markdown
# @payloadcms-vectorize/mongodb

MongoDB adapter for [`payloadcms-vectorize`](https://github.com/techiejd/payloadcms-vectorize). Targets both **MongoDB Atlas** (GA) and **self-hosted MongoDB Community 8.2+** (public preview) via a unified `$vectorSearch` API — connection string is the only difference.

> **Status:** experimental. Atlas behavior is GA-quality; self-hosted Community vector search is in public preview as of MongoDB 8.2.

## Install

```bash
pnpm add @payloadcms-vectorize/mongodb mongodb
```

## Connecting to Atlas

```ts
import { createMongoVectorIntegration } from '@payloadcms-vectorize/mongodb'

const { adapter } = createMongoVectorIntegration({
  uri: process.env.MONGODB_URI!, // mongodb+srv://...
  dbName: 'payload_vectorize',
  pools: {
    default: {
      dimensions: 1536,
      similarity: 'cosine',
      filterableFields: ['status', 'category', 'publishedAt'],
    },
  },
})
```

## Connecting to self-hosted (Docker)

```bash
docker run -d -p 27018:27017 mongodb/mongodb-atlas-local:latest
```

```ts
const { adapter } = createMongoVectorIntegration({
  uri: 'mongodb://localhost:27018/?directConnection=true',
  dbName: 'payload_vectorize',
  pools: { default: { dimensions: 1536, filterableFields: ['status'] } },
})
```

> Self-hosted vector search uses MongoDB's `mongot` engine (source-available, SSPL). It is in public preview in 8.2 — production-grade workloads should use Atlas.

## Configuration

| Option | Required | Default | Notes |
|---|---|---|---|
| `dimensions` | yes | — | Embedding vector dimensions; must match your model. |
| `similarity` | no | `'cosine'` | `'cosine' \| 'euclidean' \| 'dotProduct'`. |
| `numCandidates` | no | `max(limit*20, 100)` | ANN candidate set size for HNSW. |
| `filterableFields` | no | `[]` | Extension fields you'll filter on in `where` clauses. |
| `forceExact` | no | `false` | Use ENN exact full-scan instead of ANN. |
| `collectionName` | no | `vectorize_<pool>` | Override Mongo collection name. |
| `indexName` | no | `<collectionName>_idx` | Override search index name. |

## `filterableFields` explained

MongoDB's `$vectorSearch` requires every field used in its native pre-filter to be declared as `type: 'filter'` in the search index definition. The adapter automatically declares the reserved fields (`sourceCollection`, `docId`, `embeddingVersion`) and any field name you list in `filterableFields`.

Filtering on a field NOT in `filterableFields` (and not reserved) throws a clear adapter-side error before the request hits Mongo, rather than silently falling back to a slow scan.

## Index lifecycle

`ensureSearchIndex` runs lazily on the first `storeChunk` per pool:

1. Lists existing search indexes.
2. If the named index already exists with the same definition (`READY` or `BUILDING`), returns immediately.
3. If it exists with a *different* definition, throws an error. **Auto-dropping is unsafe** — drop manually:
   ```js
   db.collection('vectorize_default').dropSearchIndex('vectorize_default_idx')
   ```
4. Otherwise creates the index and polls `listSearchIndexes` (≤ 60s) until `status === 'READY'`.

The first write per pool may take ~5–30s while the index builds; subsequent calls are no-ops.

## WHERE clause behavior

The adapter splits a Payload `Where` clause into two stages:

- **Pre-filter** (fast, applied inside `$vectorSearch.filter`): `equals`, `not_equals`, `in`, `not_in`, `greater_than`/`gte`/`less_than`/`lte`, `exists`, plus `and`/`or` of any of those.
- **Post-filter** (correct, applied after the vector scan): `like`, `contains`, `all` — these aren't expressible in `$vectorSearch.filter`, so the adapter applies them in JS against the result rows.

### Implications

- `$vectorSearch.limit` is enforced **before** the post-filter. If many rows fail the post-filter, you may receive fewer than `limit` results. To compensate, the adapter does not over-fetch — the trade-off matches the Cloudflare Vectorize adapter's behavior.
- An `or` clause where any branch needs a post-filter operator is routed entirely to the post-filter to preserve disjunction semantics.
- Geo operators (`near`, `within`, `intersects`) are **not supported** — they throw a clear adapter error.

## Tier guidance

- **Atlas M0/Flex:** development only. Free, but search index is a single shared replica with limited memory.
- **Atlas M10+:** production. Use [Search Nodes](https://www.mongodb.com/docs/atlas/cluster-config/multi-cloud-distribution/) for dedicated `mongot` capacity.
- **Self-hosted Community 8.2+:** preview-only. Production use waits on GA.

## Limitations

- Post-filter operators can reduce result count below `limit`.
- Geo operators (`near`, `within`, `intersects`) throw — Mongo's `$vectorSearch` does not expose geo predicates.
- Changing `dimensions`, `similarity`, or `filterableFields` after the index exists requires a manual `dropSearchIndex` first.

## License

MIT.
```

- [ ] **Step 2: Commit**

```bash
git add adapters/mongodb/README.md
git commit -m "docs(mongodb): add README walking from install through Atlas + self-hosted"
```

---

## Task 18: Wire into root `package.json` and changeset config

**Files:**
- Modify: `package.json`
- Modify: `.changeset/config.json`

- [ ] **Step 1: Read current root `package.json`**

Open `package.json`. Lines to modify:
- `"build:adapters": "pnpm build:adapters:pg && pnpm build:adapters:cf"` (line 35) — chain `mongodb`.
- After `"build:adapters:cf": "..."` (line 37) — add `build:adapters:mongodb`.
- After `"test:adapters:cf": "..."` (line 60) — add `test:adapters:mongodb`.

- [ ] **Step 2: Apply edits to `package.json`**

Replace:
```json
"build:adapters": "pnpm build:adapters:pg && pnpm build:adapters:cf",
```
with:
```json
"build:adapters": "pnpm build:adapters:pg && pnpm build:adapters:cf && pnpm build:adapters:mongodb",
```

Replace:
```json
"build:adapters:cf": "cd ./adapters/cf && tsc -p tsconfig.build.json && swc ./src -d ./dist --config-file ../../.swcrc --strip-leading-paths",
```
with:
```json
"build:adapters:cf": "cd ./adapters/cf && tsc -p tsconfig.build.json && swc ./src -d ./dist --config-file ../../.swcrc --strip-leading-paths",
"build:adapters:mongodb": "cd ./adapters/mongodb && tsc -p tsconfig.build.json && swc ./src -d ./dist --config-file ../../.swcrc --strip-leading-paths",
```

Replace:
```json
"test:adapters:cf": "cross-env DOTENV_CONFIG_PATH=dev/.env.test NODE_OPTIONS='--require=dotenv/config --import=tsx --max-old-space-size=8192' vitest --config adapters/cf/vitest.config.ts"
```
with:
```json
"test:adapters:cf": "cross-env DOTENV_CONFIG_PATH=dev/.env.test NODE_OPTIONS='--require=dotenv/config --import=tsx --max-old-space-size=8192' vitest --config adapters/cf/vitest.config.ts",
"test:adapters:mongodb": "cross-env DOTENV_CONFIG_PATH=dev/.env.test NODE_OPTIONS='--require=dotenv/config --import=tsx --max-old-space-size=8192' vitest --config adapters/mongodb/vitest.config.ts"
```

- [ ] **Step 3: Update `.changeset/config.json`**

Replace:
```json
"fixed": [
  ["payloadcms-vectorize", "@payloadcms-vectorize/pg", "@payloadcms-vectorize/cf"]
],
```
with:
```json
"fixed": [
  ["payloadcms-vectorize", "@payloadcms-vectorize/pg", "@payloadcms-vectorize/cf", "@payloadcms-vectorize/mongodb"]
],
```

- [ ] **Step 4: Verify root scripts work**

Run: `pnpm build:adapters:mongodb`
Expected: `adapters/mongodb/dist/` populated with `.js` + `.d.ts`.

Run: `pnpm build:types:all`
Expected: PASS, no type errors anywhere in repo.

- [ ] **Step 5: Commit**

```bash
git add package.json .changeset/config.json
git commit -m "feat(mongodb): wire mongodb adapter into root build/test scripts and changesets"
```

---

## Task 19: CI job

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add `test_adapters_mongodb` job**

Append to `.github/workflows/ci.yml`, after the `test_adapters_cf` job and before `test_e2e`:

```yaml
  test_adapters_mongodb:
    runs-on: ubuntu-latest

    services:
      mongodb:
        image: mongodb/mongodb-atlas-local:latest
        ports:
          - 27018:27017
        options: >-
          --health-cmd "mongosh --quiet --eval 'db.runCommand({ping:1})'"
          --health-interval 5s
          --health-timeout 10s
          --health-retries 30

    steps:
      - uses: actions/checkout@v4

      - name: Install pnpm
        uses: pnpm/action-setup@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install

      - name: Run mongodb adapter tests
        run: pnpm test:adapters:mongodb
        env:
          PAYLOAD_SECRET: test-secret-key
          MONGODB_URI: mongodb://localhost:27018/?directConnection=true
          TEST_ENV: 1
```

- [ ] **Step 2: Validate the workflow file**

Run: `cd /Users/juandominguez/development/payloadcms-vectorize/.worktrees/mongodb-adapter && python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"`
Expected: no error (YAML parses cleanly).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci(mongodb): add test_adapters_mongodb job using mongodb-atlas-local service"
```

---

## Task 20: End-to-end verification

**Files:** none modified — verifies the full pipeline.

- [ ] **Step 1: Clean install + full build**

Run: `pnpm clean && pnpm install && pnpm build`
Expected: PASS, `adapters/mongodb/dist/` populated.

- [ ] **Step 2: Type check across the whole repo**

Run: `pnpm build:types:all`
Expected: PASS.

- [ ] **Step 3: Bring up Mongo and run the adapter test suite**

Run: `cd adapters/mongodb && pnpm test:setup`
Then: `cd /Users/juandominguez/development/payloadcms-vectorize/.worktrees/mongodb-adapter && pnpm test:adapters:mongodb`
Expected: all suites PASS (compliance + vectorSearchWhere + integration + convertWhere unit + escapeRegExp unit).

- [ ] **Step 4: Tear down**

Run: `cd adapters/mongodb && pnpm test:teardown`
Expected: container removed.

- [ ] **Step 5: Run the existing PG and CF suites to confirm no regressions**

Run: `pnpm test:setup && pnpm test:adapters:pg && pnpm test:adapters:cf && pnpm test:teardown`
Expected: PASS for both.

- [ ] **Step 6: Add a changeset entry**

Run: `pnpm changeset`
- Select: `@payloadcms-vectorize/mongodb`
- Bump: `minor`
- Summary: `Add MongoDB adapter (Atlas + self-hosted Community 8.2+) with $vectorSearch, pre/post filter split, and full WHERE-clause parity.`

- [ ] **Step 7: Commit changeset**

```bash
git add .changeset/
git commit -m "chore(mongodb): add changeset for new adapter"
```

- [ ] **Step 8: Push and open PR**

```bash
git push -u origin feat/mongodb-adapter
gh pr create --title "feat: add @payloadcms-vectorize/mongodb adapter" --body "$(cat <<'EOF'
## Summary
- New `@payloadcms-vectorize/mongodb` adapter targets MongoDB Atlas + self-hosted Community 8.2+ via unified `$vectorSearch`.
- WHERE-clause parity with the PG adapter: pre-filter for `equals`/`not_equals`/`in`/`not_in`/`gt`/`gte`/`lt`/`lte`/`exists`/`and`/`or`; post-filter for `like`/`contains`/`all`.
- Local dev + CI use `mongodb/mongodb-atlas-local` Docker image — no Atlas account or secrets.

## Test plan
- [x] `pnpm test:adapters:mongodb` passes locally
- [x] `pnpm test:adapters:pg` and `pnpm test:adapters:cf` still pass (no regressions)
- [x] `pnpm build:types:all` passes
- [x] Spec: `docs/superpowers/specs/2026-04-25-mongodb-adapter.md`
- [x] Plan: `docs/superpowers/plans/2026-04-25-mongodb-adapter.md`
EOF
)"
```

Expected: PR URL printed; CI runs the new `test_adapters_mongodb` job alongside existing jobs.

---

## Acceptance Criteria (from spec §13)

- `pnpm test:adapters:mongodb` passes against the docker-compose stack — Task 20 step 3.
- `pnpm build:adapters:mongodb` produces `adapters/mongodb/dist/` with `.js` + `.d.ts` — Task 18 step 4.
- `pnpm build:types:all` typechecks — Task 20 step 2.
- New CI job `test_adapters_mongodb` passes — Task 19 + Task 20 step 8.
- README walks a fresh user from `npm install` to a working vector search — Task 17.
- `where` parity with Payload CRUD — Task 16 (vectorSearchWhere covers the same operators against the same fixtures as the PG suite).
