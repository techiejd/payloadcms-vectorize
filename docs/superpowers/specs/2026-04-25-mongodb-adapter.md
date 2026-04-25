# Spec: `@payloadcms-vectorize/mongodb` adapter

> Single MongoDB adapter that targets both **MongoDB Atlas** (GA) and **self-hosted MongoDB Community 8.2+** (public preview) via a unified `$vectorSearch` API.
>
> **Strategy basis:** [`docs/plans/2026-04-25-mongodb-unified-adapter-strategy.md`](../../plans/2026-04-25-mongodb-unified-adapter-strategy.md). Companion deep-dives: [community](../../plans/2026-04-25-mongodb-adapter-deep-dive.md), [Atlas](../../plans/2026-04-25-mongodb-atlas-adapter-deep-dive.md).

---

## 1. Goal

Ship one published package — `@payloadcms-vectorize/mongodb` — that implements the existing `DbAdapter` contract from [`src/types.ts:384-418`](../../../src/types.ts#L384-L418) on top of MongoDB's `$vectorSearch` aggregation stage.

The package must:

1. Work against both Atlas (`mongodb+srv://...`) and self-hosted Community 8.2+ (`mongodb://...`) with **zero code branching** — connection-string is the only difference.
2. Reach **filter parity** with Payload's own `db-mongodb` adapter so a `Where` clause that works on the user's CRUD queries works identically against vector search.
3. Use the `mongodb/mongodb-atlas-local` Docker image for local dev and CI — no Atlas account, no CLI login, no secrets.
4. Pass the same compliance + WHERE-clause test suites the PG adapter passes, plus MongoDB-specific tests for the pre/post filter split.

Out of scope:
- Running `mongod` or `mongot` for users; we only document setup.
- Atlas Search Nodes provisioning; that's user-side ops.
- Bulk-embed support beyond what the existing plugin contract already handles.

---

## 2. Public API

```ts
import { createMongoVectorIntegration } from '@payloadcms-vectorize/mongodb'

const { adapter } = createMongoVectorIntegration({
  uri: process.env.MONGODB_URI!,
  dbName: 'payload_vectorize',
  pools: {
    default: {
      dimensions: 1536,
      similarity: 'cosine',           // 'cosine' | 'euclidean' | 'dotProduct'; default 'cosine'
      numCandidates: 200,             // optional; default = max(limit * 20, 100)
      filterableFields: ['status', 'category', 'publishedAt', 'tags'],
      forceExact: false,              // optional; default false (ANN). true = ENN full scan.
      collectionName: 'vectorize_default', // optional; default = `vectorize_${poolName}`
      indexName: 'vectorize_default_idx',  // optional; default = `${collectionName}_idx`
    },
  },
})
```

- `uri`: any valid MongoDB connection string. SRV (`mongodb+srv://`) for Atlas, standard (`mongodb://`) for self-hosted. Required.
- `dbName`: database that will hold the per-pool vector collections. Required. Created on first write if absent (Mongo behavior).
- `pools`: keyed by pool name (must match a `knowledgePools` key in the main plugin config).
- `dimensions`: required per pool, must match the embedding model's vector dim.
- `similarity`: maps directly to the index definition's `similarity` field. Default `'cosine'`.
- `numCandidates`: ANN candidate set size. Default formula: `Math.max(limit * 20, 100)` per call, computed at search time.
- `filterableFields`: extension fields the user wants to filter on. The adapter pre-declares these as `type: "filter"` in the search index. **Reserved fields (`sourceCollection`, `docId`, `embeddingVersion`) are always declared as filter fields automatically — users do NOT list them.** Optional; default `[]`.
- `forceExact`: opt into ENN exact search instead of HNSW ANN. Default `false`.
- `collectionName` / `indexName`: optional overrides for advanced users.

The factory returns `{ adapter }`, matching the CF adapter's shape ([adapters/cf/src/index.ts:41](../../../adapters/cf/src/index.ts#L41)). No `afterSchemaInitHook` (Mongo doesn't need schema migration).

