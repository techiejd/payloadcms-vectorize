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
