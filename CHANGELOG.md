# Changelog

## 0.7.1 - 2026-03-20

### Fixed

- **CF adapter: `hasEmbeddingVersion` now filters on version**: Previously ignored the `embeddingVersion` parameter and only checked if any mapping existed, meaning model version bumps wouldn't trigger re-embedding.
- **CF adapter: `like` operator escapes regex special characters**: Characters like `.`, `+`, `(` in `like` patterns are now treated as literals, not regex wildcards.
- **PG adapter: empty WHERE object no longer throws**: Passing `{}` as a WHERE clause now correctly returns unfiltered results instead of erroring.
- **PG adapter: migration CLI tests no longer race on teardown**: Disabled unnecessary cron in migration tests that caused spurious errors when the test database was torn down.
- **Embeddings collection creation delegated to adapter**: Adapters now own collection creation, fixing an issue where the core plugin could create collections before the adapter was ready.

### Changed

- Removed `to-snake-case` dependency from root package (only needed in `@payloadcms-vectorize/pg`).

## 0.7.0 - 2026-03-06

### Breaking Changes

- **`DbAdapter` interface redesigned**: `storeEmbedding` and `deleteEmbeddings` replaced with `storeChunk`, `deleteChunks`, and `hasEmbeddingVersion`. Adapters now own all chunk storage, deletion, and version checking — the core plugin no longer calls `payload.create()` or `payload.delete()` directly for embeddings.
- **New `StoreChunkData` type**: Adapters receive a single data object containing `sourceCollection`, `docId`, `chunkIndex`, `chunkText`, `embeddingVersion`, `embedding`, and `extensionFields`.

### Improved

- **CF adapter: native Vectorize metadata filtering**: Search now uses Cloudflare Vectorize's native `filter` parameter (applied before topK) for `equals`, `not_equals`, `in`, `notIn`, `greater_than`, `greater_than_equal`, `less_than`, `less_than_equal`. Operators `like`, `contains`, `exists`, and `or` clauses are post-filtered.
- **CF adapter: deterministic vector IDs**: Vectors are now stored with deterministic IDs (`poolName:collection:docId:chunkIndex`), enabling reliable upserts and deletions.
- **CF adapter: metadata on vectors**: All chunk metadata (including extension fields) is stored directly on Vectorize vectors, enabling filtered search without a separate metadata collection.

### Migration

Custom `DbAdapter` implementations must update to the new interface:

```typescript
// Before
storeEmbedding(payload, poolName, collection, docId, embeddingId, embedding)
deleteEmbeddings(payload, poolName, collection, docId)

// After
storeChunk(payload, poolName, data: StoreChunkData)
deleteChunks(payload, poolName, sourceCollection, docId)
hasEmbeddingVersion(payload, poolName, sourceCollection, docId, embeddingVersion)
```

## 0.6.0-beta.5 - 2026-02-25

- Merges main into split_db_adapter (per-batch polling, coordinator/worker architecture, destroyPayload cleanup).

## 0.6.0-beta.4 - 2026-02-20

- Merges main with should embed changes.

## 0.6.0-beta - 2026-02-01

### Breaking Changes

- **Database Adapter Architecture**: The plugin now uses a pluggable database adapter system. You must install a database adapter package (e.g., `@payloadcms-vectorize/pg`) separately from the core plugin.
- **`createVectorizeIntegration` removed from core**: Use the adapter-specific integration factory instead (e.g., `createPostgresVectorIntegration` from `@payloadcms-vectorize/pg`).
- **`dbAdapter` option required**: The `payloadcmsVectorize()` plugin now requires a `dbAdapter` option pointing to your adapter's implementation.
- **`similarity` renamed to `score`**: The `VectorSearchResult.similarity` field has been renamed to `score` to be more generic across different distance metrics.

### Added

- **`@payloadcms-vectorize/pg` package**: PostgreSQL adapter for pgvector, extracted from the core plugin.
- **`@payloadcms-vectorize/cf` package**: Cloudflare Vectorize adapter for edge-native vector search.
- **`DbAdapter` interface**: New interface for implementing custom database adapters. See `adapters/README.md`.
- **`deleteEmbeddings` on `DbAdapter`**: Adapters can now delete vectors when a document is deleted or re-indexed. Implemented in both the `pg` and `cf` adapters.
- **Adapter documentation**: Added `adapters/README.md` explaining how to create custom adapters.