---

## 3. Data layout

For each pool, the adapter manages **one MongoDB collection** in `dbName`. Document shape:

```ts
{
  _id: ObjectId,             // auto
  sourceCollection: string,  // reserved
  docId: string,             // reserved (always stored as string)
  chunkIndex: number,        // reserved
  chunkText: string,         // reserved
  embeddingVersion: string,  // reserved
  embedding: number[],       // the vector
  ...extensionFields,        // user-provided per pool
  createdAt: Date,           // adapter-set
  updatedAt: Date,           // adapter-set
}
```

**Search index per collection** (created via `createSearchIndex`):

```js
{
  name: indexName,
  type: 'vectorSearch',
  definition: {
    fields: [
      { type: 'vector', path: 'embedding', numDimensions, similarity },
      { type: 'filter', path: 'sourceCollection' },
      { type: 'filter', path: 'docId' },
      { type: 'filter', path: 'embeddingVersion' },
      ...filterableFields.map(p => ({ type: 'filter', path: p })),
    ],
  },
}
```

The adapter does **not** register a Payload `CollectionConfig` for vectors — those documents are managed entirely via the raw MongoDB driver, mirroring how the CF adapter delegates storage to Cloudflare Vectorize. The adapter optionally exposes the connection in `getConfigExtension().custom` so the `search()` method can recover it from a `BasePayload` instance.

---

## 4. Method semantics

### `getConfigExtension(payloadCmsConfig, knowledgePools?)`

Returns `{ custom: { _mongoConfig: { uri, dbName, pools } } }`. No collections, no bins. The `custom` payload gives `search()` access to the same config the factory was called with, via `getVectorizedPayload(payload)?.getDbAdapterCustom()._mongoConfig`.

### `storeChunk(payload, poolName, data)`

1. Resolves the pool's collection.
2. Lazily ensures the search index exists (idempotent: skips if a search index named `indexName` already exists).
3. Inserts one document with `embedding: Array.from(data.embedding)` and all reserved + extension fields.
4. No return value (Promise<void>).

### `deleteChunks(payload, poolName, sourceCollection, docId)`

`db.collection(name).deleteMany({ sourceCollection, docId: String(docId) })`. Returns `void` regardless of the deleted count (matches PG and CF behavior).

### `hasEmbeddingVersion(payload, poolName, sourceCollection, docId, embeddingVersion)`

`db.collection(name).countDocuments({ sourceCollection, docId: String(docId), embeddingVersion }, { limit: 1 }) > 0`.

### `search(payload, queryEmbedding, poolName, limit = 10, where?)`

Pipeline:

```js
[
  { $vectorSearch: {
      index, path: 'embedding',
      queryVector: queryEmbedding,
      numCandidates, limit,
      ...(forceExact ? { exact: true } : {}),
      ...(preFilter ? { filter: preFilter } : {}),
  }},
  ...(postFilter ? [{ $match: postFilter }] : []),
  { $project: {
      _id: 1, score: { $meta: 'vectorSearchScore' },
      sourceCollection: 1, docId: 1, chunkIndex: 1,
      chunkText: 1, embeddingVersion: 1,
      // every field in `pool.filterableFields` is projected by default
      // (so `where`-filterable fields are also returnable in results):
      ...projectionForFilterableFields,
  }},
]
```

