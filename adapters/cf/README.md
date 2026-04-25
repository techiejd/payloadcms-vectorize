# @payloadcms-vectorize/cf

[![npm version](https://img.shields.io/npm/v/@payloadcms-vectorize/cf.svg)](https://www.npmjs.com/package/@payloadcms-vectorize/cf)
[![npm downloads](https://img.shields.io/npm/dm/@payloadcms-vectorize/cf.svg)](https://www.npmjs.com/package/@payloadcms-vectorize/cf)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../LICENSE)
[![Payload CMS](https://img.shields.io/badge/Payload-3.x-000000.svg)](https://payloadcms.com)

Cloudflare Vectorize adapter for [payloadcms-vectorize](https://github.com/techiejd/payloadcms-vectorize). Stores and queries embeddings in a Cloudflare Vectorize index instead of a Postgres column.

> **Status:** `0.x` — pre-1.0. The public API is stabilizing but may still have breaking changes between minor releases. Track the [CHANGELOG](./CHANGELOG.md) before upgrading.

## Who is this for?

Use this adapter if **all** of the following are true:

- You are deploying Payload (or a Payload-fronted API) somewhere that exposes a Cloudflare [Vectorize binding](https://developers.cloudflare.com/vectorize/) — i.e. Cloudflare Workers, Pages Functions, or another runtime that supplies a `VectorizeIndex` object.
- You want vector storage to scale independently of your primary Payload database.
- You can live with the [Vectorize platform constraints](#vectorize-platform-constraints) (topK ≤ 100, 64-byte indexed metadata, no native `OR`).

If you're on a long-running Node host with Postgres available, prefer [`@payloadcms-vectorize/pg`](../pg/README.md) — it has fewer query-time limits and runs everything in one database.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [How it works](#how-it-works)
- [Quick Start](#quick-start)
- [API Reference](#api-reference)
  - [`createCloudflareVectorizeIntegration(options)`](#createcloudflarevectorizeintegrationoptions)
  - [Pool config](#pool-config)
- [Multiple Knowledge Pools](#multiple-knowledge-pools)
- [Embedding Providers](#embedding-providers)
- [Metadata Filtering](#metadata-filtering)
- [Known Limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)
- [Architecture](#architecture)
- [Contributing](#contributing)
- [Changelog](#changelog)
- [License](#license)

## Prerequisites

- A Cloudflare account with [Vectorize](https://developers.cloudflare.com/vectorize/) enabled.
- A runtime that exposes a Vectorize binding to your code (Workers, Pages Functions, or `wrangler dev`).
- Payload CMS `3.x` (peer-dep range: `>=3.0.0 <4.0.0`).
- `payloadcms-vectorize` matching this adapter's version (peer-dep range: `>=0.7.2`).
- Node.js `^18.20.2` or `>=20.9.0`.
- [`wrangler`](https://developers.cloudflare.com/workers/wrangler/) for creating and configuring the Vectorize index.

## Installation

```bash
pnpm add payloadcms-vectorize @payloadcms-vectorize/cf
```

> **Note on host adapter:** the examples below use `@payloadcms/db-sqlite` because it's the only first-party Payload database adapter that runs inside Cloudflare Workers (against D1). On a Node/Bun host, swap in `@payloadcms/db-postgres` or `@payloadcms/db-mongodb` as appropriate.

## How it works

The adapter is the bridge between Payload's plugin and a Cloudflare Vectorize index. There is **one invariant you must respect** to avoid runtime errors:

> ⚠️ **Dimension parity:** the `dims` value on each pool config **must equal** (a) your embedding model's output size and (b) the `--dimensions` value used when creating the Vectorize index. Vectorize rejects mismatched vectors at upsert time.

Beyond that, three facts shape day-to-day usage:

1. **One pool per Vectorize index.** The adapter does not multiplex pools onto a single index. If you configure two pools, you create two indexes with `wrangler vectorize create`.
2. **Metadata is indexed at insert time.** A `metadataIndex` must exist on a field **before** vectors are inserted, or filtering on that field returns nothing. See [Metadata Filtering](#metadata-filtering).
3. **A hidden Payload collection (`vector-cf-mappings`) tracks vector IDs.** It exists because Vectorize has no "delete by metadata" — when a source document is deleted, the adapter looks up its vector IDs in this collection and calls `deleteByIds`. You don't interact with it directly, but it shows up in your migrations.

For the rest of the architecture (vector ID format, reserved metadata fields, filter splitter), see [Architecture](#architecture).

## Quick Start

This Quick Start gets you a working semantic-search endpoint on Cloudflare Workers. Paste each block in order.

### 1. Create the Vectorize index

```bash
wrangler vectorize create my-vectorize-index --dimensions=1024 --metric=cosine
```

`--dimensions=1024` matches Voyage's `voyage-3.5-lite` model used below. If you change embedding providers, change all three: model output, this flag, and the `dims` field in step 3.

### 2. Create metadata indexes (only if you plan to filter)

Filtering on a metadata field requires a metadata index, and the index must exist **before** vectors are inserted. Create one per field you'll filter on:

```bash
wrangler vectorize create-metadata-index my-vectorize-index --property-name=sourceCollection --type=string
wrangler vectorize create-metadata-index my-vectorize-index --property-name=embeddingVersion --type=string
```

The adapter always writes `sourceCollection`, `docId`, `chunkIndex`, `chunkText`, and `embeddingVersion` into vector metadata. Index whichever of those (and your own `extensionFields`) you want to filter on. See [Metadata Filtering](#metadata-filtering) for the supported operators.

### 3. Wire up `wrangler.toml`

```toml
name = "my-payload-app"
main = "src/index.ts"
compatibility_date = "2025-01-01"
compatibility_flags = ["nodejs_compat"]

[[vectorize]]
binding = "VECTORIZE"
index_name = "my-vectorize-index"

[ai]
binding = "AI"

[[d1_databases]]
binding = "DB"
database_name = "my-payload-db"
database_id = "<your-d1-database-id>"
```

### 4. Configure the plugin

```typescript
import { buildConfig } from 'payload'
import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { embed, embedMany } from 'ai'
import { voyage } from 'voyage-ai-provider'
import payloadcmsVectorize from 'payloadcms-vectorize'
import { createCloudflareVectorizeIntegration } from '@payloadcms-vectorize/cf'

export const buildPayloadConfig = (env: Env) => {
  const embedDocs = async (texts: string[]): Promise<number[][]> => {
    const result = await embedMany({
      model: voyage.textEmbeddingModel('voyage-3.5-lite'),
      values: texts,
      providerOptions: { voyage: { inputType: 'document' } },
    })
    return result.embeddings
  }

  const embedQuery = async (text: string): Promise<number[]> => {
    const result = await embed({
      model: voyage.textEmbeddingModel('voyage-3.5-lite'),
      value: text,
      providerOptions: { voyage: { inputType: 'query' } },
    })
    return result.embedding
  }

  const integration = createCloudflareVectorizeIntegration({
    config: {
      default: {
        dims: 1024,
      },
    },
    binding: env.VECTORIZE,
  })

  return buildConfig({
    db: sqliteAdapter({ client: { url: 'd1', database: env.DB } }),
    collections: [
      {
        slug: 'posts',
        fields: [{ name: 'title', type: 'text' }],
      },
    ],
    plugins: [
      payloadcmsVectorize({
        dbAdapter: integration.adapter,
        knowledgePools: {
          default: {
            collections: {
              posts: {
                toKnowledgePool: async (doc) => [{ chunk: doc.title || '' }],
              },
            },
            embeddingConfig: {
              version: 'v1.0.0',
              queryFn: embedQuery,
              realTimeIngestionFn: embedDocs,
            },
          },
        },
      }),
    ],
    secret: env.PAYLOAD_SECRET,
  })
}
```

### 5. Pass the binding from your Worker entrypoint

Workers don't have ambient `env` — you have to thread it through to `buildConfig`. Build the Payload config inside the request handler:

```typescript
import { getPayload } from 'payload'
import { buildPayloadConfig } from './payload.config'

export interface Env {
  VECTORIZE: VectorizeIndex
  DB: D1Database
  PAYLOAD_SECRET: string
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const payload = await getPayload({ config: buildPayloadConfig(env) })
    // ...handle request, e.g. payload.find / vector search
    return new Response('ok')
  },
}
```

The `VectorizeIndex` and `D1Database` types come from `@cloudflare/workers-types` (`pnpm add -D @cloudflare/workers-types`).

## API Reference

### `createCloudflareVectorizeIntegration(options)`

Creates the `DbAdapter` that the core plugin uses for vector storage.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `options.config` | `Record<string, { dims: number }>` | Yes | Map of knowledge-pool name → pool config. Pool names must match the keys of `knowledgePools` passed to `payloadcmsVectorize(...)`. |
| `options.binding` | `VectorizeIndex` | Yes | The Vectorize binding from your Worker `env`. Throws at construction time if missing. |

**Returns:** `{ adapter: DbAdapter }` — pass `adapter` to `payloadcmsVectorize({ dbAdapter })`.

### Pool config

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `dims` | `number` | Yes | Vector dimensions. Must equal your embedding model's output size and the `--dimensions` value passed to `wrangler vectorize create`. Mismatches throw at upsert time. |

A pool maps 1:1 to a Vectorize index — there is no parameter to share an index across pools.

## Multiple Knowledge Pools

Each pool needs its own Vectorize index, created with the matching dimension:

```bash
wrangler vectorize create posts-index --dimensions=1024 --metric=cosine
wrangler vectorize create images-index --dimensions=1024 --metric=cosine
```

```toml
[[vectorize]]
binding = "VECTORIZE_POSTS"
index_name = "posts-index"

[[vectorize]]
binding = "VECTORIZE_IMAGES"
index_name = "images-index"
```

Because the adapter takes a single binding, each pool gets its own integration:

```typescript
const postsIntegration = createCloudflareVectorizeIntegration({
  config: { posts: { dims: 1024 } },
  binding: env.VECTORIZE_POSTS,
})

const imagesIntegration = createCloudflareVectorizeIntegration({
  config: { images: { dims: 1024 } },
  binding: env.VECTORIZE_IMAGES,
})
```

> **Note:** the current adapter API takes a single binding per integration. To register multiple pools against a single integration call, all pools must share one binding/index — which is not how Vectorize is designed to be used. Prefer one integration per pool, and pass the *combined* `dbAdapter` into `payloadcmsVectorize` only once. If you need multi-pool support inside a single integration, please [open an issue](https://github.com/techiejd/payloadcms-vectorize/issues).

## Embedding Providers

The Quick Start uses Voyage AI, but any function with the right shape works.

### Voyage AI (recommended for portability)

```typescript
import { embed, embedMany } from 'ai'
import { voyage } from 'voyage-ai-provider'

export const embedDocs = async (texts: string[]): Promise<number[][]> => {
  const result = await embedMany({
    model: voyage.textEmbeddingModel('voyage-3.5-lite'),
    values: texts,
    providerOptions: { voyage: { inputType: 'document' } },
  })
  return result.embeddings
}

export const embedQuery = async (text: string): Promise<number[]> => {
  const result = await embed({
    model: voyage.textEmbeddingModel('voyage-3.5-lite'),
    value: text,
    providerOptions: { voyage: { inputType: 'query' } },
  })
  return result.embedding
}
```

### Cloudflare Workers AI (free tier, lower-quality embeddings)

`@cf/baai/bge-small-en-v1.5` produces 384-dim vectors — set `dims: 384` and recreate your index with `--dimensions=384`.

```typescript
export const buildEmbedders = (env: { AI: Ai }) => ({
  embedDocs: async (texts: string[]): Promise<number[][]> => {
    const results = await Promise.all(
      texts.map((text) => env.AI.run('@cf/baai/bge-small-en-v1.5', { text })),
    )
    return results.map((r) => r.data[0])
  },
  embedQuery: async (text: string): Promise<number[]> => {
    const result = await env.AI.run('@cf/baai/bge-small-en-v1.5', { text })
    return result.data[0]
  },
})
```

## Metadata Filtering

Pass a Payload-style `where` clause to vector search; the adapter splits it into a Vectorize-native filter (applied **before** topK) and a JS post-filter (applied **after** topK).

| Operator | Path | Notes |
| --- | --- | --- |
| `equals`, `not_equals` (`notEquals`) | Native | Applied pre-topK. |
| `in`, `notIn` (`not_in`) | Native | Applied pre-topK. |
| `greater_than` (`greaterThan`), `greater_than_equal` (`greaterThanEqual`) | Native | Applied pre-topK. |
| `less_than` (`lessThan`), `less_than_equal` (`lessThanEqual`) | Native | Applied pre-topK. |
| `like`, `contains`, `exists` | Post-filter | Applied in JS after Vectorize returns topK matches — may return fewer rows than `limit`. |
| `or` (top-level) | Post-filter | Vectorize has no native OR; the entire OR clause is post-filtered. `and` clauses with native operators stay native. |

**Important:** Native filters require a metadata index on the field, created via `wrangler vectorize create-metadata-index` **before** vectors are inserted. Without an index, the filter silently matches nothing. Reserved metadata fields written by the adapter (`sourceCollection`, `docId`, `chunkIndex`, `chunkText`, `embeddingVersion`) follow the same rule — index them with `--type=string` if you want to filter on them.

### Examples

Pre-topK filter, exact result count:

```typescript
const results = await search({
  knowledgePool: 'default',
  query: 'how do I cancel my subscription?',
  limit: 10,
  where: { sourceCollection: { equals: 'posts' } },
})
```

Post-filter (note: may return fewer than `limit` results):

```typescript
const results = await search({
  knowledgePool: 'default',
  query: 'cancellation policy',
  limit: 10,
  where: { chunkText: { contains: 'refund' } },
})
```

OR clause — entirely post-filtered against the topK Vectorize returns:

```typescript
const results = await search({
  knowledgePool: 'default',
  query: 'cancellation policy',
  limit: 10,
  where: {
    or: [
      { sourceCollection: { equals: 'posts' } },
      { sourceCollection: { equals: 'docs' } },
    ],
  },
})
```

## Known Limitations

### Vectorize platform constraints

| Constraint | Limit |
| --- | --- |
| `topK` maximum | 100 (or 20 when returning metadata, which the adapter always does) |
| Indexed string metadata | First 64 bytes only, truncated at UTF-8 boundaries |
| Filter object size | < 2048 bytes JSON-encoded |
| Range query accuracy | May degrade past ~10M vectors per index |
| Native `OR` | Not supported — see post-filter behavior above |

These come from Vectorize itself; the adapter inherits them. The authoritative reference is the [Vectorize limits page](https://developers.cloudflare.com/vectorize/platform/limits/).

### Adapter-specific gaps

- **Multi-pool through one integration** — the current API takes a single binding per call to `createCloudflareVectorizeIntegration`. See [Multiple Knowledge Pools](#multiple-knowledge-pools).
- **Test parity with the PG adapter** — the project's top-level integration suite (`dev/specs/`) exercises `@payloadcms-vectorize/pg` against a real database. CF has its own suite under [`adapters/cf/dev/specs/`](./dev/specs/) covering the `DbAdapter` interface (`compliance.spec.ts`), filter splitting and post-filtering (`where.spec.ts`), and adapter wiring (`adapter.spec.ts`) — but with the Vectorize binding mocked, since there is no local Vectorize emulator. Full e2e parity against a live index is tracked in the [issue tracker](https://github.com/techiejd/payloadcms-vectorize/issues).

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `Cloudflare Vectorize binding not found` | Plugin invoked before `buildConfig` received `env.VECTORIZE`, or the `wrangler.toml` `[[vectorize]]` block is missing/misnamed. | Confirm `binding = "VECTORIZE"` in `wrangler.toml`, and that you're building the Payload config inside the Worker `fetch` handler (see [Quick Start step 5](#5-pass-the-binding-from-your-worker-entrypoint)). |
| Upserts throw `dimension mismatch` (or 400 from Vectorize) | The `dims` config, the index's `--dimensions`, and the embedding model output disagree. | Set all three to the same value. Recreate the index if you changed the model. |
| Filter returns 0 results when data clearly matches | No metadata index exists for that field, or the index was created **after** vectors were inserted. | `wrangler vectorize create-metadata-index <index> --property-name=<field> --type=string`, then re-embed. |
| `topK` capped at 20 instead of 100 | Adapter requests `returnMetadata: 'all'`, which Vectorize caps at 20 per the [platform limits](https://developers.cloudflare.com/vectorize/platform/limits/). | Expected — request fewer results, or page externally. |
| `OR` clause returns fewer than `limit` results | OR is post-filtered; the topK pool Vectorize returned didn't have enough OR-matching rows. | Increase upstream topK by relaxing other filters, or split into two queries and merge. |
| `'env' is not defined` in TypeScript | Cloudflare bindings aren't ambient. | Import `Env` from your Worker entrypoint and pass it into your config builder; install `@cloudflare/workers-types` for `VectorizeIndex` / `D1Database`. |

If you hit something not listed here, please [open an issue](https://github.com/techiejd/payloadcms-vectorize/issues) — bug reports against this README are welcome too.

## Architecture

This section is for contributors and people debugging the adapter itself.

**Source layout** ([adapters/cf/src/](./src/)):

- [`index.ts`](./src/index.ts) — exports `createCloudflareVectorizeIntegration`. Wires the four `DbAdapter` methods (`getConfigExtension`, `search`, `storeChunk`, `deleteChunks`, `hasEmbeddingVersion`) and stashes the binding + pool config in Payload's `custom` config so other modules can retrieve it.
- [`embed.ts`](./src/embed.ts) — `storeChunk`. Builds vector ID, upserts to Vectorize, writes a row in the `vector-cf-mappings` collection so we can find the vector again at delete time.
- [`search.ts`](./src/search.ts) — query path. Splits the Payload `where` into native + post-filter, calls `vectorize.query`, mirrors metadata back into the result shape the core plugin expects.
- [`collections/cfMappings.ts`](./src/collections/cfMappings.ts) — the hidden mapping collection.
- [`types.ts`](./src/types.ts) — `getVectorizeBinding(payload)` helper and the `CloudflareVectorizeBinding` interface (a structural subset of `VectorizeIndex`).

**Vector ID format:** `${poolName}:${sourceCollection}:${docId}:${chunkIndex}` — assigned in [`embed.ts`](./src/embed.ts). It's intentionally readable so you can inspect Vectorize directly with `wrangler vectorize get-vectors`.

**Reserved metadata keys** (set by [`embed.ts`](./src/embed.ts), reconstructed by [`search.ts`](./src/search.ts)): `sourceCollection`, `docId`, `chunkIndex`, `chunkText`, `embeddingVersion`. Anything else in `extensionFields` is round-tripped untouched.

**Filter splitting:** the operator → native-Vectorize-operator map lives in [`search.ts`](./src/search.ts) (`NATIVE_OPERATOR_MAP`). Adding support for a new native operator means adding an entry there and removing the post-filter fallback in `matchesPostFilter`. Top-level `or` always falls into the post-filter branch; that's a Vectorize limitation, not an oversight.

**Deletion path:** Vectorize doesn't support delete-by-metadata, so `deleteChunks` paginates `vector-cf-mappings` for the matching `(poolName, sourceCollection, docId)`, calls `deleteByIds`, then deletes the mapping rows.

## Contributing

Issues and PRs are welcome. The repo lives at [github.com/techiejd/payloadcms-vectorize](https://github.com/techiejd/payloadcms-vectorize) — please open an issue before sending a non-trivial PR so we can align on the approach.

For local development, see the root [README](../../README.md) and [docs/](../../docs/).

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for release notes. Releases are managed by [Changesets](https://github.com/changesets/changesets) — when contributing, run `pnpm changeset` to describe your change.

## License

[MIT](../../LICENSE)
