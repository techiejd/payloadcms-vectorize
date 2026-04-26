# @payloadcms-vectorize/mongodb

[![npm version](https://img.shields.io/npm/v/@payloadcms-vectorize/mongodb.svg)](https://www.npmjs.com/package/@payloadcms-vectorize/mongodb)
[![npm downloads](https://img.shields.io/npm/dm/@payloadcms-vectorize/mongodb.svg)](https://www.npmjs.com/package/@payloadcms-vectorize/mongodb)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../LICENSE)
[![Payload CMS](https://img.shields.io/badge/Payload-3.x-000000.svg)](https://payloadcms.com)

MongoDB adapter for [`payloadcms-vectorize`](https://github.com/techiejd/payloadcms-vectorize). Stores and queries embeddings via MongoDB's `$vectorSearch` aggregation stage. Targets **MongoDB Atlas** and **self-hosted MongoDB Community 8.2+** through a single code path — connection string is the only difference.

> **Status:** `0.x` — pre-1.0. Designed for MongoDB Atlas; CI runs against [`mongodb/mongodb-atlas-local`](https://hub.docker.com/r/mongodb/mongodb-atlas-local) (the upstream `mongot` engine in the same image Atlas uses). The public API is stabilizing but may still have breaking changes between minor releases. Track the [CHANGELOG](./CHANGELOG.md) before upgrading.

## Who is this for?

Use this adapter if **all** of the following are true:

- You already use (or plan to use) MongoDB for your application data, or want vector storage to live in the same database as your Payload documents.
- You are deploying to MongoDB Atlas (M0/Flex for development, **M10+** for production), or running self-hosted **MongoDB Community 8.2+** with `mongot` enabled.
- You can live with the [Limitations](#limitations) (post-filter operators may return fewer than `limit` rows, no geo predicates, OR clauses with `like`/`contains`/`all` are evaluated in JS).

If you're on Postgres with `pgvector`, prefer [`@payloadcms-vectorize/pg`](../pg/README.md). If you're deploying to Cloudflare Workers, prefer [`@payloadcms-vectorize/cf`](../cf/README.md).

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [How it works](#how-it-works)
- [Quick Start](#quick-start)
- [API Reference](#api-reference)
  - [`createMongoVectorIntegration(options)`](#createmongovectorintegrationoptions)
  - [Pool config](#pool-config)
- [`filterableFields` explained](#filterablefields-explained)
- [Index lifecycle](#index-lifecycle)
- [WHERE clause behavior](#where-clause-behavior)
- [Tuning `numCandidates` and `forceExact`](#tuning-numcandidates-and-forceexact)
- [Multiple Knowledge Pools](#multiple-knowledge-pools)
- [Tier guidance](#tier-guidance)
- [Limitations](#limitations)
- [Contributing](#contributing)
- [Changelog](#changelog)
- [License](#license)

## Prerequisites

- MongoDB Atlas (M0/Flex for development, **M10+** for production) **or** self-hosted MongoDB Community `>=8.2` with `mongot` enabled (e.g. via the [`mongodb/mongodb-atlas-local`](https://hub.docker.com/r/mongodb/mongodb-atlas-local) Docker image).
- The `mongodb` Node.js driver, `>=6.0.0` (peer dep).
- Payload CMS `3.x` (peer-dep range: `>=3.0.0 <4.0.0`).
- `payloadcms-vectorize` matching this adapter's version (peer-dep range: `>=0.7.2`).
- Node.js `^18.20.2` or `>=20.9.0`.

## Installation

```bash
pnpm add payloadcms-vectorize @payloadcms-vectorize/mongodb mongodb
```

## How it works

The adapter is the bridge between Payload's vectorize plugin and a MongoDB collection backed by an Atlas-style search index. There are **two invariants** to know up front:

> ⚠️ **Dimension parity:** the `dimensions` value on each pool **must equal** your embedding model's output size. Changing `dimensions` after the index exists requires manually dropping the search index — the adapter refuses to silently rebuild it.

> ⚠️ **`filterableFields` must be declared up front.** MongoDB's `$vectorSearch` only accepts pre-filters on fields declared as `type: 'filter'` in the search index definition. Filtering on a field you forgot to declare throws a clear adapter error before the request hits Mongo. See [`filterableFields` explained](#filterablefields-explained).

Beyond that, three facts shape day-to-day usage:

1. **One Mongo collection per pool.** Default name `vectorize_${poolName}`; override with `collectionName`. The adapter does not multiplex pools onto a single collection.
2. **The search index is auto-ensured on first write.** [`storeChunk`](./src/embed.ts) calls [`ensureSearchIndex`](./src/indexes.ts), which creates the `vectorSearch` index if missing, polls until `READY`, and short-circuits on subsequent calls. See [Index lifecycle](#index-lifecycle).
3. **Reserved fields (`sourceCollection`, `docId`, `embeddingVersion`, `chunkIndex`, `chunkText`, `embedding`) are written and managed by the adapter.** `sourceCollection`, `docId`, and `embeddingVersion` are always declared as `type: 'filter'` in the index — you can filter on them without listing them in `filterableFields`.

## Quick Start

This Quick Start gets you a working semantic-search wiring against MongoDB. Paste each block in order.

### 1. Run MongoDB locally (or use Atlas)

For local development:

```bash
docker run -d -p 27018:27017 mongodb/mongodb-atlas-local:latest
```

Set `MONGODB_URI=mongodb://localhost:27018/?directConnection=true`.

For Atlas, set `MONGODB_URI` to your `mongodb+srv://...` connection string. Make sure your IP is in the access list and the user has `readWrite` on the database.

### 2. Configure the plugin

```typescript
import { buildConfig } from 'payload'
import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { embed, embedMany } from 'ai'
import { voyage } from 'voyage-ai-provider'
import payloadcmsVectorize from 'payloadcms-vectorize'
import { createMongoVectorIntegration } from '@payloadcms-vectorize/mongodb'

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

const { adapter } = createMongoVectorIntegration({
  uri: process.env.MONGODB_URI!,
  dbName: 'payload_vectorize',
  pools: {
    default: {
      dimensions: 1024, // matches voyage-3.5-lite
      similarity: 'cosine',
      filterableFields: ['status', 'category'],
    },
  },
})

export default buildConfig({
  db: mongooseAdapter({ url: process.env.MONGODB_URI! }),
  collections: [
    {
      slug: 'posts',
      fields: [
        { name: 'title', type: 'text' },
        { name: 'status', type: 'select', options: ['draft', 'published'] },
        { name: 'category', type: 'text' },
      ],
    },
  ],
  plugins: [
    payloadcmsVectorize({
      dbAdapter: adapter,
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
  secret: process.env.PAYLOAD_SECRET!,
})
```

### 3. Verify it works

After Payload is running, create a post and run a vector search through the plugin's REST endpoint (or `payload.find` from server code):

```bash
# Create a post (real-time ingestion path embeds + writes a chunk)
curl -X POST http://localhost:3000/api/posts \
  -H "Content-Type: application/json" \
  -d '{"title": "How to cancel a subscription", "status": "published", "category": "billing"}'

# Search by semantic similarity, scoped to published billing posts
curl -X POST http://localhost:3000/api/payloadcms-vectorize/search \
  -H "Content-Type: application/json" \
  -d '{
    "knowledgePool": "default",
    "query": "refund my account",
    "limit": 5,
    "where": {
      "and": [
        { "status": { "equals": "published" } },
        { "category": { "equals": "billing" } }
      ]
    }
  }'
```

The first write may take 5–30s while `mongot` builds the search index; subsequent calls are no-ops. If filtering returns nothing, verify the field is in `filterableFields` — see [`filterableFields` explained](#filterablefields-explained).

## API Reference

### `createMongoVectorIntegration(options)`

Creates the `DbAdapter` that the core plugin uses for vector storage.

**Parameters:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `options.uri` | `string` | Yes | Any valid MongoDB connection string (Atlas SRV or self-hosted). The URI lives in the adapter closure and is **not** written to `payload.config` — credentials never leak via `getConfigExtension`. |
| `options.dbName` | `string` | Yes | Database that holds the per-pool vector collections. |
| `options.pools` | `Record<string, MongoPoolConfig>` | Yes | Pools keyed by knowledge-pool name. Pool names must match the keys of `knowledgePools` passed to `payloadcmsVectorize(...)`. Must contain at least one pool. |

**Returns:** `{ adapter: DbAdapter }` — pass `adapter` to `payloadcmsVectorize({ dbAdapter })`.

### Pool config

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `dimensions` | `number` | Yes | — | Vector dimensions for this pool. Must match your embedding model's output. |
| `similarity` | `'cosine' \| 'euclidean' \| 'dotProduct'` | No | `'cosine'` | Similarity metric for the search index. |
| `numCandidates` | `number` | No | `limit * 10` (search-time) | ANN candidate set size for HNSW. See [Tuning `numCandidates` and `forceExact`](#tuning-numcandidates-and-forceexact). |
| `filterableFields` | `string[]` | No | `[]` | Extension fields you'll filter on in `where` clauses. Reserved fields (`sourceCollection`, `docId`, `embeddingVersion`) are always filterable. See [`filterableFields` explained](#filterablefields-explained). |
| `forceExact` | `boolean` | No | `false` | Use ENN exact full-scan instead of ANN. See [Tuning `numCandidates` and `forceExact`](#tuning-numcandidates-and-forceexact). |
| `collectionName` | `string` | No | `vectorize_<pool>` | Override Mongo collection name. |
| `indexName` | `string` | No | `<collectionName>_idx` | Override search index name. |

## `filterableFields` explained

MongoDB's `$vectorSearch` requires every field used in its native pre-filter to be declared as `type: 'filter'` in the search index definition. The adapter automatically declares the reserved fields (`sourceCollection`, `docId`, `embeddingVersion`) and any field name you list in `filterableFields`.

Filtering on a field NOT in `filterableFields` (and not reserved) throws a clear adapter-side error before the request hits Mongo, rather than silently falling back to a slow scan or returning nothing.

Reserved fields are also re-listed under [How it works](#how-it-works) — you don't need to declare them.

## Index lifecycle

`ensureSearchIndex` runs lazily on the first `storeChunk` per pool ([`indexes.ts`](./src/indexes.ts)):

1. Lists existing search indexes via `collection.listSearchIndexes(indexName)`.
2. If the named index already exists with the **same** definition (`READY` or `BUILDING`), short-circuits.
3. If it exists with a **different** definition, throws an error. **Auto-dropping is unsafe** — drop manually:
   ```js
   db.collection('vectorize_default').dropSearchIndex('vectorize_default_idx')
   ```
4. Otherwise creates the index (`createSearchIndex({ type: 'vectorSearch' })`) and polls until `status === 'READY'` (≤ 60s by default).

Concurrent `ensureSearchIndex` calls for the same `(db, collection, indexName)` share a single in-flight promise, so a thundering-herd of writes does not produce duplicate `createSearchIndex` calls.

The first write per pool may take ~5–30s while the index builds; subsequent calls are no-ops. On a cold M10 cluster the first build can occasionally exceed 60s — if you see `Search index ... did not become READY within 60s`, wait, retry, and please [open an issue](https://github.com/techiejd/payloadcms-vectorize/issues) so we can make this configurable.

## WHERE clause behavior

The adapter splits a Payload `Where` clause into two stages ([`convertWhere.ts`](./src/convertWhere.ts)):

| Operator | Stage | Notes |
| --- | --- | --- |
| `equals`, `not_equals` (`notEquals`) | Pre-filter | Native `$vectorSearch.filter`, applied **before** topK. |
| `in`, `not_in` (`notIn`) | Pre-filter | Native, applied **before** topK. |
| `greater_than` (`greaterThan`), `greater_than_equal` (`greaterThanEqual`) | Pre-filter | Native, applied **before** topK. |
| `less_than` (`lessThan`), `less_than_equal` (`lessThanEqual`) | Pre-filter | Native, applied **before** topK. |
| `exists` | Pre-filter | Maps to `$exists` + null check. |
| `and` | Pre-filter when all branches are pre; mixed pre/post otherwise | Pre-branches stay native; post-branches evaluated in JS. |
| `or` | Pre-filter when all branches are pre; **otherwise entire OR routes to post-filter** | Required to preserve disjunction semantics. |
| `like`, `contains`, `all` | Post-filter | Not expressible in `$vectorSearch.filter`; applied in JS against the post-`$vectorSearch` rows. |
| `near`, `within`, `intersects` | **Unsupported** | Throws a clear adapter error — Mongo's `$vectorSearch` does not expose geo predicates. |

`id` is automatically mapped to `_id` and 24-hex strings are cast to `ObjectId` (including inside `in`/`notIn` arrays).

> **Result-count caveat.** `$vectorSearch.limit` is applied **before** any post-filter. If many rows fail the post-filter, you may receive fewer than `limit` results. The adapter does not over-fetch — this matches the [Cloudflare Vectorize adapter's](../cf/README.md#metadata-filtering) post-filter behavior. Best practices: tighten pre-filters, increase `limit`, or split the query.

> **Mixed-OR caveat.** When any branch of an `or` clause needs a post-filter operator, the entire `or` is routed to post-filter — the pre-filter is dropped from `$vectorSearch.filter`. With a high-cardinality collection the unfiltered top-K may not contain all matching rows. If you can rewrite as `and` of disjunctions, do.

## Tuning `numCandidates` and `forceExact`

`$vectorSearch` runs HNSW ANN by default, sampling `numCandidates` vectors and returning the best `limit`.

- **`numCandidates`** — defaults to `limit * 10`. Atlas docs recommend **10×–20×** of `limit`; bump to `limit * 20` (or higher) when you need better recall, especially with restrictive pre-filters that may force the ANN walk past most candidates. Higher `numCandidates` costs latency and RU/credits.
- **`forceExact: true`** — switches to ENN exact full-scan. Use when (a) recall matters more than latency and (b) the collection is small enough that a full scan is cheap, or (c) your pre-filter is so restrictive that ANN regularly returns < `limit` results because the candidate pool doesn't intersect the filter. Not recommended for collections > ~100k vectors.

## Multiple Knowledge Pools

Each pool gets its own collection and its own search index. Configure them in the same `pools` object — no extra wiring needed:

```typescript
const { adapter } = createMongoVectorIntegration({
  uri: process.env.MONGODB_URI!,
  dbName: 'payload_vectorize',
  pools: {
    posts: {
      dimensions: 1024,
      filterableFields: ['status', 'category'],
    },
    images: {
      dimensions: 512,
      filterableFields: ['caption'],
      collectionName: 'image_vectors', // override default `vectorize_images`
    },
  },
})
```

Pool names must match the keys of `knowledgePools` you pass to `payloadcmsVectorize({...})`.

## Tier guidance

- **Atlas M0 / Flex (free):** development only. Search index runs on a single shared replica with limited memory; query latency is unpredictable under load.
- **Atlas M10+:** production. Use [Search Nodes](https://www.mongodb.com/docs/atlas/cluster-config/multi-cloud-distribution/) for dedicated `mongot` capacity if your vector workload is meaningful.
- **Self-hosted Community 8.2+:** supported. `mongot` is upstream-source-available (SSPL); verify you're on a build that includes the version you tested against.

## Limitations

Each item below links to the section that explains the mechanism, so you can decide if it's a blocker for your workload.

- **Post-filter result count** — `like`/`contains`/`all` and any mixed-pre/post `or` may return fewer than `limit` results. See [WHERE clause behavior → Result-count caveat](#where-clause-behavior).
- **Geo operators** — `near`/`within`/`intersects` throw at convert time. Mongo's `$vectorSearch` does not expose geo predicates. See [WHERE clause behavior](#where-clause-behavior).
- **Index immutability** — changing `dimensions`, `similarity`, or `filterableFields` after the index exists requires `db.collection(...).dropSearchIndex(...)` first. The adapter refuses to silently rebuild. See [Index lifecycle](#index-lifecycle).
- **No automatic retry/backoff** — transient `mongot` errors propagate to the caller. Wrap your search/store calls if your runtime needs retries.
- **CI runs against `mongodb-atlas-local`, not managed Atlas** — the same `mongot` engine, but managed-Atlas-only behavior (e.g. Search Nodes routing, very-large-collection index build times) is not exercised in CI. If you hit something Atlas-specific, please [open an issue](https://github.com/techiejd/payloadcms-vectorize/issues).

## Contributing

Issues and PRs are welcome. The repo lives at [github.com/techiejd/payloadcms-vectorize](https://github.com/techiejd/payloadcms-vectorize) — please open an issue before sending a non-trivial PR so we can align on the approach.

For local development, see the root [README](../../README.md). The adapter test suite uses the bundled [`dev/docker-compose.yml`](./dev/docker-compose.yml):

```bash
pnpm --filter @payloadcms-vectorize/mongodb test:setup     # starts mongodb-atlas-local on :27018
pnpm test:adapters:mongodb                                  # runs the spec suite
pnpm --filter @payloadcms-vectorize/mongodb test:teardown   # stops the container
```

The source layout under [`src/`](./src/) is intentionally small:

- [`index.ts`](./src/index.ts) — exports `createMongoVectorIntegration`, wires `DbAdapter` methods.
- [`client.ts`](./src/client.ts) — `MongoClient` cache keyed by URI; rejected connects evict, so a transient failure doesn't poison the cache.
- [`embed.ts`](./src/embed.ts) — `storeChunk` (insert + ensure index).
- [`search.ts`](./src/search.ts) — `searchImpl` (build pipeline, run `$vectorSearch`, apply post-filter).
- [`indexes.ts`](./src/indexes.ts) — `ensureSearchIndex` (create / poll / detect drift).
- [`convertWhere.ts`](./src/convertWhere.ts) — Payload `Where` → Mongo pre-filter + JS post-filter splitter.
- [`types.ts`](./src/types.ts) — config shapes and reserved-field constants.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for release notes. Releases are managed by [Changesets](https://github.com/changesets/changesets) — when contributing, run `pnpm changeset` to describe your change.

## License

[MIT](../../LICENSE)
