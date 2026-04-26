# Strategy: one MongoDB adapter for both Atlas and Community Edition

## TL;DR

Ship **one** package — `@payloadcms-vectorize/mongodb` — that works against both MongoDB Atlas and self-hosted MongoDB Community Edition 8.2+. There is no technical reason to fork into two adapters: the `$vectorSearch` aggregation stage, the `createSearchIndexes` driver API, the filter operator subset, and the score projection are **identical** across both. Community runs the same `mongot` engine Atlas runs (source-available under SSPL since Jan 2026).

The adapter code is single. The test suite is single. The README has two "Connecting" subsections — Atlas and self-hosted Community — and that is the *only* user-facing fork.

---

## 1. What's actually shared (the entire surface)

Everything the adapter does over the wire is identical between Atlas and Community:

| Surface | Atlas | Community 8.2+ | Adapter handles it as |
|---|---|---|---|
| Driver | `mongodb` npm pkg | `mongodb` npm pkg | Single `MongoClient` |
| Vector query | `$vectorSearch` stage | `$vectorSearch` stage | One pipeline builder |
| Index API | `db.collection.createSearchIndexes(...)` | `db.collection.createSearchIndexes(...)` | One ensure-index helper |
| Filter operators | `$eq` `$ne` `$gt` `$gte` `$lt` `$lte` `$in` `$nin` `$exists` `$and` `$or` `$not` `$nor` | Same | One `convertWhereToMongo` |
| Score field | `$meta: "vectorSearchScore"` | `$meta: "vectorSearchScore"` | One `$project` stage |
| Filterable fields | Must be declared in index | Must be declared in index | One `filterableFields` config |
| Sync mechanism | Change Streams (Atlas-managed) | Change Streams (mongot subscribes) | Adapter doesn't care |

The adapter never branches on "is this Atlas or Community" because nothing it does *can* differ between them.

---

## 2. What differs (and why none of it touches code)

The differences live entirely on the user's side of the connection string:

| Concern | Atlas | Community 8.2+ |
|---|---|---|
| Connection string | `mongodb+srv://user:pw@cluster.mongodb.net/...` | `mongodb://localhost:27017/?directConnection=true` |
| How `mongot` is run | Atlas provisions and manages it | User runs `mongodb/mongodb-community-search` sidecar (or `mongodb/mongodb-atlas-local` Docker image which bundles it) |
| Replica set | Always (Atlas does it) | Required, even single-node — user runs `rs.initiate()` |
| Index propagation delay | Sub-second typically | Same (`mongot` subscribes to oplog) |
| Production readiness | GA | Public preview as of Jan 2026 |
| Auth | TLS + SCRAM via SRV | Local: none. Self-hosted prod: SCRAM/x509 |

The adapter takes a `uri` and `dbName` and trusts the user to point them somewhere reachable. **All operational concerns are documented, not coded.**

---

## 3. Where-clause translation: verified against Payload's `db-mongodb` adapter

