# PayloadCMS Vectorize — Database Adapters

> **Audience:** This document is for **adapter authors** building a new database backend for the [`payloadcms-vectorize`](../README.md) plugin.
>
> **If you just want to use an existing adapter**, jump to the package READMEs:
> - [`@payloadcms-vectorize/pg`](./pg/README.md) — PostgreSQL + pgvector
> - [`@payloadcms-vectorize/cf`](./cf/README.md) — Cloudflare Vectorize
> - Or see the [main README](../README.md) for end-to-end setup.

---

**Tested against:** `payload@3.69.0` · `payloadcms-vectorize@0.7.2` · last verified `2026-04-25`. See the [CHANGELOG](../CHANGELOG.md) for interface changes — the `DbAdapter` shape changed in `0.7.0`.

## Table of Contents

- [Available Adapters](#available-adapters)
- [Architecture](#architecture)
  - [Lifecycle: ingest path](#lifecycle-ingest-path)
  - [Lifecycle: search path](#lifecycle-search-path)
  - [Lifecycle: bulk-embed path](#lifecycle-bulk-embed-path)
- [The `DbAdapter` Interface](#the-dbadapter-interface)
  - [Method reference](#method-reference)
  - [Error contract](#error-contract)
  - [Invariants](#invariants)
- [Reference Implementation](#reference-implementation)
- [Building a Custom Adapter](#building-a-custom-adapter)
  - [1. Package layout](#1-package-layout)
  - [2. Peer dependencies](#2-peer-dependencies)
  - [3. Implement the integration factory](#3-implement-the-integration-factory)
  - [4. Wire it into a Payload config](#4-wire-it-into-a-payload-config)
- [Types Reference](#types-reference)
- [Testing your adapter](#testing-your-adapter)
- [Common pitfalls](#common-pitfalls)
- [Adapter feature parity](#adapter-feature-parity)
- [Contributing](#contributing)
- [License](#license)

## Available Adapters

| Adapter              | Package                                                       | Database                          | Version  | Status      |
| -------------------- | ------------------------------------------------------------- | --------------------------------- | -------- | ----------- |
| PostgreSQL           | [`@payloadcms-vectorize/pg`](./pg/README.md)                  | PostgreSQL with `pgvector`        | `0.7.2`  | Stable      |
| Cloudflare Vectorize | [`@payloadcms-vectorize/cf`](./cf/README.md)                  | Cloudflare Vectorize index        | `0.7.2`  | Beta        |
| MongoDB              | [`@payloadcms-vectorize/mongodb`](./mongodb/README.md)        | MongoDB Atlas + self-hosted 8.2+  | `0.7.2`  | Beta        |

## Architecture

The plugin is provider-agnostic. It owns the **lifecycle** (when to embed, when to delete, when to search) and delegates the **storage and query** of vectors to a `DbAdapter`.

```
                ┌─────────────────────────────────────┐
                │        Payload CMS Collection       │
                │        (e.g. `posts`, `docs`)       │
                └────────┬────────────────────┬───────┘
                         │ afterChange        │ afterDelete
                         ▼                    ▼
                ┌─────────────────────────────────────┐
                │        payloadcms-vectorize         │
                │  (queues jobs, calls embedding fn)  │
                └────────┬────────────────────┬───────┘
                         │ storeChunk         │ deleteChunks
                         │ hasEmbeddingVersion│ search
                         ▼                    ▼
                ┌─────────────────────────────────────┐
                │             DbAdapter               │
                │   (PG / CF / your custom backend)   │
                └─────────────────────────────────────┘
```

The plugin never talks to the vector store directly. Every read or write goes through one of the four `DbAdapter` methods.

### Lifecycle: ingest path

For each document write in a collection registered to a knowledge pool:

1. The plugin's `afterChange` hook fires ([src/index.ts:234](../src/index.ts#L234)).
2. It runs `shouldEmbedFn` (if configured) to decide whether to skip.
3. It queues a Payload job (`TASK_SLUG_VECTORIZE`) on the configured queue.
4. The job calls the user's `realTimeIngestionFn(texts)` to produce embeddings.
5. The job calls **`adapter.storeChunk(payload, poolName, data)`** for each chunk, where `data` is a [`StoreChunkData`](#types-reference) object.

**Your adapter's `storeChunk` is the single write entry point for real-time ingestion.**

### Lifecycle: search path

1. A consumer calls either `POST /api/vector-search` or `getVectorizedPayload(payload).search({ knowledgePool, query, where, limit })`.
2. The plugin calls the configured `queryFn(query)` to embed the query string.
3. The plugin calls **`adapter.search(payload, queryEmbedding, poolName, limit, where)`**.
4. The plugin returns the array of `VectorSearchResult` to the caller, untransformed.

**Your adapter is responsible for translating Payload-style `where` clauses** into your store's filter language. See [Common pitfalls](#common-pitfalls).

### Lifecycle: bulk-embed path

When a knowledge pool defines `bulkEmbeddingsFns` (provider-driven batch APIs like OpenAI Batch, Voyage Batch, etc.):

1. A consumer calls `getVectorizedPayload(payload).bulkEmbed({ knowledgePool })`.
2. The plugin paginates source collections and, for each candidate document, asks **`adapter.hasEmbeddingVersion(payload, poolName, sourceCollection, docId, embeddingVersion)`** to skip docs that already have the current version.
3. When provider batches complete, the plugin calls **`adapter.storeChunk(...)`** for each output.
4. On document delete, the plugin calls **`adapter.deleteChunks(payload, poolName, sourceCollection, docId)`**.

## The `DbAdapter` Interface

The full type lives in [`src/types.ts`](../src/types.ts) and is re-exported from `payloadcms-vectorize`:

```typescript
import type { Config, BasePayload, Payload, Where, CollectionConfig } from 'payload'
import type {
  KnowledgePoolName,
  KnowledgePoolDynamicConfig,
  StoreChunkData,
  VectorSearchResult,
} from 'payloadcms-vectorize'

export type DbAdapter = {
  getConfigExtension: (
    payloadCmsConfig: Config,
    knowledgePools?: Record<string, KnowledgePoolDynamicConfig>,
  ) => {
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

### Method reference

| Method | When called | Required behavior |
|---|---|---|
| `getConfigExtension` | Once during plugin init, before Payload boots. | Return any CLI bins, adapter-private state (`custom._staticConfigs`, etc.), and the embeddings collections (`collections[poolName]`) the plugin should register. The plugin merges these into the Payload `Config`. |
| `storeChunk` | Per chunk during real-time ingest **and** per output during bulk completion. | Persist the embedding plus all fields in `StoreChunkData` (including `extensionFields`) so they are queryable from `search`. Idempotency is **not** guaranteed by the plugin — you may receive duplicate calls on retry. |
| `deleteChunks` | After a source document is deleted. | Remove every chunk where `sourceCollection === ... && docId === ...`. Must be safe to call when no chunks exist (no-op, no throw). |
| `hasEmbeddingVersion` | During bulk-embed planning, per candidate document. | Return `true` iff at least one chunk exists with the matching `(sourceCollection, docId, embeddingVersion)` triple. Must filter on **all three** — older `0.7.0` adapters that ignored `embeddingVersion` caused stale embeddings on model bumps. |
| `search` | Per `/vector-search` request and per `getVectorizedPayload().search()` call. | Translate `where` (Payload-style) into your store's filter language, perform a vector search using `queryEmbedding`, and return up to `limit` results sorted by descending relevance. |

### Error contract

- **Adapters should `throw`** on unrecoverable failures. The plugin propagates errors from job handlers, so thrown errors from `storeChunk` will mark the Payload job as failed and trigger normal job-retry semantics.
- **`deleteChunks` should not throw on "nothing to delete"** — the plugin already wraps this call in a `try/catch` ([src/index.ts:249-261](../src/index.ts#L249-L261)) and only logs warnings, but throwing here adds noise to logs without changing behavior.
- **`search` should not throw on "no matches"** — return `[]` instead.
- For `where` translation errors (unknown operator, invalid field), throw with a clear `[@your-pkg]` prefix so users can identify the source.

### Invariants

- **`id` uniqueness in `storeChunk`**: the plugin does not deduplicate. If your store has unique constraints on `(sourceCollection, docId, chunkIndex)`, enforce them yourself.
- **Score direction**: by convention, **higher score = more relevant**. The PG adapter returns `1 - cosine_distance` so results live in `[0, 1]`. Document your range in the package README — consumers may threshold on it.
- **Embedding dims**: the plugin does **not** validate `embedding.length` against the configured `dims`. Adapters that enforce a fixed schema (PG with `vector(N)`, CF index dims) should fail loudly; others should at minimum log.
- **`extensionFields` round-trip**: any value in `data.extensionFields` passed to `storeChunk` must be retrievable in `VectorSearchResult` via `[key: string]: any`. This is what makes `where` filtering on user-defined fields work.

## Reference Implementation

**The PostgreSQL adapter is the canonical reference.** When in doubt, read it — every method is implemented in a small, focused file:

- Factory + `DbAdapter` shape: [adapters/pg/src/index.ts](./pg/src/index.ts)
- Vector search + `where` translation: [adapters/pg/src/search.ts](./pg/src/search.ts)
- Embedding storage helper: [adapters/pg/src/embed.ts](./pg/src/embed.ts)
- Schema registration / Drizzle integration: [adapters/pg/src/drizzle.ts](./pg/src/drizzle.ts)
- CLI bin (migration helper): [adapters/pg/src/bin-vectorize-migrate.ts](./pg/src/bin-vectorize-migrate.ts)

Test coverage to mirror lives in [`adapters/pg/dev/specs/`](./pg/dev/specs/) — note the `vectorSearchWhere.spec.ts` suite that exercises every `where` operator across 31 tests. A new adapter is expected to pass an equivalent suite for its own `where` translation.

## Building a Custom Adapter

### 1. Package layout

```
adapters/your-db/
├── src/
│   ├── index.ts        # Factory + DbAdapter shape
│   ├── search.ts       # search() + where translation
│   ├── embed.ts        # storeChunk() helpers
│   └── types.ts        # YourDbConfig, etc.
├── package.json
├── tsconfig.build.json
└── README.md           # User-facing setup guide
```

### 2. Peer dependencies

Pin to the current published versions:

```json
{
  "name": "@payloadcms-vectorize/your-db",
  "version": "0.0.1",
  "peerDependencies": {
    "payload": ">=3.0.0 <4.0.0",
    "payloadcms-vectorize": ">=0.7.2"
  }
}
```

If your adapter wraps a Payload db-adapter (like `@payloadcms/db-postgres`), add it as a peer too — see [`adapters/pg/package.json`](./pg/package.json) for the live pattern.

### 3. Implement the integration factory

The factory is the public export users call. It can return any backend-specific hooks (e.g. PG returns `afterSchemaInitHook`) plus the required `adapter`. Below is a **minimal compiling stub** — copy this and fill in the `// TODO` blocks:

```typescript
import type { DbAdapter } from 'payloadcms-vectorize'
import { createEmbeddingsCollection } from 'payloadcms-vectorize'

export type YourDbPoolsConfig = {
  [poolName: string]: {
    dims: number
    // ...your backend-specific options
  }
}

export const createYourDbVectorIntegration = (
  config: YourDbPoolsConfig,
): { adapter: DbAdapter } => {
  const adapter: DbAdapter = {
    getConfigExtension: (_payloadCmsConfig, knowledgePools) => {
      const collections: Record<string, any> = {}
      if (knowledgePools) {
        for (const poolName of Object.keys(knowledgePools)) {
          // Register the embeddings collection the core plugin expects
          collections[poolName] = createEmbeddingsCollection(
            poolName,
            knowledgePools[poolName].extensionFields,
          )
        }
      }
      return {
        custom: { _staticConfigs: config },
        collections,
        // bins: [{ key: 'vectorize:your-cmd', scriptPath: '/abs/path.js' }],
      }
    },

    storeChunk: async (payload, poolName, data) => {
      // TODO: persist data.embedding plus the rest of StoreChunkData
      //       so search() can retrieve and filter on them.
      throw new Error('storeChunk not implemented')
    },

    deleteChunks: async (payload, poolName, sourceCollection, docId) => {
      // TODO: delete every chunk where (sourceCollection, docId) match.
      //       Must be a safe no-op if nothing matches.
    },

    hasEmbeddingVersion: async (
      payload,
      poolName,
      sourceCollection,
      docId,
      embeddingVersion,
    ) => {
      // TODO: return true iff at least one chunk exists matching all three.
      return false
    },

    search: async (payload, queryEmbedding, poolName, limit, where) => {
      // TODO: vector search + translate `where` to your backend's filter API.
      //       Return Array<VectorSearchResult> sorted by descending score.
      return []
    },
  }

  return { adapter }
}
```

### 4. Wire it into a Payload config

Users will mount your adapter alongside their Payload db adapter:

```typescript
import { buildConfig } from 'payload'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { createYourDbVectorIntegration } from '@payloadcms-vectorize/your-db'
import payloadcmsVectorize from 'payloadcms-vectorize'

const integration = createYourDbVectorIntegration({
  mainPool: { dims: 1536 },
})

export default buildConfig({
  db: postgresAdapter({
    pool: { connectionString: process.env.DATABASE_URI },
    // If your adapter exposes hooks (like PG's afterSchemaInitHook), wire them here.
  }),
  plugins: [
    payloadcmsVectorize({
      dbAdapter: integration.adapter,
      knowledgePools: {
        mainPool: {
          collections: { /* ... */ },
          embeddingConfig: {
            version: 'voyage-3-large@1',
            queryFn: async (q) => { /* ... */ return [] },
          },
        },
      },
    }),
  ],
})
```

> **Pool name consistency:** the same key (`mainPool`) appears in the integration factory, in `knowledgePools`, and in any `search({ knowledgePool: 'mainPool' })` call. Mismatched pool names are the most common copy-paste bug — keep them identical end-to-end.

## Types Reference

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

export interface VectorSearchResult {
  /** Embedding record ID (your adapter's primary key for the chunk). */
  id: string
  /** Relevance score. Convention: higher = more relevant. Document the range in your README. */
  score: number
  /** Source collection slug (echoed from StoreChunkData). */
  sourceCollection: string
  /** Source document ID (echoed from StoreChunkData). */
  docId: string
  /** Chunk index within the source document. */
  chunkIndex: number
  /** The original chunk text. */
  chunkText: string
  /** Embedding model/version string. */
  embeddingVersion: string
  /** Any extensionFields persisted via storeChunk must round-trip here. */
  [key: string]: any
}
```

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Your adapter's chunk PK; consumers may use it for delete/update flows. |
| `score` | yes | See [Invariants](#invariants) — higher = better. |
| `sourceCollection`, `docId`, `chunkIndex` | yes | Must round-trip from `StoreChunkData`. |
| `chunkText`, `embeddingVersion` | yes | Same. |
| `extensionFields.*` | optional | Whatever the user passed in `extensionFields` must be queryable via `where`. |

## Testing your adapter

The dev harness in [`dev/`](../dev) runs the integration suite against any adapter you wire up. To test a new adapter:

1. Add your adapter to `pnpm-workspace.yaml`.
2. Wire it into [`dev/payload.config.ts`](../dev/payload.config.ts) behind an env switch (mirror how PG/CF are wired).
3. Run the suites that matter:
   - `pnpm test:int` — full integration suite (real Payload, real DB).
   - `pnpm test:e2e` — Playwright E2E.
   - `pnpm vitest adapters/pg/dev/specs/vectorSearchWhere.spec.ts` — the `where` operator suite (31 tests). **Every adapter should pass this.**

If your store doesn't support an operator, document it in [Adapter feature parity](#adapter-feature-parity) and have your `where` translation throw a clear error rather than silently returning wrong results.

## Common pitfalls

| Pitfall | Symptom | Fix |
|---|---|---|
| Score direction inverted | Top results are the *least* relevant. | Convert distance → similarity before returning (`1 - cosine_distance`, etc.). |
| `where` translation drops conditions | Filters silently ignored. | Throw on unknown operators. Test with the `vectorSearchWhere.spec.ts` suite. |
| `hasEmbeddingVersion` ignores `embeddingVersion` | Model version bumps don't trigger re-embedding. | Filter on **all three** of `sourceCollection`, `docId`, `embeddingVersion`. (This was a real CF adapter bug — see [CHANGELOG 0.7.1](../CHANGELOG.md#071---2026-03-20).) |
| `like` operator treated as regex | Patterns containing `.`, `+`, `(` match unintended strings. | Escape regex special characters before applying. |
| Empty `where: {}` throws | Search breaks for the no-filter case. | Treat empty objects as "no filter applied". |
| Pool name mismatch | `search()` returns nothing despite chunks existing. | Use the **same** pool key in factory config, `knowledgePools`, and `search({ knowledgePool })`. |
| `extensionFields` not persisted | `where` filters on user-defined fields silently match nothing. | Persist every key in `data.extensionFields` and surface them on `VectorSearchResult`. |

## Adapter feature parity

| Feature | PG | CF | Notes |
|---|---|---|---|
| Real-time ingest (`storeChunk`) | ✅ | ✅ | |
| Bulk ingest (`hasEmbeddingVersion` + `storeChunk`) | ✅ | ✅ | |
| `where` operators | full | full | Both pass `vectorSearchWhere.spec.ts`. |
| Server-side `like` regex | ✅ | ✅ (with regex escape — see CHANGELOG 0.7.1) | |
| Migration CLI bin | ✅ (`vectorize:migrate`) | ❌ | CF uses indexes managed via Cloudflare API. |
| Score range | `[0, 1]` (cosine similarity) | varies by index metric | Document yours. |

If something here is out of date, please [open an issue](https://github.com/techiejd/payloadcms-vectorize/issues) — adapter parity drift is exactly what this table exists to surface.

## Contributing

Want to add a new database backend? Great.

1. **Open an issue first** at [github.com/techiejd/payloadcms-vectorize/issues](https://github.com/techiejd/payloadcms-vectorize/issues) to discuss the approach — vector stores have surprisingly different filter models, and we may already have ideas about the translation layer.
2. Use the [PG adapter](./pg/) as a structural reference. Match its file layout where reasonable so reviewers can navigate.
3. Add your adapter to the dev harness and make `vectorSearchWhere.spec.ts` pass.
4. Update [Available Adapters](#available-adapters) and [Adapter feature parity](#adapter-feature-parity) in this file.
5. Add your package to the root `package.json` build scripts (mirror `build:adapters:pg`).

For larger design conversations, deep-dive design docs land in [`docs/plans/`](../docs/plans/) — see existing examples there for the format.

## License

[MIT](../LICENSE) — same as the core plugin and all official adapters.
