# Deep dive: MongoDB vector search adapter

## TL;DR

**Your intuition is correct, and the timing is excellent.** Self-hosted MongoDB vector search is a real, supported thing as of MongoDB Community Edition 8.2 (Sept 2025), and the engine (`mongot`) went source-available under SSPL in Jan 2026. It is exactly what you described — a separate binary that runs alongside `mongod` and stays in sync via Change Streams. The application still talks to `mongod` on the standard port and just sends a `$vectorSearch` aggregation stage; mongod proxies it to mongot transparently.

**Effort estimate: ~1.5–2.5 weeks** to ship a quality adapter on par with the PG one (functionally), assuming you adopt the official `mongot` path rather than rolling brute-force.

The friction is **not** in the adapter code — it's small and clean. The friction is in the **operational story you're asking users to adopt** (replica set + sidecar binary + index lifecycle).

---

## 1. The adapter contract is small and Mongo-friendly

The core defines a 5-method `DbAdapter` interface in [src/types.ts:384-418](../../src/types.ts#L384-L418):

| Method | What it does | Mongo equivalent |
|---|---|---|
| `getConfigExtension` | Returns Payload collections/bins/custom data the adapter contributes | Same shape — adapter exposes its own collections to Payload |
| `storeChunk` | Insert a chunk row with text, metadata, and the vector | `db.collection.insertOne({ ...meta, embedding })` |
| `deleteChunks` | Delete all chunks for a `(sourceCollection, docId)` | `db.collection.deleteMany({ sourceCollection, docId })` |
| `hasEmbeddingVersion` | Check if a doc already has chunks at a given embedding version | `db.collection.findOne({ docId, embeddingVersion })` |
| `search` | Vector search with optional `Where` filter | `$vectorSearch` aggregation pipeline |

Input/output types ([src/types.ts:298-308](../../src/types.ts#L298-L308), [src/types.ts:374-382](../../src/types.ts#L374-L382)) are pure data — nothing PG-shaped leaks across the boundary. **Notably, there's no schema migration step required** in the contract. PG needs `afterSchemaInitHook` because Drizzle has to learn about the `vector(dims)` column at startup. Mongo doesn't — collections and search indexes can be created lazily on first use, so the Mongo factory can return just `{ adapter }` (matching the CF Vectorize adapter shape).

---

## 2. mongot's API surface maps cleanly to what we need

From the official aggregation reference ([$vectorSearch docs](https://www.mongodb.com/docs/manual/reference/operator/aggregation/vectorsearch/)) and the community-edition writeup, here is the actual query shape:

```js
db.chunks.aggregate([
  {
    $vectorSearch: {
      index: "vector_index",
      path: "embedding",
      queryVector: [/* …dims floats… */],
      numCandidates: 100,        // ANN candidate set
      limit: 10,
      filter: {                  // ← native pre-filter
        sourceCollection: { $eq: "articles" },
        status: { $in: ["published", "featured"] }
      }
    }
  },
  { $project: { score: { $meta: "vectorSearchScore" }, chunkText: 1, /*…*/ } }
])
```

Two important properties for us:

- **Native pre-filter.** Mongo's `filter` clause runs *before* the ANN scan, which is the correct ordering — this is the same architectural advantage the CF Vectorize adapter exploits, where it has to split a Payload `Where` into native-supported predicates vs post-filter predicates.
- **Score in `$meta`.** No `1 - cosineDistance` math needed; Mongo gives you a normalized similarity score directly.

Index definition (created via `createSearchIndexes`):
```js
{
  fields: [{ type: "vector", path: "embedding", numDimensions: 1536, similarity: "cosine" }]
}
```

---

## 3. Translating Payload's `Where` to Mongo

> **Verified against [`payloadcms/payload/packages/db-mongodb/src/queries/`](https://github.com/payloadcms/payload/tree/main/packages/db-mongodb/src/queries)** — `operatorMap.ts`, `sanitizeQueryValue.ts`, `parseParams.ts`, `buildAndOrConditions.ts`. Payload's own Mongo adapter is the source of truth for these semantics; the goal is byte-for-byte filter parity with users' CRUD queries.
>
> Authoritative allowlist for `$vectorSearch.filter`: `$eq $ne $gt $gte $lt $lte $in $nin $exists $not $nor $and $or` ([Mongo docs](https://www.mongodb.com/docs/atlas/atlas-vector-search/vector-search-stage/)). Anything else must be **post-filtered** as a `$match` stage after the vector scan — the `splitWhere` pattern from [adapters/cf/src/search.ts:91-142](../../adapters/cf/src/search.ts#L91-L142).

This is the same problem solved in [adapters/pg/src/search.ts:146-282](../../adapters/pg/src/search.ts#L146-L282) (`convertWhereToDrizzle`) and tested heavily in your own [vectorSearchWhere.spec.ts](../../adapters/pg/dev/specs/vectorSearchWhere.spec.ts) suite.

| Payload operator | Payload's `db-mongodb` mapping | In `$vectorSearch.filter`? | Adapter strategy |
|---|---|---|---|
| `equals` | `$eq` | ✅ | pre-filter |
| `not_equals` | `$ne` | ✅ | pre-filter |
| `in` | `$in` | ✅ | pre-filter |
| `not_in` | `$nin` | ✅ | pre-filter |
| `greater_than` | `$gt` | ✅ | pre-filter |
| `greater_than_equal` | `$gte` | ✅ | pre-filter |
| `less_than` | `$lt` | ✅ | pre-filter |
| `less_than_equal` | `$lte` | ✅ | pre-filter |
| `exists` | `$and`/`$or` of `$exists` + `$ne null` + `$ne ''` (see `buildExistsQuery`) | ✅ (composed of allowed ops) | pre-filter |
| `like` | `$regex` + `$options:'i'` + `escapeRegExp` | ❌ | **post-filter** |
| `contains` (scalar) | `$regex` + `$options:'i'` + `escapeRegExp` | ❌ | **post-filter** |
| `contains` (hasMany) | `$elemMatch` + `$regex` | ❌ | **post-filter** |
| `all` | `$all` | ❌ | **post-filter** |
| `near` / `within` / `intersects` | `$near` / `$geoWithin` / `$geoIntersects` | ❌ | unsupported in vector context — surface a clear error |
| `and` / `or` (case-insensitive keys) | `$and` / `$or` | ✅ | pre-filter, recurse |

**Six things Payload does that we must mirror** (otherwise filter behavior diverges from CRUD):

1. **`escapeRegExp` on `like`/`contains`.** Without escaping, user input like `foo.bar` matches `foozbar`. Reuse Payload's exported `escapeRegExp`.
2. **Case-insensitive substring by default** — `$options: 'i'` on every `like`/`contains`.
3. **Case-insensitive `and`/`or` keys** — Payload `.toLowerCase()`s them; accept `and`/`AND`/`And`.
4. **Multi-operator on same path → wrap in `$and`** to avoid object-key overwrite (see `parseParams.ts`).
5. **`exists` is compound, not just `$exists`** — empty strings are treated as missing for most field types.
6. **ObjectId casting on `_id` and relationship IDs** — lift from `sanitizeQueryValue.ts`. Matters when filtering chunks by `docId` against a source collection that uses ObjectIds.

**Your existing 38-test suite for `vectorSearchWhere` can be reused almost verbatim** — assertions are on result IDs and ordering, not SQL strings, so it ports as-is.

---

## 4. Operational story — the real cost

This is what your users will actually feel. Vector search in self-hosted Mongo is **not** "just install MongoDB":

| Requirement | Notes |
|---|---|
| MongoDB Community Edition **8.2+** | Released Sept 2025; many users are on 6.x/7.x |
| **Replica set required** (even single-node) | Atlas hides this; self-hosted users have to `rs.initiate()` |
| `mongot` binary running alongside `mongod` | Separate package: `mongodb/mongodb-community-search` |
| Connectivity between mongod ↔ mongot | mongot port 27028, mongod must be configured to know about it |
| Search indexes created via `createSearchIndexes` | Async — index becomes queryable after a sync delay |
| Public preview status | Mongo flags this as "development and evaluation only, not production" as of Jan 2026 |

This is the "wrapping two services together" piece you flagged. The adapter code itself doesn't wrap them — `mongod` does. But your **adapter README and onboarding docs** will need to walk users through a docker-compose setup like:

```yaml
services:
  mongod: { image: mongodb/mongodb-community-server:8.2.0-ubi9, ... }
  mongot: { image: mongodb/mongodb-community-search:0.53.1, ports: ["27028:27028"] }
```

…plus replica set init. The dev-environment story for your own [/dev](../../dev/) test app needs the same setup, and your [compliance.spec.ts](../../adapters/pg/dev/specs/compliance.spec.ts) port will need a `beforeAll` that brings both up.

---

## 5. Concrete proposed structure

Mirroring [adapters/pg/](../../adapters/pg/):

```
adapters/mongodb/
├── package.json                  # @payloadcms-vectorize/mongodb
│                                 # peer deps: payload, payloadcms-vectorize, mongodb (>=6.x driver)
├── src/
│   ├── index.ts                  # createMongoVectorIntegration({ uri, dbName, knowledgePools })
│   │                             # returns { adapter }; lazily creates collection + search index per pool
│   ├── search.ts                 # search() → $vectorSearch pipeline; convertWhereToMongo()
│   ├── embed.ts                  # storeChunk() → insertOne; deleteChunks() → deleteMany
│   ├── indexes.ts                # ensureSearchIndex() — createSearchIndexes if missing
│   └── types.ts                  # MongoConfig, similarity choice, numCandidates default
└── dev/specs/
    ├── compliance.spec.ts        # port from PG
    ├── vectorSearchWhere.spec.ts # port from PG (38 tests, mostly identical assertions)
    └── docker-compose.test.yml   # mongod + mongot for CI
```

Notable simplifications vs PG:
- No `bin-vectorize-migrate.ts` — Mongo doesn't have a schema migration concept here
- No `drizzle.ts` registry — no ORM to plug into
- No `afterSchemaInitHook` — adapter returns just `{ adapter }`
- Index dimension changes: handled by dropping/recreating the search index

---

## 6. Recommendation & scope

**Worth doing.** Three reasons:

1. **The contract fits.** Your interface was clearly designed adapter-first; Mongo doesn't require contract changes. That validates the original design and makes a third adapter low-risk.
2. **Mongo is a major Payload backend.** Payload's first-class DB adapters are PG and Mongo. Shipping only a PG vector adapter implicitly excludes half the Payload userbase from this plugin.
3. **Test reuse.** The 38-test `vectorSearchWhere` suite is the hard part of any adapter; you've already built it. Porting it is mechanical.

**Estimated breakdown** (calendar time, single dev):
- Adapter scaffolding + `storeChunk`/`deleteChunks`/`hasEmbeddingVersion`: ~1 day
- `convertWhereToMongo` + handling pre-filter vs post-filter split: ~1–2 days
- `search` with `$vectorSearch` + index lifecycle: ~2 days
- Docker-compose + CI for mongod+mongot, port the test suite: ~2–3 days
- README + setup walkthrough (this is genuinely the hardest user-facing piece): ~1–2 days

**Tradeoff to flag:** the public-preview status of self-hosted vector search means you'd be shipping an adapter against a feature MongoDB themselves label as "not for production." A pragmatic move would be to ship it labeled `experimental` / `^0.x` and let GA timing on Mongo's side drive the 1.0.

**One thing I'd want to know before we commit:** does PR #35 / Dejan's "issues testing on a real app" feedback include any Mongo-specific requests? If users are already asking for this, that nudges scope toward "just do it."

---

## Sources
- [MongoDB extends search and vector search to self-managed offerings (press release)](https://www.mongodb.com/press/mongodb-extends-search-and-vector-search-capabilities-to-self-managed-offerings)
- [Public preview: MongoDB Community Edition now offers native full-text and vector search](https://www.mongodb.com/products/updates/public-preview-mongodb-community-edition-now-offers-native-full-text-and-vector-search/)
- [$vectorSearch aggregation stage reference](https://www.mongodb.com/docs/manual/reference/operator/aggregation/vectorsearch/)
- [Now source available: the engine powering MongoDB Search (mongot under SSPL)](https://www.mongodb.com/company/blog/product-release-announcements/now-source-available-the-engine-powering-mongodb-search)
- [MongoDB Community Edition: Vector Search for Everyone (hands-on writeup)](https://www.ostberg.dev/work/2025/10/12/mongodb-community-vector-search.html)
- [Supercharge self-managed apps with search and vector search capabilities](https://www.mongodb.com/company/blog/product-release-announcements/supercharge-self-managed-apps-search-vector-search-capabilities)