Cross-checked against [`payloadcms/payload/packages/db-mongodb/src/queries/`](https://github.com/payloadcms/payload/tree/main/packages/db-mongodb/src/queries) — specifically `operatorMap.ts`, `sanitizeQueryValue.ts`, `parseParams.ts`, `buildAndOrConditions.ts`. Payload's own adapter is the source of truth for what their `Where` shape means; the goal is to mirror their semantics so users get identical filter behavior between their CRUD queries and our vector search.

### Operator coverage

`$vectorSearch.filter` only accepts a strict subset of MQL ([Mongo docs](https://www.mongodb.com/docs/atlas/atlas-vector-search/vector-search-stage/)). Anything outside that subset must be split off and applied **after** the vector scan as an additional `$match` stage — the same `splitWhere` pattern the CF adapter uses.

| Payload `Where` op | Payload mapping (from `db-mongodb`) | Allowed in `$vectorSearch.filter`? | Adapter strategy |
|---|---|---|---|
| `equals` | `$eq` | ✅ | pre-filter |
| `not_equals` | `$ne` | ✅ | pre-filter |
| `in` | `$in` | ✅ | pre-filter |
| `not_in` | `$nin` | ✅ | pre-filter |
| `greater_than` | `$gt` | ✅ | pre-filter |
| `greater_than_equal` | `$gte` | ✅ | pre-filter |
| `less_than` | `$lt` | ✅ | pre-filter |
| `less_than_equal` | `$lte` | ✅ | pre-filter |
| `exists` | `$and`/`$or` of `$exists`/`$ne null`/`$ne ''` (see `buildExistsQuery`) | ✅ (composed of allowed ops) | pre-filter |
| `like` | `$regex` + `$options: 'i'` + `escapeRegExp` | ❌ | **post-filter** |
| `contains` (scalar) | `$regex` + `$options: 'i'` + `escapeRegExp` | ❌ | **post-filter** |
| `contains` (hasMany array) | `$elemMatch` + `$regex` | ❌ | **post-filter** |
| `all` | `$all` | ❌ | **post-filter** |
| `near` / `within` / `intersects` | `$near` / `$geoWithin` / `$geoIntersects` | ❌ | unsupported in vector context — surface a clear error if the user tries it |
| `and` / `or` (case-insensitive) | `$and` / `$or` | ✅ | pre-filter, recurse |
| `not` / `nor` | (Mongo native, not in Payload's `operatorMap` but valid in `filter`) | ✅ | available if we ever surface them |

### Six things Payload does that we must mirror

1. **`escapeRegExp` on `like` / `contains`.** Payload imports `escapeRegExp` from the `payload` package and applies it before wrapping in `$regex`. Without it, user input like `foo.bar` matches `foozbar`. Reuse `payload`'s exported helper — don't roll our own.
2. **Case-insensitive substring by default.** Payload always sets `$options: 'i'` for `like`/`contains`. Match this so vector-search filtering behaves like CRUD filtering.
3. **Case-insensitive `and` / `or` keys.** `parseParams.ts` does `relationOrPath.toLowerCase() === 'and'`. Accept `and`/`AND`/`And` (and same for `or`).
4. **Multiple operators on the same path → wrap in `$and`.** When a single field has e.g. `{ greater_than: 5, less_than: 10 }`, Mongo's plain object form `{ field: { $gt: 5, $lt: 10 } }` works fine, **but** if Payload-style input collides (e.g. two predicates that would both write to the same path key), Payload promotes them into a `$and: [...]` to avoid object-key overwrite. Mirror this — it shows up when the same field appears under both an explicit predicate and inside a nested `and`.
5. **`exists` is a compound expression, not just `$exists`.** Payload's `buildExistsQuery` checks `$exists: true`, `$ne: null`, and (for most field types) `$ne: ''`. Empty strings are treated as missing. If we want behavior parity, we mirror that compound shape — all components are individually allowed in `filter`, so it stays pre-filterable.
6. **ObjectId casting on `_id` and relationship IDs.** Payload casts string IDs to `Types.ObjectId` for queries. Our chunks store `docId` as the raw string we received from Payload. If a user filters `where: { docId: { equals: '<24-hex>' } }` and the source collection uses ObjectId IDs, we need to cast the comparison value. Lift the casting logic from Payload's `sanitizeQueryValue.ts` (or call it directly if we depend on `payload` as a peer dep — which we already do).

### What we got wrong in the earlier deep-dives

Two corrections vs the original [community](./2026-04-25-mongodb-adapter-deep-dive.md) and [Atlas](./2026-04-25-mongodb-atlas-adapter-deep-dive.md) deep-dives:

- The original tables omitted Payload's **`all`** operator. It maps to `$all`, which is **not** in the `$vectorSearch.filter` allowlist → must be post-filtered.
- The original tables said `like` and `contains` "need post-filtering — same split-pre/post pattern the CF adapter uses." That is correct, but understated the implementation work: Payload uses `$regex` with `$options: 'i'` **and** `escapeRegExp`. Our post-filter `$match` stage must reproduce that exactly, not just naive substring matching.

### What stays simpler than PG

Even with the post-filter list, this is *still* the easiest of the three adapters because:
- No SQL escaping (Mongo takes a JS object).
- The 38-test `vectorSearchWhere` suite was written backend-agnostic — assertions are on result IDs and ordering, not on SQL strings. It ports as-is.
- Payload's own `db-mongodb` source is permissively licensed; we can lift `convertWhereToMongo` logic almost verbatim, with attribution.

---

## 4. Public API (single, unified)

```ts
import { createMongoVectorIntegration } from '@payloadcms-vectorize/mongodb'

const { adapter } = createMongoVectorIntegration({
  uri: process.env.MONGODB_URI!,         // works for both Atlas and Community
  dbName: 'payload',
  knowledgePools: [
    {
      name: 'articles',
      sourceCollections: ['articles', 'pages'],
      embeddingModel: 'text-embedding-3-small',
      dimensions: 1536,
      similarity: 'cosine',
      // Pre-declared so the search index can filter on them at scan time.
      // Same on Atlas and Community.
      filterableFields: ['status', 'category', 'publishedAt', 'tags'],
    },
  ],
})
```

There is no `mode: 'atlas' | 'community'` flag. There is no `transport` switch. The user's `MONGODB_URI` is the *only* thing that determines which backend they're hitting, and the adapter doesn't need to know.

---

## 5. Package layout (single)

```
adapters/mongodb/
├── package.json                  # @payloadcms-vectorize/mongodb
│                                 # peer deps: payload, payloadcms-vectorize, mongodb (>=6.x)
├── src/
│   ├── index.ts                  # createMongoVectorIntegration({ uri, dbName, knowledgePools })
│   ├── search.ts                 # search() → $vectorSearch pipeline
│   ├── convertWhere.ts           # Where → Mongo filter (with split-pre/post for unsupported ops)
│   ├── embed.ts                  # storeChunk / deleteChunks / hasEmbeddingVersion
│   ├── indexes.ts                # ensureSearchIndex (createSearchIndexes if missing)
│   └── types.ts                  # MongoConfig, KnowledgePool, similarity choice, defaults
├── dev/
│   ├── docker-compose.yml        # mongodb/mongodb-atlas-local — used for BOTH local dev and CI
│   └── specs/
│       ├── compliance.spec.ts    # ported from PG
│       └── vectorSearchWhere.spec.ts  # ported from PG (38 tests)
└── README.md                     # see §5
```

Notable: there is no `adapters/mongodb-atlas/` and no `adapters/mongodb-community/`. One directory, one `package.json`, one published artifact on npm.

---

## 6. README structure

The README is single, but has two subsections under "Connecting":

```markdown
# @payloadcms-vectorize/mongodb

Vector search adapter for PayloadCMS, backed by MongoDB's `$vectorSearch`.
Works against MongoDB Atlas (GA) and self-hosted MongoDB Community 8.2+ (public preview).

## Install
npm install @payloadcms-vectorize/mongodb mongodb

## Configure
[single createMongoVectorIntegration example]

## Connecting

### → MongoDB Atlas
1. Create a cluster (M10+ recommended for production; M0/Flex fine for dev).
2. Database Access → create a user with `readWrite` on your DB.
3. Network Access → allow your IP (or 0.0.0.0/0 for dev only).
4. Copy the connection string (Drivers → Node).
5. Set `MONGODB_URI=mongodb+srv://user:pw@cluster.xxxxx.mongodb.net/payload`

### → Self-hosted MongoDB Community 8.2+
> ⚠️ Public preview as of Jan 2026 — Mongo labels this "not for production."

You need `mongod` 8.2+ running as a replica set, plus the `mongot` sidecar.
The simplest path is the all-in-one Docker image:

docker run -d --name mongo -p 27017:27017 mongodb/mongodb-atlas-local:latest

Then: `MONGODB_URI=mongodb://localhost:27017/payload?directConnection=true`

For production self-hosted, see [MongoDB's mongot deployment guide].

## Filterable fields
[explain filterableFields config — applies to both backends identically]

## Index lifecycle
[explain createSearchIndexes async behavior — same for both]
```

That's the entire fork. Two subsections under one heading.

---

## 7. Test strategy (single suite, single backend)

The test suite runs against **`mongodb/mongodb-atlas-local`** for both local dev and CI. This image bundles `mongod` + `mongot` + replica-set init in one container and is the same `mongot` build Atlas ships. Tests that pass against it pass against Atlas — that's the entire point of the image.

We do **not** maintain a parallel test job against Atlas. Reasons:
- Adapter has no Atlas-vs-Community branches to cover.
- Atlas in CI requires a paid project, IP allowlisting from GitHub runners, and per-PR cluster lifecycle. Real cost, zero adapter coverage gained.
- If Atlas ever diverges from the local image's `mongot`, that's a Mongo-side regression, not ours.

**Smoke check before each release:** one manual `npm test` run pointed at a real Atlas M0 by setting `MONGODB_URI`. Catches any drift. Documented in `RELEASING.md`, not automated.

---

## 8. Where the (small) Atlas/Community asymmetries actually live

For completeness — these are the things a contributor might *think* should be branched but don't need to be:

- **Replica set init.** `mongodb/mongodb-atlas-local` does it for you. Production self-hosted docs tell users to do it. Adapter never touches it.
- **`mongot` port (27028).** Internal to the Mongo deployment. The driver only ever talks to `mongod` on 27017.
- **Index sync delay.** Same on both — the adapter's `ensureSearchIndex` polls `listSearchIndexes` until status is `READY` regardless of backend.
- **Free-tier quirks (M0/Flex).** Some Atlas free tiers cap search index count or vector dimensions. That's a user-side limit; the adapter surfaces the Mongo error verbatim.
- **`$regex` inside `filter`.** Not supported on either backend. Both use the same `splitWhere` post-filter pattern (already proven in the CF adapter).

---

## 9. Versioning and the preview disclaimer

Self-hosted Community vector search is **public preview** as of Jan 2026; Atlas vector search is **GA**. The adapter itself is GA-quality against either, but we ship `^0.x` and label it `experimental` until Mongo's Community vector search reaches GA. Bumping to `1.0` is gated on Mongo's announcement, not on adapter maturity.

The README's Community subsection carries the preview warning. The Atlas subsection does not. Same code, different runtime maturity — documented honestly.

---

## 10. Summary checklist for the contributor

To ship this:

- [ ] Scaffold `adapters/mongodb/` with the layout in §4
- [ ] Implement `createMongoVectorIntegration` with the §3 signature (no backend flag)
- [ ] Port `convertWhereToDrizzle` → `convertWhereToMongo`, mirroring Payload's `db-mongodb/queries/` (operator map, `escapeRegExp` + `$options:'i'` on `like`/`contains`, case-insensitive `and`/`or` keys, compound `exists`, ObjectId casting on `_id`/`docId`)
- [ ] Use the `splitWhere` pattern from the CF adapter to split pre-filter (allowed in `$vectorSearch.filter`) vs post-filter (`like`, `contains`, `all`, geo) predicates
- [ ] Implement `ensureSearchIndex` against `createSearchIndexes` + poll `listSearchIndexes` until `READY`
- [ ] Add `dev/docker-compose.yml` using `mongodb/mongodb-atlas-local:latest`
- [ ] Port the 38-test `vectorSearchWhere` suite from PG
- [ ] Port `compliance.spec.ts` from PG
- [ ] Write the README with the two "Connecting" subsections in §5
- [ ] Add a release-time smoke checklist for Atlas M0 in `RELEASING.md`
- [ ] Publish at `^0.x` with `experimental` tag in keywords

No fork. No `mongodb-atlas` package. No `mongodb-community` package. One adapter, two onboarding paths in the README.
