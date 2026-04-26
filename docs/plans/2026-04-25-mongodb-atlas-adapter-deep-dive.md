# Deep dive: MongoDB Atlas vector search adapter

> Companion to [2026-04-25-mongodb-adapter-deep-dive.md](2026-04-25-mongodb-adapter-deep-dive.md), which covers self-hosted Community Edition.

## TL;DR

**The adapter code for Atlas is essentially the same as for self-hosted Community.** Both expose the identical `$vectorSearch` aggregation stage, the identical `createSearchIndexes` API, and the identical `filter` semantics. The interesting question is no longer *"how do I write an Atlas adapter?"* — it's *"do I write one adapter or two?"*

**My recommendation: ship one adapter (`@payloadcms-vectorize/mongodb`), with Atlas as the default/production target and self-hosted Community as the experimental/dev target.** Atlas is GA, runs on every tier including the free M0, and is what 90%+ of MongoDB-on-Payload users are already using.

> **Decision (2026-04-25):** Development will use the **direct Docker** path (`mongodb/mongodb-atlas-local` image) as the primary dev/CI target. No Atlas account, no Atlas CLI, no login required. See [section 8](#8-development-environment-local-atlas-deployment-) for the full setup.

**Effort estimate vs the Community adapter:**
- If you do **both** as one adapter: **+1–2 days** on top of the Community estimate (1.5–2.5 wks). Mostly: connection-string handling, the `filter`-field-must-be-indexed gotcha, and Search Nodes documentation.
- If you do **Atlas only** and skip Community: **~1–1.5 weeks**. You get to skip the docker-compose / mongot / replica-set onboarding burden entirely.

The friction is **lower than Community in every dimension**: GA instead of preview, no sidecar binary, free tier exists, no replica-set ceremony for the user.

---

## 1. The adapter contract change is zero

Everything in [section 1 of the Community deep-dive](2026-04-25-mongodb-adapter-deep-dive.md) applies unchanged. The `DbAdapter` interface in [src/types.ts:384-418](../../src/types.ts#L384-L418) doesn't care whether you point it at Atlas or self-hosted — both speak MongoDB wire protocol, both accept the same aggregation pipeline.

---

## 2. The query shape is identical, with a few extra knobs

The `$vectorSearch` aggregation stage is the same one. Atlas exposes a couple of additional production-relevant knobs not emphasized in the Community write-up:

```js
db.chunks.aggregate([
  {
    $vectorSearch: {
      index: "vector_index",
      path: "embedding",
      queryVector: [/* …dims floats… */],
      numCandidates: 100,        // tune ~20× limit
      limit: 10,
      exact: false,              // ← Atlas: ENN if true, ANN (HNSW) if false/omitted
      filter: {
        sourceCollection: "articles",   // shorthand $eq
        status: { $in: ["published", "featured"] }
      }
    }
  },
  { $project: { score: { $meta: "vectorSearchScore" }, chunkText: 1 } }
])
```

New for Atlas:
- **`exact: true`** — opt-in exact nearest-neighbor (full scan) for small datasets or safety-critical paths. Useful as a `forceExact?: boolean` knob in the adapter config.
- **HNSW under the hood** — Atlas docs explicitly say ANN uses Hierarchical Navigable Small Worlds. Not adapter-relevant; just informational.

---

## 3. Filter operators — officially enumerated

> **Verified against [`payloadcms/payload/packages/db-mongodb/src/queries/`](https://github.com/payloadcms/payload/tree/main/packages/db-mongodb/src/queries)** — `operatorMap.ts`, `sanitizeQueryValue.ts`, `parseParams.ts`. Goal: byte-for-byte filter parity with Payload's own CRUD queries against the same data.

Atlas docs give the **exhaustive supported list** for the `filter` clause:

**Supported in `$vectorSearch.filter`:** `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$exists`, `$and`, `$or`, `$not`, `$nor`

**NOT supported:** `$regex`, `$all`, `$elemMatch`, geo operators, any aggregation operator, any `$search` operator

Mapped against Payload's `Where` (per Payload's own `db-mongodb` adapter):

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
| `and` / `or` (case-insensitive keys) | `$and` / `$or` | ✅ | pre-filter, recurse |
| **`like`** | `$regex` + `$options:'i'` + `escapeRegExp` | ❌ | **post-filter** |
| **`contains`** (scalar) | `$regex` + `$options:'i'` + `escapeRegExp` | ❌ | **post-filter** |
| **`contains`** (hasMany) | `$elemMatch` + `$regex` | ❌ | **post-filter** |
| **`all`** | `$all` | ❌ | **post-filter** |
| `near` / `within` / `intersects` | `$near` / `$geoWithin` / `$geoIntersects` | ❌ | unsupported in vector context — surface a clear error |

So `splitWhere` is needed (same pattern as [adapters/cf/src/search.ts:91-142](../../adapters/cf/src/search.ts#L91-L142)), and its post-filter bucket is wider than originally framed: `like`, `contains`, `all`, and any geo predicate.

**Six things Payload's own adapter does that we must mirror** (otherwise vector-search filter behavior diverges from CRUD behavior on the same data):

1. **`escapeRegExp` on `like`/`contains`.** Without escaping, user input like `foo.bar` matches `foozbar`. Reuse Payload's exported `escapeRegExp`.
2. **Case-insensitive substring by default** — `$options: 'i'` on every `like`/`contains`.
3. **Case-insensitive `and`/`or` keys** — Payload `.toLowerCase()`s them.
4. **Multi-operator on same path → wrap in `$and`** to avoid object-key overwrite.
5. **`exists` is compound, not just `$exists`** — empty strings are treated as missing for most field types.
6. **ObjectId casting on `_id` and relationship IDs** — lift from `sanitizeQueryValue.ts`. Matters when filtering chunks by `docId` against a source collection that uses ObjectIds.

⚠️ **The big Atlas gotcha that doesn't exist in PG:** Filter fields must be declared in the index definition as type `"filter"`. You cannot filter on an unindexed field. So the index definition becomes:

```js
{
  fields: [
    { type: "vector", path: "embedding", numDimensions: 1536, similarity: "cosine" },
    { type: "filter", path: "sourceCollection" },
    { type: "filter", path: "docId" },
    { type: "filter", path: "embeddingVersion" },
    // …plus any extension field a user wants to filter on
  ]
}
```

This is a **real design constraint for the adapter API**: the user has to declare upfront which `extensionFields` are filterable, or the adapter has to be conservative and index everything. The PG adapter doesn't have this concern — Postgres can filter on any column. Recommend an explicit `filterableFields: string[]` in the knowledge-pool config.

---

## 4. Operational story — much friendlier than Community

| Concern | Self-hosted Community | Atlas |
|---|---|---|
| MongoDB version | Must be 8.2+ | Always current |
| Replica set | Manual `rs.initiate()` | Automatic |
| `mongot` binary | Run separately, port-wire to mongod | Atlas runs it for you |
| GA status | Public preview, "not for production" | GA, production-supported |
| Free tier | N/A (you're hosting) | M0 free cluster |
| Connection | docker-compose required for dev | Just a connection string |
| Search Nodes (workload isolation) | DIY | Available on dedicated tiers |

**Tier matrix for vector search** (per Atlas deployment-options docs):

| Tier | Vector search? | Production-ready? | mongot location |
|---|---|---|---|
| M0 (free, 512 MB) | ✅ | Test only | Same node, shared |
| Flex ($8–$30/mo, 5 GB) | ✅ | Limited | Same node, shared |
| Dedicated M10+ ($57+/mo) | ✅ | Yes | Same node by default |
| Dedicated + Search Nodes | ✅ | Yes (best) | Separate nodes; ~90% RAM for index |

For our adapter:
- **Dev/CI:** point at the M0 free tier or `atlas deployments setup --type local` (Atlas CLI's local-replica-set, runs mongot locally — no docker-compose needed). The local mode is what makes a "skip Community, Atlas-only" strategy viable for dev story too.
- **Production users:** `mongodb+srv://...` connection string, that's it.

---

## 5. One adapter or two? The strategic call

Since the wire protocol and aggregation API are identical, you have three structural options:

**Option A — One unified `@payloadcms-vectorize/mongodb` adapter.** Recommend this.
- Pros: one codebase, one test suite, one README. User picks tier; same code works.
- Cons: must document both setup paths in the README; `filterableFields` config required upfront (because of the index-fields constraint, which exists on both Atlas and Community).

**Option B — Two adapters, `@payloadcms-vectorize/mongodb-atlas` and `@payloadcms-vectorize/mongodb-community`.**
- Pros: cleaner per-target docs; can mark Community as `experimental` while Atlas is `stable`.
- Cons: 95% code duplication, double the maintenance, confusing for users.

**Option C — Atlas only, defer Community.**
- Pros: ship faster, target the production-ready path, skip the docker-compose dev story.
- Cons: leaves self-hosted Payload users with no Mongo option — but they could still use the PG adapter.

**My recommendation: Option A**, framed as "Atlas-first." The README leads with `mongodb+srv://` setup, and there's a "Self-hosted Community" subsection at the bottom for advanced users who explicitly want it. Internally the adapter doesn't even branch — it's the same code path either way.

---

## 6. Concrete proposed structure (Option A)

Same as the Community proposal, with these adjustments:

```
adapters/mongodb/
├── package.json                  # @payloadcms-vectorize/mongodb
│                                 # peer deps: payload, payloadcms-vectorize, mongodb (>=6.x)
├── src/
│   ├── index.ts                  # createMongoVectorIntegration({
│   │                             #   uri, dbName, knowledgePools,
│   │                             #   filterableFields?: Record<poolName, string[]>
│   │                             # })
│   ├── search.ts                 # search() → $vectorSearch; convertWhereToMongo();
│   │                             # splitWhere() to peel off like/contains/all/geo
│   │                             # for post-filter $match
│   ├── embed.ts                  # storeChunk / deleteChunks / hasEmbeddingVersion
│   ├── indexes.ts                # ensureSearchIndex() — declares vector field + all
│   │                             # filterableFields as `filter` type
│   └── types.ts                  # MongoConfig, similarity, numCandidates default,
│                                 #   forceExact?: boolean
└── dev/specs/
    ├── compliance.spec.ts        # port from PG, runs against local Atlas (atlas CLI)
    ├── vectorSearchWhere.spec.ts # port from PG; like/contains/all tests verify post-filter
    └── setup.ts                  # `atlas deployments setup --type local` orchestration
```

Net code delta vs the Community-only proposal:
- `+ filterableFields` config plumbing
- `+ forceExact` support in `search.ts`
- `+ splitWhere` for `like` / `contains` / `all` / geo (CF adapter has the template)
- `+ Payload-parity touches`: `escapeRegExp`, `$options:'i'`, case-insensitive `and`/`or` keys, multi-op-on-same-path → `$and`, compound `exists`, ObjectId casting on `_id`/`docId`
- README has a tier-decision table at the top

---

## 7. Recommendation & scope

**Ship it as Option A — one adapter, Atlas-first messaging.**

Three reasons this is more compelling than the Community-only path:

1. **Production-ready today.** Atlas vector search is GA, not preview. You can recommend it to real users with a straight face.
2. **Free tier exists.** M0 means you can have a "Get started in 60 seconds with Atlas" path in the README, which is huge for adoption — no docker, no replica-set CLI, just a connection string.
3. **You get Community for free.** Same code works on self-hosted 8.2+, so the moment Mongo's Community offering goes GA you've already got an adapter for it.

**Estimated breakdown** (calendar time, single dev, building both targets in one adapter):
- Adapter scaffolding + storeChunk/deleteChunks/hasEmbeddingVersion: ~1 day
- `convertWhereToMongo` + `splitWhere` for like/contains: ~1–2 days
- `search` with `$vectorSearch` + index lifecycle (incl. `filterableFields` declaration): ~2–3 days
- Atlas CLI local-deployment for CI, port test suite: ~2 days
- README with tier decision table + connection-string quickstart: ~1–2 days

**Total: ~1.5–2 weeks.** Slightly faster than Community-only because the dev/CI story is simpler (Atlas CLI vs hand-rolled docker-compose).

**Tradeoff to flag — same as Community plan:** the `filterableFields` constraint is a real API ergonomics issue. Worth a small brainstorm before committing: do we require users to declare them, auto-detect from the `Where` queries we see (lazy index updates), or just index all top-level extension fields by default? Each has trade-offs around index size, change-management, and surprise.

**Companion item to revisit:** if we go with Option A, the [Community-only deep-dive](2026-04-25-mongodb-adapter-deep-dive.md) is partially superseded — it should get a banner pointing at this doc as the canonical plan.

---

## 8. Development environment: local Atlas deployment via Docker 🟢

**Decision: this project uses the direct Docker path** (`mongodb/mongodb-atlas-local` image) for both local dev and CI. Fully free, fully offline-capable after the image pull, and runs the same `mongot` binary that production Atlas uses — so behavior parity is high.

### Why Docker, not the Atlas CLI

The Atlas CLI offers a `atlas local` command that wraps the same container, but it requires a free MongoDB Atlas account and `atlas auth login` before you can use it. We're skipping the CLI for three reasons:

1. **Zero-prereq contributors.** Anyone with Docker can clone, run tests, and submit a PR — no account creation, no browser-based OAuth dance.
2. **CI without secrets.** No `ATLAS_*` credentials in GitHub Actions, no service account to manage.
3. **One path, one set of docs.** Local dev and CI use literally the same `docker run` command.

The CLI is strictly a convenience wrapper — the underlying behavior is identical.

### Prerequisites

- **Docker.** That's it. No Atlas account, no Atlas CLI, no login.
- Docker Desktop 4.31+ on macOS/Windows, or Docker Engine 27+ / Podman 5+ on Linux.
- Min: 2 CPU cores, 2 GB free RAM.
- First run requires internet to pull the image (~few hundred MB); offline thereafter.

> **OrbStack:** widely reported to work as a Docker Desktop drop-in but not officially supported by MongoDB. Use at your own risk.

### Setup

```sh
docker run -d \
  --name vectorize-dev \
  -p 27017:27017 \
  mongodb/mongodb-atlas-local:latest
# → connection string: mongodb://localhost:27017/?directConnection=true
```

The image self-initializes the replica set and starts `mongot` on first boot. First-run takes ~10–30s before `$vectorSearch` is queryable; the test harness should poll-and-wait rather than assume immediate readiness.

### Lifecycle

```sh
docker stop vectorize-dev          # pause
docker start vectorize-dev         # resume (state preserved)
docker rm -f vectorize-dev         # delete
```

For local dev, a `docker-compose.yml` at `adapters/mongodb/dev/` keeps the command short:

```yaml
services:
  mongodb-atlas:
    image: mongodb/mongodb-atlas-local:latest
    ports: ["27017:27017"]
    healthcheck:
      test: ["CMD", "mongosh", "--quiet", "--eval", "db.runCommand({ping:1})"]
      interval: 2s
      timeout: 5s
      retries: 30
```

Then `docker compose -f adapters/mongodb/dev/docker-compose.yml up -d`.

---

### What you get vs production Atlas

| Aspect | Local deployment | Production Atlas |
|---|---|---|
| `$vectorSearch` aggregation | ✅ identical | ✅ |
| `createSearchIndexes` driver API | ✅ identical | ✅ |
| `filter` operators supported | ✅ identical list | ✅ |
| `mongot` binary | ✅ runs locally in container | ✅ Atlas-managed |
| Replica set | ✅ single-node, automatic | ✅ |
| Search Nodes (workload isolation) | ❌ same node only | ✅ on dedicated tiers |
| Network latency | ⚡ localhost | ms to cloud region |
| Cost | $0 | tier-dependent |
| Internet required | ❌ offline-capable (after image pull) | ✅ |

The only behavioral gap that matters for our adapter: **Search Nodes vs same-node `mongot`** affects RAM available to the index, not query semantics. If our test suite passes against local, it will pass against any Atlas tier. The reverse isn't quite true (a query that performs well on Search Nodes might be too slow on a tiny local box), but that's a perf concern, not a correctness one.

---

### Wiring into the test harness

For `dev/specs/setup.ts`:

```ts
// pseudo-code outline
const IMAGE = 'mongodb/mongodb-atlas-local:latest'
const CONTAINER = 'vectorize-test'

export async function setupTestDeployment() {
  // Idempotent
  await sh`docker rm -f ${CONTAINER} || true`
  await sh`docker run -d --name ${CONTAINER} -p 27017:27017 ${IMAGE}`
  await waitForVectorSearchReady('mongodb://localhost:27017/?directConnection=true')
  return 'mongodb://localhost:27017/?directConnection=true'
}

export async function teardownTestDeployment() {
  await sh`docker rm -f ${CONTAINER}`
}
```

Vitest `globalSetup` calls `setupTestDeployment` once per run; individual specs share the deployment.

---

### CI considerations (GitHub Actions)

This works cleanly on GitHub-hosted Ubuntu runners — Docker is preinstalled. No secrets, no credentials, no Atlas account in the org.

Sketch:

```yaml
jobs:
  test-mongodb-adapter:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile

      - name: Start local Atlas deployment
        run: |
          docker run -d --name vectorize-test -p 27017:27017 \
            mongodb/mongodb-atlas-local:latest
          # wait for mongot to be ready
          for i in {1..30}; do
            docker exec vectorize-test mongosh --quiet --eval 'db.runCommand({ping:1})' && break
            sleep 2
          done

      - run: pnpm --filter @payloadcms-vectorize/mongodb test
        env:
          MONGODB_URI: mongodb://localhost:27017/?directConnection=true
```

Notes:
- First-run downloads the image (~few hundred MB). Cache via `actions/cache` keyed on the image tag if CI time becomes a concern.
- macOS / Windows runners: Docker isn't always reliable on hosted runners; stick with `ubuntu-latest`.
- No login, no `ATLAS_*` secrets needed.

---

### When to graduate to a real Atlas cluster

Only at two points in the lifecycle, and **never as a daily-driver dev environment**:

1. **Pre-1.0 smoke test:** spin up a free M0 cluster once, run the compliance suite against it via `mongodb+srv://` to confirm the connection-string code path works against real Atlas. Tear it down.
2. **Search Nodes perf validation** (optional, only if a user reports perf issues): provision a dedicated tier with Search Nodes and benchmark. This costs real money — defer until there's a concrete reason.

For day-to-day dev and CI, the local deployment is the path.

---

## Sources
- [$vectorSearch aggregation stage reference (Atlas)](https://www.mongodb.com/docs/atlas/atlas-vector-search/vector-search-stage/)
- [Run Vector Search Queries — Atlas](https://www.mongodb.com/docs/manual/reference/operator/aggregation/vectorsearch/)
- [Review Deployment Options — Atlas Vector Search](https://www.mongodb.com/docs/atlas/atlas-vector-search/deployment-options/)
- [Atlas Free Cluster Limits](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/)
- [MongoDB Pricing](https://www.mongodb.com/pricing)
- [Pre-filtering Data — MongoDB Search Lab](https://mongodb-developer.github.io/search-lab/docs/vector-search/filtering)
- [vectorSearch operator (within $search)](https://www.mongodb.com/docs/atlas/atlas-search/operators-collectors/vectorsearch/)
- [Create a Local Atlas Deployment with Docker](https://www.mongodb.com/docs/atlas/cli/current/atlas-cli-deploy-docker/)
- [`mongodb/mongodb-atlas-local` Docker image](https://hub.docker.com/r/mongodb/mongodb-atlas-local)