Returns `VectorSearchResult[]` ordered by `vectorSearchScore` descending (Mongo's natural order from `$vectorSearch`):

```ts
{
  id: String(doc._id),
  score: doc.score,
  sourceCollection, docId, chunkIndex, chunkText, embeddingVersion,
  ...extensionFields,
}
```

When the post-filter is present, the limit is applied **before** the post-filter (Mongo enforces `limit` inside `$vectorSearch`). This is acceptable because: (a) it matches `$vectorSearch` semantics, and (b) the same trade-off exists in the CF adapter. Documented in the README.

---

## 5. WHERE clause translation: `convertWhereToMongo`

The function returns:

```ts
type ConvertResult = {
  preFilter: Record<string, unknown> | null
  postFilter: Where | null
}
```

### Pre-filter (allowed inside `$vectorSearch.filter`)

| Payload op | Mongo op | Notes |
|---|---|---|
| `equals` | `$eq` | |
| `not_equals` / `notEquals` | `$ne` | |
| `in` | `$in` | array required |
| `not_in` / `notIn` | `$nin` | array required |
| `greater_than` / `greaterThan` | `$gt` | |
| `greater_than_equal` / `greaterThanEqual` | `$gte` | |
| `less_than` / `lessThan` | `$lt` | |
| `less_than_equal` / `lessThanEqual` | `$lte` | |
| `exists` | compound: `$exists` + `$ne null` (+ `$ne ''` for string-typed fields) | mirrors Payload's `buildExistsQuery` |
| `and` (case-insensitive) | `$and` | recurse |
| `or` (case-insensitive) | `$or` | recurse |

Operators not listed in this table are post-filter (see next subsection). Multi-operator on the same path → wrap in `$and: [...]` so two predicates don't collide on the same key.

### Post-filter (NOT allowed in `$vectorSearch.filter`)

| Payload op | Strategy |
|---|---|
| `like` | `$match` with `$regex: escapeRegExp(value), $options: 'i'` |
| `contains` (scalar) | `$match` with `$regex: escapeRegExp(value), $options: 'i'` |
| `contains` (array hasMany) | `$match` with `$elemMatch: { $regex, $options: 'i' }` |
| `all` | `$match` with `$all` |
| `near` / `within` / `intersects` | **not supported** — throw a clear error |

### `escapeRegExp`

Inlined in the adapter (Payload doesn't export it):

```ts
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
```

### Splitting rule

Walk the `Where` tree:
- A leaf condition with only pre-filter operators → goes to `preFilter`.
- A leaf condition with any post-filter operator → the whole leaf goes to `postFilter` (so all its predicates are evaluated together against the post-vectorSearch documents).
- Nested `or`: if any branch contains a post-filter operator, the **entire `or` block** must go to post-filter. (You can't apply half of an `or` natively — semantics would be wrong.)
- Nested `and`: split per branch — pre-filter compatible branches go to `preFilter`, others to `postFilter`. The combined `preFilter` is implicitly AND-ed; the combined `postFilter` is wrapped in `{ and: [...] }`.

This matches the CF adapter's `splitWhere` ([adapters/cf/src/search.ts:91-142](../../../adapters/cf/src/search.ts#L91-L142)) extended for nested `or` correctness.

### Field mapping

- The reserved field `id` (Payload-side string) is mapped to `_id` for the Mongo filter, and the value is cast to `ObjectId` if it's a 24-hex string. All other reserved fields and extension fields use their literal name.
- Field names not present in `filterableFields` (and not reserved) get rejected at `convertWhereToMongo` time with a clear error: `Field "<name>" is not configured as filterableFields for pool "<pool>"`. This prevents Mongo's silent "no filter on unindexed field" failure mode.

---

## 6. Index lifecycle

`ensureSearchIndex(client, dbName, pool)`:

1. List existing search indexes via `db.collection(name).listSearchIndexes(indexName).toArray()`.
2. If an index named `indexName` is `READY` or `BUILDING` with the same `definition`, return.
3. If it exists with a different definition, **throw a clear error** (`"index '<name>' exists with different definition; drop it manually with db.collection.dropSearchIndex(...) before re-running"`). Auto-dropping is too risky.
4. Otherwise create with `db.collection(name).createSearchIndex({ name, type: 'vectorSearch', definition: {...} })`, then poll `listSearchIndexes` every 1s until `status === 'READY'` or 60s timeout. Timeout throws a clear error advising the user to check Mongo logs.
5. Cache "ensured" status in-memory per `(dbName, collectionName, indexName)` so subsequent `storeChunk` calls don't re-list.

The first `storeChunk` for a pool may take ~5–30s while the index builds; subsequent calls are no-ops.

---

## 7. Connection lifecycle

The adapter holds a singleton `MongoClient` per `createMongoVectorIntegration` call, lazily connected on first method invocation:

```ts
let clientPromise: Promise<MongoClient> | null = null
const getClient = () => (clientPromise ??= MongoClient.connect(uri).then(c => c))
```

- No explicit `close()` in the public API; the client lives for the process lifetime, mirroring how Payload manages its own DB connection.
- Tests are responsible for shutting down the client via an internal `__closeForTests()` helper exported from the package's `dev/` test utilities (not the public API).

---

## 8. Dev & CI environment

**Image:** `mongodb/mongodb-atlas-local:latest` (bundles `mongod` + `mongot` + replica-set init).

**Local dev:**

`adapters/mongodb/dev/docker-compose.yml`:
```yaml
services:
  mongodb-atlas:
    image: mongodb/mongodb-atlas-local:latest
    container_name: vectorize-mongodb-test
    ports: ["27018:27017"]   # 27018 to avoid collision with users' local mongod
    healthcheck:
      test: ["CMD", "mongosh", "--quiet", "--eval", "db.runCommand({ping:1})"]
      interval: 2s
      timeout: 5s
      retries: 30
```

**Connection string:** `mongodb://localhost:27018/?directConnection=true`.

**Test setup helper** waits for `$vectorSearch` readiness by attempting a no-op vector search against a temp collection (with retry/backoff up to ~30s).

**CI:** new `test_adapters_mongodb` job in `.github/workflows/ci.yml` runs the container as a service via `docker run` + healthcheck loop (GitHub-hosted ubuntu has Docker preinstalled). No secrets, no Atlas account.

---

## 9. Test plan

Three suites under `adapters/mongodb/dev/specs/`:

### `compliance.spec.ts` (port from PG)

Same shape as [adapters/pg/dev/specs/compliance.spec.ts](../../../adapters/pg/dev/specs/compliance.spec.ts):
- `getConfigExtension()` returns valid extension with `custom._mongoConfig`.
- `storeChunk()` accepts `number[]` and `Float32Array` embeddings.
- `search()` returns array, results have all required fields with correct types, ordered by score desc, respects `limit`.
- `deleteChunks()` removes chunks for a doc; idempotent on missing.
- `hasEmbeddingVersion()` true/false.

### `vectorSearchWhere.spec.ts` (port from PG, +adapt)

Port the 38-test PG suite verbatim (assertions are on result IDs/ordering/values, not SQL/Mongo strings). The PG fixtures filter on `status`, `category`, `views`, `rating`, `published`, and `tags` — these MUST all be declared in the Mongo test pool's `filterableFields` so the search index includes them. Plus:

- **Pre/post split coverage** (Mongo-specific):
  - `like` and `contains` round-trip correctly via post-filter (verifies escape + case-insensitivity).
  - `like` with regex special chars (`foo.bar`, `a*b`, `(x)`) does NOT match unintended values.
  - `or` containing one `like` branch goes entirely to post-filter — verify result correctness.
  - Mixed `and` with both pre and post operators — pre goes native, post applies to native results.
- **Configuration errors:**
  - Filtering on a field not in `filterableFields` throws a clear adapter error before hitting Mongo.
- **Reserved fields always filterable:**
  - `where: { sourceCollection: { equals: ... } }` works even if `filterableFields` is empty.

### `integration.spec.ts` (Mongo-specific)

- `ensureSearchIndex` is idempotent across multiple `storeChunk` calls.
- Conflicting index definition throws actionable error.
- `storeChunk` then immediate `search` works after index ready (waits if needed).
- Multiple pools coexist in same DB without index/collection collision.

---

## 10. Package layout

```
adapters/mongodb/
├── package.json                          # @payloadcms-vectorize/mongodb
├── tsconfig.build.json                   # extends ../tsconfig.adapter.json
├── vitest.config.ts                      # mirrors adapters/pg/vitest.config.js
├── README.md                             # see §11
├── src/
│   ├── index.ts                          # createMongoVectorIntegration + adapter wiring
│   ├── types.ts                          # MongoVectorIntegrationConfig, PoolConfig, etc.
│   ├── client.ts                         # lazy singleton MongoClient
│   ├── indexes.ts                        # ensureSearchIndex
│   ├── embed.ts                          # storeChunk
│   ├── search.ts                         # search() + post-filter $match wiring
│   ├── convertWhere.ts                   # convertWhereToMongo (pre/post split)
│   └── escapeRegExp.ts                   # tiny utility
└── dev/
    ├── docker-compose.yml
    └── specs/
        ├── constants.ts                  # shared test config
        ├── utils.ts                      # waitForVectorSearchReady, dropDb, etc.
        ├── compliance.spec.ts
        ├── vectorSearchWhere.spec.ts
        └── integration.spec.ts
```

Files mirror PG's responsibility split (`embed.ts`, `search.ts`, `types.ts`, `index.ts`) plus three new files: `client.ts`, `indexes.ts`, `convertWhere.ts`.

`package.json`'s `files` field must include only `dist/` and `README.md` (matching PG/CF) so `dev/` and `__closeForTests` test utilities are NOT in the published artifact.

---

## 11. README outline

1. **Install**: `pnpm add @payloadcms-vectorize/mongodb mongodb`
2. **Connecting to Atlas**: connection string snippet + `createMongoVectorIntegration` example.
3. **Connecting to self-hosted (Docker)**: `docker run mongodb/mongodb-atlas-local:latest` + connection string. Preview-status warning callout.
4. **Configuration**: per-pool config table (dimensions, similarity, numCandidates, filterableFields, forceExact).
5. **`filterableFields` explained**: why filtering requires pre-declaration; what happens if you omit a field.
6. **Index lifecycle**: how `ensureSearchIndex` works, what the first-write delay looks like, how to manually drop an index for redefinition.
7. **WHERE clause behavior**: which operators are pre-filtered (fast) vs post-filtered (correct but applied after vector scan); why `like`/`contains` go post-filter.
8. **Tier guidance**: M0/Flex/M10/Search Nodes for Atlas; preview status for Community.
9. **Limitations**: post-filter operators reduce result count below `limit` when many post-filter rejections occur; geo operators unsupported; index-definition changes require manual drop.

---

## 12. Versioning

Match existing adapter versioning: `0.x` aligned with the rest of the repo. Mark as `experimental` in keywords until MongoDB Community vector search GAs. Atlas behavior is GA-quality; the experimental label is about Mongo's labelling of self-hosted, not adapter maturity.

**Changesets registration:** Add `"@payloadcms-vectorize/mongodb"` to the `fixed` array in [`.changeset/config.json`](../../../.changeset/config.json) (line 9) so it stays version-locked with `payloadcms-vectorize`, `@payloadcms-vectorize/pg`, and `@payloadcms-vectorize/cf`. `pnpm-workspace.yaml` already includes `adapters/*` so no workspace change is needed.

---

## 13. Acceptance criteria

- `pnpm test:adapters:mongodb` runs locally against the docker-compose stack and passes all suites.
- `pnpm build:adapters:mongodb` produces `adapters/mongodb/dist/` with `.js` + `.d.ts`.
- `pnpm build:types:all` typechecks across the whole repo.
- New CI job `test_adapters_mongodb` passes on a clean PR.
- README walks a fresh user from `npm install` to a working vector search in under ~10 minutes via the local Docker path.
- Any `where` clause that works in Payload's CRUD `find({ collection: 'articles', where: ... })` produces the same set of matched documents in vector search (modulo vector ordering and `limit`).