### Migration

**Before (0.5.x)**

```typescript
import { createVectorizeIntegration } from 'payloadcms-vectorize'

const { afterSchemaInitHook, payloadcmsVectorize } = createVectorizeIntegration({
  main: { dims: 1536, ivfflatLists: 100 },
})

export default buildConfig({
  db: postgresAdapter({
    afterSchemaInit: [afterSchemaInitHook],
  }),
  plugins: [
    payloadcmsVectorize({
      knowledgePools: {
        main: {
          /* ... */
        },
      },
    }),
  ],
})
```

**After (0.6.0+)**

```typescript
import { createPostgresVectorIntegration } from '@payloadcms-vectorize/pg'
import payloadcmsVectorize from 'payloadcms-vectorize'

const integration = createPostgresVectorIntegration({
  main: { dims: 1536, ivfflatLists: 100 },
})

export default buildConfig({
  db: postgresAdapter({
    afterSchemaInit: [integration.afterSchemaInitHook],
  }),
  plugins: [
    payloadcmsVectorize({
      dbAdapter: integration.adapter,
      knowledgePools: {
        main: {
          /* ... */
        },
      },
    }),
  ],
})
```

**Updating search result handling:**

```typescript
// Before
const score = result.similarity

// After
const score = result.score
```

## 0.5.5 - 2026-02-24

### Added

- **`batchLimit` option on `CollectionVectorizeOption`** – limits the number of documents fetched per bulk-embed worker job. When set, each page of results queues a continuation job for the next page, preventing serverless time-limit issues on large collections. Defaults to 1000.

### Changed

- **Coordinator / worker architecture for `prepare-bulk-embedding`** – the initial job now acts as a coordinator that fans out one worker job per collection. Each worker processes a single page of documents, making bulk embedding parallelizable and more resilient to timeouts.
- **Per-batch polling via `poll-or-complete-single-batch`** – replaced the monolithic `poll-or-complete-bulk-embedding` task. Each provider batch now has its own polling job, improving observability and reducing memory usage.
- **Memory-efficient incremental aggregation** – `finalizeRunIfComplete` now scans batch records page-by-page instead of loading all batches into memory at once.

### Removed

- `poll-or-complete-bulk-embedding` task (replaced by `poll-or-complete-single-batch`).

### Upgrade Notes

- **Ensure no bulk embedding run is in progress when upgrading.** The `poll-or-complete-bulk-embedding` task has been removed and replaced by `poll-or-complete-single-batch`. Any in-flight bulk run that still has pending `poll-or-complete-bulk-embedding` jobs will fail because the task slug no longer exists. Wait for all active runs to complete (or cancel them) before deploying this version.

## 0.5.4 - 2026-02-20

### Added

- **`shouldEmbedFn` filter**: Optional function on `CollectionVectorizeOption` that runs before a document is queued for embedding. Return `false` to skip the document entirely — no job is created and `toKnowledgePool` is never called. Works for both real-time and bulk embedding. Useful for skipping drafts, archived documents, or any custom criteria.

## 0.5.3 - 2026-01-24

### Changed

- **Automatic IVFFLAT index creation**: The IVFFLAT index is now created automatically via the `afterSchemaInitHook` using Drizzle's `extraConfig`. No need to run `vectorize:migrate` for initial setup or when changing `ivfflatLists`.
- **Simplified `vectorize:migrate` CLI**: The CLI now only handles only `dims` changes (which require truncating the embeddings table, so it truncates the embeddings table for you). Running it without dims changes shows a message letting you know nothing changed.

### Migration Notes

- **No action required for existing setups**: Your current migrations will continue to work.
- **For new setups**: Simply run `payload migrate:create` and `payload migrate`. No need to run `vectorize:migrate`.
- **When changing `ivfflatLists`**: Drizzle handles this automatically. Just create and apply a migration.
- **When changing `dims`**: You still need to run `vectorize:migrate` after creating a migration to add the TRUNCATE statement.

## 0.5.2 - 2026-01-20

