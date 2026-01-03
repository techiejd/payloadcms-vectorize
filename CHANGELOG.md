# Changelog

All notable changes to this project will be documented in this file.

## 0.5.0 - 2026-01-03

### Breaking Changes

- **`queueName` renamed to `realtimeQueueName`**: The plugin option `queueName` has been renamed to `realtimeQueueName` to clarify that it only affects realtime vectorization jobs.
- **`bulkQueueName` changed to `bulkQueueNames`**: The plugin option `bulkQueueName` has been replaced with `bulkQueueNames` object containing `prepareBulkEmbedQueueName` and `pollOrCompleteQueueName` for separate queue isolation of bulk preparation vs polling workloads.

### New Features

- **`bulkQueueNames` option**: New plugin option to isolate bulk embedding workloads across separate queues for preparation and polling. Required when any knowledge pool uses bulk ingest mode (`bulkEmbeddings.ingestMode === 'bulk'`).
- **Non-blocking bulk polling**: Bulk jobs now use separate, short-lived tasks that can safely handle long-running providers (hours/days) without blocking worker processes.
- **Improved admin UX**: The "Embed all" button now:
  - Disables when bulk embeddings are not configured for a pool
  - Links to the latest bulk run for easy status tracking
- **Enhanced bulk provider support**: Added real Voyage AI Batch API integration in dev environment, demonstrating production-ready bulk embedding with file uploads and async polling.

### Tests & Reliability

- Added comprehensive tests for realtime vs bulk ingest behavior
- Added tests for bulk polling error conditions (`failed`, `canceled` statuses)
- Added tests for bulk fan-in behavior (multiple documents processed in single run)
- Improved test coverage for edge cases in bulk embedding workflow

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