### Changed

- `vectorSearch` now includes error details in the 500 response to make debugging easier.

## 0.5.1 - 2026-01-19

### Added

- **Migration-based vector setup**: Added the `payload vectorize:migrate` CLI to patch Payload-generated migrations with pgvector artifacts, including initial IVFFLAT index creation, IVFFLAT `lists` rebuilds, and destructive `dims` changes (drop index → alter vector column → truncate embeddings → recreate index).

## 0.5.0 - 2026-01-15

### New Features

- **Bulk Embedding**: That's right! You can now embed in bulk. Very usseful to save money.
- **`bulkQueueNames` option**: New plugin option to isolate bulk embedding workloads across separate queues for preparation and polling. Required when any knowledge pool uses bulk embeddings.
- **Non-blocking bulk polling**: Bulk jobs now use separate, short-lived tasks that can safely handle long-running providers (hours/days) without blocking worker processes.
- **Improved admin UX**: The "Embed all" button now exists:
  - Can be used to trigger an 'embed all' bulk embedding
  - Disables when bulk embeddings are not configured for a pool
  - Links to the latest bulk run for easy status tracking
- **Showed Voyage AI example**: Added real Voyage AI Batch API integration in helpers/embed, demonstrating production-ready bulk embedding with file uploads and async polling.

### Breaking Changes

- **`queueName` renamed to `realtimeQueueName`**: The plugin option `queueName` has been renamed to `realtimeQueueName` to clarify that it only affects realtime vectorization jobs.
- **`bulkQueueName` changed to `bulkQueueNames`**: The plugin option `bulkQueueName` has been replaced with `bulkQueueNames` object containing `prepareBulkEmbedQueueName` and `pollOrCompleteQueueName` for separate queue isolation of bulk preparation vs polling workloads.
- **`isVectorizedPayload` replaced with `getVectorizedPayload`**: The type guard `isVectorizedPayload(payload)` has been replaced with `getVectorizedPayload(payload)` which returns the vectorized payload object directly (or `null` if not available). This fixes a bug where methods are missing because onInit was not called.

### Tests & Reliability

- Added comprehensive tests for realtime vs bulk ingest behavior, and failing bulk situations
- Added tests for bulk polling error conditions (`failed`, `canceled` statuses)
- Added tests for bulk fan-in behavior (multiple documents processed in single run)
- Improved test coverage for edge cases in bulk embedding workflow

## 0.4.5 - 2025-01-09

**Note:** This version is deprecated due to a critical bug with `isVectorizedPayload`. Use `getVectorizedPayload(payload)` instead (see 0.5.0 section above). No 0.4 line fix (0.4.6) exists yet.

### Added

- **Local API**: Added `payload.search()` and `payload.queueEmbed()` methods directly on the Payload instance for programmatic vector search without HTTP requests
- `payload.search(params)` - Perform vector search programmatically with the same parameters as the HTTP endpoint
- `payload.queueEmbed(params)` - Manually queue vectorization jobs for documents (by ID or with document object)
- `isVectorizedPayload(payload)` - Type guard to check if a Payload instance has vectorize extensions

### Example

```typescript
import { isVectorizedPayload, type VectorizedPayload } from 'payloadcms-vectorize'

const payload = await getPayload({ config, cron: true })

if (isVectorizedPayload(payload)) {
  // Search programmatically
  const results = await payload.search({
    query: 'search query',
    knowledgePool: 'main',
    limit: 10,
  })

  // Queue embedding manually
  await payload.queueEmbed({
    collection: 'posts',
    docId: 'post-id',
  })
}
```

## 0.4.4 - 2025-01-08

- Fixes bug where you can't have collections that are not snake_case.
- Should work as long as you follow any convention that can be parsed by to-snake-case's toSnakeCase.

## 0.4.3 - 2025-01-02

- Added runtime validation for `toKnowledgePool` entries (requires `chunk` string).
- Documented how to requeue failed jobs by clearing `hasError` and `completedAt`.

## 0.4.2 - 2025-01-01

### Changed

- Updated peer dependency requirement to support any Payload 3.x version (`>=3.0.0 <4.0.0`), previously required `^3.37.0`
- Tested on Payload 3.69.0 (previously tested on 3.37.0)

### Important Note

- **Payload 3.54.0+**: When initializing Payload with `getPayload`, you must include `cron: true` for the job system to run:
  ```typescript
  payload = await getPayload({ config, cron: true })
  ```

## 0.4.1 - 2025-12-02

### Added

- Support for custom PostgreSQL schema names. The plugin now reads `schemaName` from the Postgres adapter configuration and correctly qualifies all raw SQL queries. Defaults to `public` when not specified.

## 0.4.0 - 2025-11-26

### Breaking

- **`extensionFields` moved from collection-level to knowledge-pool-level.** Previously, `extensionFields` was defined per collection inside `CollectionVectorizeOption`. Now it is defined once per knowledge pool in `KnowledgePoolDynamicConfig`. This eliminates potential field conflicts when multiple collections contribute to the same pool.

### Migration

**Before (≤0.3.x)**

```ts
payloadcmsVectorize({
  knowledgePools: {
    main: {
      collections: {
        posts: {
          toKnowledgePool: postsToKnowledgePool,
          extensionFields: [{ name: 'category', type: 'text' }],
        },
      },
      embedDocs,
      embedQuery,
      embeddingVersion: 'v1.0.0',
    },
  },
})
```

**After (0.4.0+)**

```ts
payloadcmsVectorize({
  knowledgePools: {
    main: {
      collections: {
        posts: {
          toKnowledgePool: postsToKnowledgePool,
        },
      },
      extensionFields: [{ name: 'category', type: 'text' }],
      embedDocs,
      embedQuery,
      embeddingVersion: 'v1.0.0',
    },
  },
})
```

## 0.3.2 - 2025-11-26

### Fixed

- Vector search endpoint now returns `extensionFields` in search results with correct types (numbers as numbers, strings as strings, etc.). Previously, extension fields were stored but not included in search results.

## 0.3.1 - 2025-11-19

### Changed

- Improved type safety: `PayloadcmsVectorizeConfig` is now generic and enforces that `knowledgePools` keys match `staticConfigs` keys exactly.

## 0.3.0 - 2025-11-19

### Added

- `extensionFields` option that lets each collection extend the embeddings table schema with arbitrary Payload fields (while protecting reserved column names).
- `toKnowledgePool` functions replace field-based chunking and provide full control over how documents are chunked—including the ability to attach extension-field values per chunk.
- Vector search endpoint now accepts optional `where` clauses (Payload syntax) and `limit`, enabling filtered queries against both default embedding columns and extension fields.
- Expanded `vectorSearch` coverage for filtering, using `where` clause now possible.

### Changed

- Embedding deletion now occurs per document/collection pair (no `fieldPath` column).
- Search results omit `fieldPath` and include any extension-field values that were stored with the embedding chunk.
- Documentation updated to describe `toKnowledgePool`, extension fields, and the enhanced search API.

## 0.2.0

### Breaking

- Introduced knowledge pools with separate static (schema) and dynamic (runtime) configurations.
- The vector search endpoint requires a `knowledgePool` parameter to disambiguate results across pools.

### Migration Notes

**Before (≤0.1.x)**

```ts
const { afterSchemaInitHook, payloadcmsVectorize } = createVectorizeIntegration({
  dims: 1536,
  ivfflatLists: 100,
})

payloadcmsVectorize({
  collections: {
    posts: {
      fields: {
        /* ... */
      },
    },
  },
  embedDocs,
  embedQuery,
  embeddingVersion: 'v1.0.0',
})
```

**After (0.2.0+)**

```ts
const { afterSchemaInitHook, payloadcmsVectorize } = createVectorizeIntegration({
  main: {
    dims: 1536,
    ivfflatLists: 100,
  },
})

payloadcmsVectorize({
  knowledgePools: {
    main: {
      collections: {
        posts: {
          fields: {
            /* ... */
          },
        },
      },
      embedDocs,
      embedQuery,
      embeddingVersion: 'v1.0.0',
    },
  },
})
```

### Benefits Introduced

- Multiple knowledge pools allow separate domains, embedding settings, and versioning per pool.
- Collections can participate in multiple pools, enabling more flexible organization of embeddings.
