# PayloadCMS Vectorize

[![npm version](https://img.shields.io/npm/v/payloadcms-vectorize.svg)](https://www.npmjs.com/package/payloadcms-vectorize)
[![npm downloads](https://img.shields.io/npm/dm/payloadcms-vectorize.svg)](https://www.npmjs.com/package/payloadcms-vectorize)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Payload CMS](https://img.shields.io/badge/Payload-3.x-000000.svg)](https://payloadcms.com)

A Payload CMS plugin that adds vector search capabilities to your collections. Perfect for building RAG (Retrieval-Augmented Generation) applications and semantic search features.

> **Status:** `0.x` — pre-1.0. The public API is stabilizing but may still have breaking changes between minor releases. Track the [CHANGELOG](./CHANGELOG.md) before upgrading.

## Features

- 🔍 [**Semantic Search**](#4-search-your-content) — vectorize any collection for intelligent content discovery.
- 🚀 **Realtime ingestion** — documents are automatically vectorized on create/update and embeddings are deleted on document delete.
- 🧵 [**Bulk embedding**](#bulk-embeddings-api) — "Embed all" batches that backfill only documents missing the current `embeddingVersion` since the last bulk run, to save money.
- 🔌 [**Database Adapters**](#database-adapters) — pluggable architecture supporting different database backends.
- ⚡ **Background Processing** — uses Payload's job system for non-blocking vectorization.
- 🎯 [**Flexible Chunking**](#chunkers) — drive chunk creation yourself with `toKnowledgePool` functions so you can combine any fields or content types.
- 🧩 **Extensible Schema** — attach custom [`extensionFields`](#knowledge-pool-config) to the embeddings collection and persist values per chunk for querying.
- 🌐 [**REST API**](#rest-endpoints) — built-in vector-search endpoint with Payload-style [`where` filtering](#metadata-filtering-where) and configurable limits.
- 🏊 [**Multiple Knowledge Pools**](#knowledge-pool-config) — separate knowledge pools with independent configurations.

## Table of Contents

- [Database Adapters](#database-adapters)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration Options](#configuration-options)
  - [Plugin Options](#plugin-options)
  - [Knowledge Pool Config](#knowledge-pool-config)
  - [Adapter Configuration](#adapter-configuration)
  - [CollectionVectorizeOption](#collectionvectorizeoption)
- [Metadata Filtering (`where`)](#metadata-filtering-where)
- [Chunkers](#chunkers)
- [Bulk Embeddings API](#bulk-embeddings-api)
- [Validation & Retries](#validation--retries)
- [API Reference](#api-reference)
  - [REST Endpoints](#rest-endpoints)
  - [Local API](#local-api)
- [Troubleshooting](#troubleshooting)
- [Videos](#videos)
- [Architecture](#architecture)
- [Community](#community)
  - [Development](#development)
  - [Roadmap](#roadmap)
- [Changelog](#changelog)
- [License](#license)

## Database Adapters

This plugin requires a database adapter for vector storage. Available adapters:

| Adapter              | Package                    | Database                    | Documentation                     |
| -------------------- | -------------------------- | --------------------------- | --------------------------------- |
| PostgreSQL           | `@payloadcms-vectorize/pg` | PostgreSQL with pgvector    | [README](./adapters/pg/README.md) |
| Cloudflare Vectorize | `@payloadcms-vectorize/cf` | Cloudflare Vectorize index  | [README](./adapters/cf/README.md) |

See [adapters/README.md](./adapters/README.md) for information on creating custom adapters.

## Prerequisites

- **Payload CMS 3.x** — actively tested on `3.69.0`. Older 3.x releases (e.g. `3.37.0`) have worked historically but are not part of the current test matrix; newer 3.7x+ releases have not yet been validated. If you hit issues on a different 3.x version, please [open an issue](https://github.com/techiejd/payloadcms-vectorize/issues).
- A supported database with vector capabilities (see [Database Adapters](#database-adapters))
- Node.js 18+

## Installation

```bash
# Install the core plugin
pnpm add payloadcms-vectorize

# Install a database adapter (one of the following)
pnpm add @payloadcms-vectorize/pg   # PostgreSQL + pgvector
pnpm add @payloadcms-vectorize/cf   # Cloudflare Vectorize
```

## Quick Start

### 1. Set Up Your Database Adapter

First, configure your database adapter. See the adapter-specific documentation:

- **PostgreSQL**: [@payloadcms-vectorize/pg README](./adapters/pg/README.md) — pgvector setup, schema initialization, and migrations.
- **Cloudflare Vectorize**: [@payloadcms-vectorize/cf README](./adapters/cf/README.md) — index creation, bindings, and known limitations.

### 2. Configure the Plugin

The example below is **runnable as-is** — it uses Voyage AI's embedding API for `realTimeIngestionFn` / `queryFn` and a trivial `toKnowledgePool` that emits one chunk per post. Drop in your own embedding provider or chunker as needed; for richer chunking helpers, see [Chunkers](#chunkers).

```bash
pnpm add ai voyage-ai-provider
```

```typescript
import { buildConfig } from 'payload'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { createPostgresVectorIntegration } from '@payloadcms-vectorize/pg'
import payloadcmsVectorize from 'payloadcms-vectorize'
import type { ToKnowledgePoolFn } from 'payloadcms-vectorize'
import { embed, embedMany } from 'ai'
import { voyage } from 'voyage-ai-provider'

// 1) Embedding functions — Voyage AI
const embedDocs = async (texts: string[]): Promise<number[][]> => {
  const { embeddings } = await embedMany({
    model: voyage.textEmbeddingModel('voyage-3.5-lite'),
    values: texts,
    providerOptions: { voyage: { inputType: 'document' } },
  })
  return embeddings
}

const embedQuery = async (text: string): Promise<number[]> => {
  const { embedding } = await embed({
    model: voyage.textEmbeddingModel('voyage-3.5-lite'),
    value: text,
    providerOptions: { voyage: { inputType: 'query' } },
  })
  return embedding
}

// 2) Convert a document into chunks + extension-field values.
//    Each entry becomes one embedding row; the array index is the `chunkIndex`.
const postsToKnowledgePool: ToKnowledgePoolFn = async (doc) => {
  const entries: Array<{ chunk: string; category?: string; priority?: number }> = []

  if (doc.title) {
    entries.push({
      chunk: doc.title,
      category: doc.category ?? 'general',
      priority: Number(doc.priority ?? 0),
    })
  }

  if (typeof doc.body === 'string' && doc.body.length > 0) {
    entries.push({
      chunk: doc.body,
      category: doc.category ?? 'general',
      priority: Number(doc.priority ?? 0),
    })
  }

  return entries
}

// 3) Database adapter integration. Shape varies by adapter — see the adapter docs.
//    Voyage `voyage-3.5-lite` returns 1024-dim vectors.
const integration = createPostgresVectorIntegration({
  mainKnowledgePool: {
    dims: 1024,
    ivfflatLists: 100, // PG-specific index parameter
  },
})

export default buildConfig({
  // ... your existing config
  db: postgresAdapter({
    extensions: ['vector'],
    afterSchemaInit: [integration.afterSchemaInitHook],
    // ... your database config
  }),
  plugins: [
    payloadcmsVectorize({
      dbAdapter: integration.adapter,
      knowledgePools: {
        mainKnowledgePool: {
          collections: {
            posts: { toKnowledgePool: postsToKnowledgePool },
          },
          extensionFields: [
            { name: 'category', type: 'text' },
            { name: 'priority', type: 'number' },
          ],
          embeddingConfig: {
            version: 'v1.0.0',
            queryFn: embedQuery,
            realTimeIngestionFn: embedDocs,
            // bulkEmbeddingsFns: { ... } // Optional — see Bulk Embeddings API
          },
        },
      },
      // Optional plugin options:
      realtimeQueueName: 'vectorize-realtime',
      // endpointOverrides: { path: '/custom-vector-search', enabled: true },
      // disabled: false,
      // bulkQueueNames: { // Required only if `bulkEmbeddingsFns` is set
      //   prepareBulkEmbedQueueName: 'vectorize-bulk-prepare',
      //   pollOrCompleteQueueName: 'vectorize-bulk-poll',
      // },
    }),
  ],
  jobs: {
    autoRun: [
      // The realtime queue must run for create/update vectorization to fire.
      { cron: '*/5 * * * * *', limit: 10, queue: 'vectorize-realtime' },
    ],
  },
})
```

> **Want richer chunking?** See [`dev/helpers/chunkers.ts`](./dev/helpers/chunkers.ts) for a Lexical rich-text chunker and [`dev/helpers/embed.ts`](./dev/helpers/embed.ts) for the full Voyage real-time + bulk batch implementation.

> **Important — knowledge pool naming.** `knowledgePools` keys must be **different from your collection slugs**. Reusing a collection name for a knowledge pool **will cause schema conflicts**. In the example above, the pool is named `mainKnowledgePool` and Payload will create a collection named `main-knowledge-pool` for the embeddings.

> **Important — import map.** The import map tells Payload how to resolve component paths (like `'payloadcms-vectorize/client#EmbedAllButton'`) to actual React components. Without it, client components referenced in your collection configs won't render.
>
> ```bash
> pnpm run generate:importmap
> ```
>
> **When to run it:**
>
> - **Development:** Payload regenerates the import map on startup (HMR), so you usually don't need to run it manually.
> - **Production builds:** You **MUST** run `pnpm run generate:importmap` **before** `pnpm build`, otherwise custom components won't be found.
> - **If client components don't appear** (e.g., the "Embed all" button is missing): regenerate manually.

### 3. Run Migrations

Migration steps depend on your database adapter:

- **PostgreSQL**: [@payloadcms-vectorize/pg README → Migrations](./adapters/pg/README.md#migrations)
- **Cloudflare Vectorize**: index creation is a one-time setup step — see [@payloadcms-vectorize/cf README](./adapters/cf/README.md#1-create-vectorize-index).

### 4. Search Your Content

The plugin automatically creates a `/api/vector-search` endpoint:

```typescript
const response = await fetch('/api/vector-search', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: 'What is machine learning?', // Required
    knowledgePool: 'mainKnowledgePool', // Required — must match a key in your `knowledgePools`
    where: {
      category: { equals: 'guides' }, // Optional Payload-style filter
    },
    limit: 5, // Optional (defaults to 10)
  }),
})

const { results } = await response.json()
```

For the response shape, see [POST `/api/vector-search`](#post-apivector-search). For programmatic use without HTTP, see [`vectorizedPayload.search()`](#vectorizedpayloadsearchparams).

## Configuration Options

### Plugin Options

| Option              | Type                                                                   | Required | Description                                                                 |
| ------------------- | ---------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------- |
| `knowledgePools`    | `Record<KnowledgePool, KnowledgePoolDynamicConfig>`                    | ✅       | Knowledge pools and their configurations                                    |
| `realtimeQueueName` | `string`                                                               | ❌       | Custom queue name for realtime vectorization jobs                           |
| `bulkQueueNames`    | `{prepareBulkEmbedQueueName: string, pollOrCompleteQueueName: string}` | ❌       | Queue names for bulk embedding jobs (required if any pool uses bulk ingest) |
| `endpointOverrides` | `object`                                                               | ❌       | Customize the search endpoint                                               |
| `disabled`          | `boolean`                                                              | ❌       | Disable plugin, except embeddings deletions, while keeping schema           |

### Knowledge Pool Config

These options are passed to `payloadcmsVectorize` for each pool and apply regardless of which database adapter you use.

| Option            | Type                                       | Required | Description                                                                                          |
| ----------------- | ------------------------------------------ | -------- | ---------------------------------------------------------------------------------------------------- |
| `collections`     | `Record<string, CollectionVectorizeOption>` | ✅       | Collections to embed and their configs. See [CollectionVectorizeOption](#collectionvectorizeoption). |
| `embeddingConfig` | `EmbeddingConfig`                          | ✅       | Embedding model + functions. See table below.                                                        |
| `extensionFields` | `Field[]`                                  | ❌       | Extra columns added to the embeddings collection. Standard Payload field configs.                    |

`embeddingConfig` shape:

| Field                 | Type                | Required | Description                                                                |
| --------------------- | ------------------- | -------- | -------------------------------------------------------------------------- |
| `version`             | `string`            | ✅       | Version string for tracking model changes (drives bulk re-embed eligibility). |
| `queryFn`             | `EmbedQueryFn`      | ✅       | Embeds search queries.                                                     |
| `realTimeIngestionFn` | `EmbedDocsFn`       | ❌       | Embeds documents synchronously on create/update.                           |
| `bulkEmbeddingsFns`   | `BulkEmbeddingsFns` | ❌       | Streaming bulk-API callbacks. See [Bulk Embeddings API](#bulk-embeddings-api). |

**Ingestion mode is determined by which functions you provide:**

| `realTimeIngestionFn` | `bulkEmbeddingsFns` | Behavior                                                                                       |
| --------------------- | ------------------- | ---------------------------------------------------------------------------------------------- |
| ✅                    | ❌                  | Real-time only — documents are embedded on every create/update.                                |
| ❌                    | ✅                  | Bulk only — embedding happens only via manual "Embed all" runs (see [Bulk Embeddings API](#bulk-embeddings-api)). |
| ✅                    | ✅                  | Both — real-time on writes, bulk for backfills.                                                |
| ❌                    | ❌                  | Embedding disabled for this pool. Search still works against existing rows.                    |

> **Invariant — embedding deletion cannot be disabled.** When a source document is deleted, all its embeddings are removed from every knowledge pool that contains that collection, regardless of how they were created. This is by design and not configurable.

> **Reserved field names.** Avoid using these names in `extensionFields` — they're built-in columns on the embeddings collection: `sourceCollection`, `docId`, `chunkIndex`, `chunkText`, `embeddingVersion`. They are also valid filter targets in [`where`](#metadata-filtering-where) clauses.

> **`embeddingVersion` semantics.** Each row stores the `embeddingConfig.version` it was created under. Bulk runs only re-embed rows where `embeddingVersion` doesn't match the current `version` (see [Embed All (Admin UI)](#embed-all-admin-ui)). Bump `version` whenever you swap models or change `toKnowledgePool` semantics.

### Adapter Configuration

Each adapter has its own configuration shape — this is where index parameters, dimensions, bindings, and other backend-specific settings live. There is no shared schema; refer to the adapter you're using:

- **PostgreSQL** (`dims`, `ivfflatLists`, schema initialization): [@payloadcms-vectorize/pg → Static Configuration](./adapters/pg/README.md#static-configuration)
- **Cloudflare Vectorize** (`dims`, Vectorize binding): [@payloadcms-vectorize/cf → Configuration](./adapters/cf/README.md#configuration)

The embeddings collection name in Payload will be the same as the knowledge pool name.

Static configuration changes (like vector dimensions) may require migrations. See your adapter's docs for specifics:

- **PostgreSQL**: [Migrations](./adapters/pg/README.md#migrations)
- **Cloudflare Vectorize**: dimension changes require recreating the Vectorize index.

### CollectionVectorizeOption

> **See also:** [reserved field names](#knowledge-pool-config) — don't use them as keys in the entries returned by `toKnowledgePool`.

| Option            | Type                                                  | Required | Description                                                                                                                                                                  |
| ----------------- | ----------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toKnowledgePool` | `(doc, payload) => Promise<Entry[]>`                  | ✅       | Returns an array of `{ chunk, ...extensionFieldValues }`. Each entry becomes one embedding row; the array index becomes `chunkIndex`.                                        |
| `shouldEmbedFn`   | `(doc, payload) => Promise<boolean>`                  | ❌       | Runs **before** the document is queued. Return `false` to skip entirely (no job, `toKnowledgePool` never called). Applies to real-time and bulk. Defaults to embedding all. |
| `batchLimit`      | `number`                                              | ❌       | Max documents per bulk-embed worker job. Each page becomes a separate job that queues a continuation. Useful for serverless time limits. Defaults to `1000`.                |

**Example — skip draft documents:**

```typescript
collections: {
  posts: {
    shouldEmbedFn: async (doc) => doc._status === 'published',
    toKnowledgePool: postsToKnowledgePool,
  },
}
```

## Metadata Filtering (`where`)

Both the `/api/vector-search` endpoint and `vectorizedPayload.search()` accept an optional `where` clause. The clause is a Payload-style `Where` object evaluated against the embeddings collection plus any `extensionFields` you defined for the pool. It is applied **before** the vector similarity ranking, so you only pay similarity cost on the rows you care about.

### Supported operators

| Operator                                | Applies to       | Description                          |
| --------------------------------------- | ---------------- | ------------------------------------ |
| `equals`                                | any              | Exact match                          |
| `not_equals` / `notEquals`              | any              | Negated exact match                  |
| `in`                                    | any              | Value is in array                    |
| `not_in` / `notIn`                      | any              | Value is not in array                |
| `like`                                  | text             | SQL `LIKE` (use `%` wildcards)       |
| `contains`                              | text             | Substring match (wraps with `%…%`)   |
| `greater_than` / `greaterThan`          | number / date    | `>`                                  |
| `greater_than_equal` / `greaterThanEqual` | number / date  | `>=`                                 |
| `less_than` / `lessThan`                | number / date    | `<`                                  |
| `less_than_equal` / `lessThanEqual`     | number / date    | `<=`                                 |
| `exists`                                | any              | `true` → `IS NOT NULL`, `false` → `IS NULL` |

### Combining conditions

Multiple top-level fields are combined with `AND`. Use `and` / `or` arrays for explicit logic, including nested combinations:

```typescript
where: {
  or: [
    { category: { equals: 'guides' } },
    {
      and: [
        { category: { equals: 'tutorials' } },
        { priority: { gte: 3 } },
      ],
    },
  ],
}
```

### Filterable fields

You can filter on:

- Reserved fields: `sourceCollection`, `docId`, `chunkIndex`, `chunkText`, `embeddingVersion`
- Any field you declared in the pool's `extensionFields`

References to fields that don't exist on the embeddings table are silently dropped (the rest of the clause still applies).

> **Adapter parity.** All operators are implemented in `@payloadcms-vectorize/pg`. The Cloudflare Vectorize adapter has narrower native filtering — see [@payloadcms-vectorize/cf → Known Limitations](./adapters/cf/README.md#metadata-filtering) for what is and isn't supported there.

## Chunkers

Use chunker helpers (see `dev/helpers/chunkers.ts`) to keep `toKnowledgePool` implementations focused on orchestration. A `toKnowledgePool` can combine multiple chunkers, enrich each chunk with metadata, and return everything the embeddings collection needs.

```typescript
const postsToKnowledgePool: ToKnowledgePoolFn = async (doc, payload) => {
  const chunks = await chunkText(doc.title ?? '', payload)

  return chunks.map((chunk) => ({
    chunk,
    category: doc.category ?? 'general',
  }))
}
```

Because you control the output, you can mix different field types, discard empty values, or inject any metadata that aligns with your `extensionFields`.

## Bulk Embeddings API

The bulk embedding API is designed for large-scale embedding using provider batch APIs (like Voyage AI). **Bulk runs are never auto-queued** — they must be triggered manually via the admin UI or API.

### Bulk Task Model

The plugin uses separate Payload jobs for reliability with long-running providers:

- **`prepare-bulk-embedding`**: A coordinator job fans out one worker per collection. Each worker streams through documents, calls your `addChunk` for each chunk, and creates batch records. When `batchLimit` is set on a collection, workers paginate and queue continuation jobs.
- **`poll-or-complete-single-batch`**: Polls a single batch, requeues itself until done, then writes successful embeddings. When all batches for a run are terminal, the run is finalized (partial chunk failures are allowed).

### Queue Configuration

For bulk embedding, you must provide the bulk queue names and matching cron entries.

```typescript
plugins: [
  payloadcmsVectorize({
    knowledgePools: { /* ... */ },
    realtimeQueueName: 'vectorize-realtime', // optional
    bulkQueueNames: { // required only if you are using bulk embeddings
      prepareBulkEmbedQueueName: 'vectorize-bulk-prepare',
      pollOrCompleteQueueName: 'vectorize-bulk-poll',
    },
  }),
]

jobs: {
  autoRun: [ // Queue names must match the values above
    { cron: '*/5 * * * * *', limit: 10, queue: 'vectorize-realtime' },
    { cron: '0 0 * * * *', limit: 1, queue: 'vectorize-bulk-prepare' },
    { cron: '*/30 * * * * *', limit: 5, queue: 'vectorize-bulk-poll' },
  ],
}
```

### Failure Levels

The bulk embedding process has **three levels of failure**:

- **Run level**: If any chunk fails during ingestion (`toKnowledgePool`), the entire run fails and no embeddings are written. This is fully atomic. Your `onError` is expected to handle clean-up from this stage.
- **Batch level**: If any batch fails during polling, the entire run is marked as failed but embeddings from working batches are written.
- **Chunk level**: If individual chunks fail during completion (e.g., provider returns errors for specific inputs), the run still succeeds and successful embeddings are written. Failed chunks are tracked in `failedChunkData` (with structured `collection`, `documentId`, and `chunkIndex` fields) and passed to the `onError` callback for cleanup.

This design allows for partial success: if 100 chunks are processed and 2 fail, 98 embeddings are written and the 2 failures are tracked for potential retry.

**Error Recovery:** If a run fails, you can re-queue it. If you provided an `onError` callback, it will be called with all `providerBatchIds` so you can clean up provider-side resources before retrying.

### The Bulk Embedding Callbacks

In order to get bulk embeddings to interface with your provider, you must define the following three callbacks per knowledge pool (the functions do not have to be unique, so you can re-use them across knowledge pools).

```typescript
type BulkEmbeddingsFns = {
  addChunk: (args: AddChunkArgs) => Promise<BatchSubmission | null>
  pollOrCompleteBatch: (args: PollOrCompleteBatchArgs) => Promise<PollBulkEmbeddingsResult>
  onError?: (args: OnBulkErrorArgs) => Promise<void>
}
```

#### `addChunk` — Accumulate and Submit

The plugin streams chunks to your callback one at a time; the callback is called for each chunk. You manage your own accumulation and decide when to submit based on file size.

```typescript
type AddChunkArgs = {
  chunk: { id: string; text: string }
  isLastChunk: boolean
}

type BatchSubmission = {
  providerBatchId: string
}
```

**About the `chunk.id` field:**

- **Plugin-generated**: The plugin automatically generates a unique `id` for each chunk (format: `${collectionSlug}:${docId}:${chunkIndex}`). You don't need to create it.
- **Purpose**: The `id` is used to correlate embedding outputs back to their original inputs, ensuring each embedding is correctly associated with its source document and chunk.
- **Usage**: When submitting batches to your provider, you must pass this `id` along with the text (e.g., as `custom_id` in Voyage AI's batch API). This allows your provider to return the `id` with each embedding result.

**Return values:**

- `null` — "I'm accumulating this chunk, not ready to submit yet"
- `{ providerBatchId }` — "I just submitted a batch to my provider"

> **Important contract.** When you return a submission, the plugin assumes **all chunks currently in `pendingChunks` were submitted**. The plugin tracks chunks and creates batch records based on this assumption.

**About `isLastChunk`:**

- `isLastChunk=true` indicates this is the final chunk in the run.
- Use this to flush any remaining accumulated chunks before the run completes.

**Example implementation:**

```typescript
let accumulated: BulkEmbeddingInput[] = []
const LINE_LIMIT = 100_000 // e.g., Voyage AI's limit

addChunk: async ({ chunk, isLastChunk }) => {
  // Add current chunk to accumulation first
  accumulated.push(chunk)

  // Check if we've hit the line limit (after adding current chunk)
  if (accumulated.length === LINE_LIMIT) {
    const result = await submitToProvider(accumulated)
    accumulated = [] // Clear for next batch
    return { providerBatchId: result.id }
  }

  // Last chunk? Must flush everything
  if (isLastChunk && accumulated.length > 0) {
    const result = await submitToProvider(accumulated)
    accumulated = []
    return { providerBatchId: result.id }
  }

  return null
}
```

> **Note.** If a single chunk exceeds your provider's file size or line limit, you'll need to handle that edge case in your implementation (e.g., skip it, split it, or fail gracefully).

#### `pollOrCompleteBatch` — Poll and Stream Results

Called repeatedly until the batch reaches a terminal status. When the batch completes, stream the outputs via the `onChunk` callback.

```typescript
type PollOrCompleteBatchArgs = {
  providerBatchId: string // You provided this in the earlier step when you submitted a batch.
  onChunk: (chunk: BulkEmbeddingOutput) => Promise<void>
}

type PollBulkEmbeddingsResult = {
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'
  counts?: { inputs?: number; succeeded?: number; failed?: number }
  error?: string
}

type BulkEmbeddingOutput = {
  id: string // Must match the chunk.id from addChunk
  embedding?: number[]
  error?: string
}
```

**How it works:**

1. The plugin calls `pollOrCompleteBatch` repeatedly for each batch.
2. While the batch is in progress, return the status (`queued` or `running`) without calling `onChunk`.
3. When the batch completes, stream each embedding result by calling `onChunk` for each output, then return `{ status: 'succeeded' }`.
4. If the batch fails, return `{ status: 'failed', error: '...' }` without calling `onChunk`.

**About the `id` field in outputs:**

- **Correlation**: The `id` in each `BulkEmbeddingOutput` must match the `chunk.id` that was passed to `addChunk`. This is how the plugin correlates outputs back to their original inputs.
- **Extraction**: When processing your provider's response, extract the `id` that you originally sent (e.g., from Voyage's `custom_id` field) and include it in the returned `BulkEmbeddingOutput`.
- **Example**: If you sent `{ custom_id: "posts:123:0", input: [...] }` to your provider, extract `result.custom_id` from the response and call `await onChunk({ id: result.custom_id, embedding: [...] })`.

#### `onError` — Cleanup on Failure (Optional)

Called when the bulk run fails OR when there are partial chunk failures. Use this to clean up provider-side resources (delete files, cancel batches) and handle failed chunks. The run can be re-queued after cleanup.

```typescript
type FailedChunkData = {
  collection: string // Source collection slug
  documentId: string // Source document ID
  chunkIndex: number // Index of the chunk within the document
}

type OnBulkErrorArgs = {
  providerBatchIds: string[]
  error: Error
  /** Data about chunks that failed during completion */
  failedChunkData?: FailedChunkData[]
  /** Count of failed chunks */
  failedChunkCount?: number
}
```

**Error handling behavior:**

- **Batch failures**: If any batch fails during polling, the entire run fails and `onError` is called.
- **Partial chunk failures**: If individual chunks fail during completion (e.g., provider returned an error for specific inputs), the run still succeeds but `onError` is called with `failedChunkData` and `failedChunkCount`.
- **Failed chunk data**: The `failedChunkData` array contains structured information about failed chunks, including `collection`, `documentId`, and `chunkIndex`. This data is also stored in the run record (`failedChunkData` field) for later inspection and potential retry.
- **Partial success**: Successful embeddings are still written even when some chunks fail. Only the failed chunks are skipped.

### Embed All (Admin UI)

- Each knowledge pool's embeddings list shows an **Embed all** admin button that triggers a bulk run.
- Bulk runs are filtered by `embeddingVersion` (see [`embeddingVersion` semantics](#knowledge-pool-config)) — only rows that don't match the current `embeddingConfig.version` are re-embedded; if no previous run exists, all rows are included.
- Progress is recorded in the `vector-bulk-embeddings-runs` and `vector-bulk-embeddings-batches` admin UI collections.
- You can re-run failed bulk embeddings from `vector-bulk-embeddings-batches`, and link to failed batches from `vector-bulk-embeddings-runs`.
- If `bulkEmbeddingsFns` is not provided, the "Embed all" button is disabled.

> **Import map note.** In development (`pnpm dev`), Payload auto-generates the import map. For production builds (`pnpm build`), you must run `pnpm run generate:importmap` first (see [Quick Start](#2-configure-the-plugin)).

## Validation & Retries

- Each entry returned by `toKnowledgePool` must be an object with a required `chunk` string.
- If any entry is malformed, the vectorize job fails with `hasError = true` and an error message listing invalid indices.
- To retry after fixing your `toKnowledgePool` logic, clear `hasError` and `completedAt` (and set `processing` to `false` if needed) on the failed `payload-jobs` row. The queue runner will pick it up on the next interval.

## API Reference

### REST Endpoints

#### POST `/api/vector-search`

Search for similar content using vector search.

**Request Body:**

```jsonc
{
  "query": "Your search query",
  "knowledgePool": "mainKnowledgePool",
  "where": {
    "category": { "equals": "guides" },
    "priority": { "gte": 3 },
  },
  "limit": 5,
}
```

**Parameters:**

- `query` (required): Search query string
- `knowledgePool` (required): Knowledge pool identifier to search in
- `where` (optional): Payload-style `Where` clause — see [Metadata Filtering](#metadata-filtering-where)
- `limit` (optional): Maximum results to return (defaults to `10`)

**Response:**

```jsonc
{
  "results": [
    {
      "id": "embedding_id",
      "score": 0.85,
      "sourceCollection": "posts",
      "docId": "post_id",
      "chunkIndex": 0,
      "chunkText": "Relevant text chunk",
      "embeddingVersion": "v1.0.0",
      "category": "guides", // example extension field
      "priority": 4,        // example extension field
    },
  ],
}
```

#### POST `/api/vector-bulk-embed`

Starts a bulk embedding run for a knowledge pool. REST equivalent of `vectorizedPayload.bulkEmbed()`.

**Request Body:**

```json
{
  "knowledgePool": "mainKnowledgePool"
}
```

**Success Response** (`202 Accepted`):

```json
{
  "runId": "123",
  "status": "queued"
}
```

**Conflict Response** (`409 Conflict`) — when a run is already active:

```json
{
  "runId": "456",
  "status": "running",
  "message": "A bulk embedding run is already running for this knowledge pool. Wait for it to complete or cancel it first.",
  "conflict": true
}
```

**Error Responses:**

- `400 Bad Request`: Missing or invalid `knowledgePool` parameter
- `500 Internal Server Error`: Server error during processing

**Example:**

```bash
curl -X POST http://localhost:3000/api/vector-bulk-embed \
  -H "Content-Type: application/json" \
  -d '{"knowledgePool": "mainKnowledgePool"}'
```

#### POST `/api/vector-retry-failed-batch`

Retries a failed batch from a bulk embedding run. REST equivalent of `vectorizedPayload.retryFailedBatch()`.

**Request Body:**

```json
{
  "batchId": "123"
}
```

**Success Response** (`202 Accepted`):

```json
{
  "batchId": "123",
  "newBatchId": "456",
  "runId": "789",
  "status": "queued"
}
```

**Already Retried Response** (`202 Accepted`) — when batch was already retried:

```json
{
  "batchId": "123",
  "newBatchId": "456",
  "runId": "789",
  "status": "queued",
  "message": "Batch was already retried. Returning the retry batch."
}
```

**Error Responses:**

- `400 Bad Request`: Missing or invalid `batchId` parameter, or batch is not in a retriable state
- `404 Not Found`: Batch not found
- `409 Conflict`: Cannot retry while parent run is still active
- `500 Internal Server Error`: Server error during processing

**Example:**

```bash
curl -X POST http://localhost:3000/api/vector-retry-failed-batch \
  -H "Content-Type: application/json" \
  -d '{"batchId": "123"}'
```

### Local API

The plugin provides a `getVectorizedPayload(payload)` function which returns a `vectorizedPayload` object exposing `search`, `queueEmbed`, `bulkEmbed`, and `retryFailedBatch` methods.

#### Getting the Vectorized Payload Object

```typescript
import { getPayload } from 'payload'
import { getVectorizedPayload } from 'payloadcms-vectorize'
import config from './payload.config'

// `cron: true` is required so the job queues that drive vectorization actually run.
const payload = await getPayload({ config, cron: true })
const vectorizedPayload = getVectorizedPayload(payload)

if (vectorizedPayload) {
  const results = await vectorizedPayload.search({
    query: 'search query',
    knowledgePool: 'mainKnowledgePool',
  })

  await vectorizedPayload.queueEmbed({
    collection: 'posts',
    docId: 'some-id',
  })

  await vectorizedPayload.bulkEmbed({
    knowledgePool: 'mainKnowledgePool',
  })
}
```

> **`getVectorizedPayload` returns `null`** when the plugin isn't registered on this Payload instance (or `disabled: true`). The `if (vectorizedPayload)` guard exists so shared code that imports this in projects without vectorize enabled doesn't crash.

#### `vectorizedPayload.search(params)`

Perform vector search programmatically without making an HTTP request. Parameters and result shape are identical to [POST `/api/vector-search`](#post-apivector-search).

**Returns:** `Promise<Array<VectorSearchResult>>` — the array that the REST endpoint wraps in `{ results }`.

**Example:**

```typescript
const results = await vectorizedPayload.search({
  query: 'What is machine learning?',
  knowledgePool: 'mainKnowledgePool',
  where: {
    category: { equals: 'guides' },
  },
  limit: 5,
})
```

#### `vectorizedPayload.queueEmbed(params)`

Manually queue a vectorization job for a document.

**Parameters:**

Either:

- `params.collection` (required): Collection slug
- `params.docId` (required): Document ID to fetch and vectorize

Or:

- `params.collection` (required): Collection slug
- `params.doc` (required): Document object to vectorize

**Returns:** `Promise<void>`

**Example:**

```typescript
// Queue by document ID (fetches document first)
await vectorizedPayload.queueEmbed({
  collection: 'posts',
  docId: 'some-post-id',
})

// Queue with document object directly
await vectorizedPayload.queueEmbed({
  collection: 'posts',
  doc: {
    id: 'some-post-id',
    title: 'Post Title',
    content: { /* ... */ },
  },
})
```

#### `vectorizedPayload.bulkEmbed(params)`

Starts a bulk embedding run. Programmatic equivalent of [POST `/api/vector-bulk-embed`](#post-apivector-bulk-embed) — same request shape, same success / conflict response shapes.

```typescript
const result = await vectorizedPayload.bulkEmbed({ knowledgePool: 'mainKnowledgePool' })
if ('conflict' in result && result.conflict) {
  console.log('A run is already active:', result.message)
} else {
  console.log('Bulk embed started with run ID:', result.runId)
}
```

**Invariants:**

- Only one active run per knowledge pool at a time.
- Eligibility is driven by [`embeddingVersion` semantics](#knowledge-pool-config).
- Status progression: `queued` → `running` → `succeeded` | `failed`.
- Track progress in the `vector-bulk-embeddings-runs` and `vector-bulk-embeddings-batches` admin collections.

#### `vectorizedPayload.retryFailedBatch(params)`

Retries a failed batch. Programmatic equivalent of [POST `/api/vector-retry-failed-batch`](#post-apivector-retry-failed-batch) — same request shape, same response shapes.

The method reconstructs chunks from the batch's stored metadata, resubmits to your provider, and creates a new batch. The original batch is marked `retried` and linked to the new one via `retriedBatch`.

```typescript
const result = await vectorizedPayload.retryFailedBatch({ batchId: '123' })
if ('error' in result) {
  console.error('Failed to retry batch:', result.error)
} else {
  console.log(`Batch ${result.batchId} retried. New batch ID: ${result.newBatchId}`)
}
```

**Invariants:**

- Only batches with `failed` or `retried` status can be retried.
- Parent run must be in a terminal state (`succeeded` or `failed`) — cannot retry while it's `queued` or `running`. A successful retry resets the parent run to `running`.
- Calling retry on an already-retried batch returns the existing retry batch (idempotent — no duplicate).
- Batch metadata must still exist for the retry to reconstruct the chunks.

## Troubleshooting

### Schema conflict / duplicate collection slug error on startup

**Cause:** A `knowledgePools` key matches an existing collection slug.
**Fix:** Rename the pool — the embeddings collection slug is derived from the pool name.

### "Embed all" button is missing or admin custom components don't render

**Cause:** Import map is stale.
**Fix:** Run `pnpm run generate:importmap`. In production, run it **before** `pnpm build`.

### `getVectorizedPayload(payload)` returns `null`

**Cause:** The plugin isn't registered on this Payload config, or `disabled: true` is set.
**Fix:** Add `payloadcmsVectorize({...})` to `plugins` and reinitialize.

### Realtime embeddings never run

**Cause:** The job queue isn't being processed.
**Fix:** Pass `cron: true` to `getPayload(...)` **and** add an `autoRun` entry for `realtimeQueueName` (default name if you didn't override it).

### Bulk run sits in `queued` forever

**Cause:** Missing `bulkQueueNames` or missing `autoRun` cron entries for the prepare/poll queues.
**Fix:** Both queue names must match between the plugin config and `jobs.autoRun`. See [Bulk Embeddings API → Queue Configuration](#queue-configuration).

### Search returns 0 results after a model swap

**Cause:** Vector dimensions changed.
**Fix:** Bump `embeddingConfig.version`, run a bulk re-embed, and (if `dims` changed) follow your adapter's destructive-migration steps.

### `where` clause silently has no effect

**Cause:** The field name doesn't exist on the embeddings table — references to unknown fields are dropped.
**Fix:** Confirm the field is declared in `extensionFields` or is one of the [reserved fields](#knowledge-pool-config).

### PostgreSQL: `extension "vector" does not exist`

**Cause:** pgvector isn't installed/enabled in your database.
**Fix:** Add `extensions: ['vector']` to `postgresAdapter(...)` and ensure the role has permission to create extensions. See [@payloadcms-vectorize/pg → Prerequisites](./adapters/pg/README.md#prerequisites).

### Cloudflare: search fails with binding errors

**Cause:** The Vectorize binding isn't wired up.
**Fix:** Check `wrangler.toml` and the `binding` you pass to `createCloudflareVectorizeIntegration`. See [@payloadcms-vectorize/cf README](./adapters/cf/README.md#cloudflare-bindings).

## Videos

> **Heads up — these videos are stale.** They were recorded against an older version of the plugin and predate the database adapter split. They are still useful as an end-to-end walkthrough for **wiring up the PostgreSQL adapter** (real-time ingestion, bulk embedding flow, admin UI), but the import paths, package names, and a few config shapes shown on screen have moved. Cross-reference what you see with the current Quick Start and `@payloadcms-vectorize/pg` README.

### Implementing Semantic Search with PayloadCMS Vectorize

[![Setup + real-time ingestion](https://img.youtube.com/vi/jK54HXu19gM/0.jpg)](https://youtu.be/jK54HXu19gM)

### Save 50% on Bulk Embeddings and Migrations in Payload CMS (Part 2)

[![Bulk embedding](https://img.youtube.com/vi/oIcqu08k1Ok/0.jpg)](https://youtu.be/oIcqu08k1Ok)

## Architecture

A 30-second mental model for contributors:

```
              ┌────────────────────────────────────────────┐
              │  payloadcms-vectorize  (this package)      │
              │                                            │
   Payload    │   • Registers admin collections (runs,     │
   buildConfig├──►   batches, embeddings)                  │
              │   • Hooks into create/update/delete to     │
              │     queue Payload jobs                     │
              │   • Defines the REST + Local API surface   │
              │   • Speaks to a generic DbAdapter          │
              └──────────────────┬─────────────────────────┘
                                 │  DbAdapter interface
                                 ▼
                    ┌────────────────────────┐
                    │  @payloadcms-vectorize │
                    │     /pg   |  /cf       │
                    └────────────────────────┘
```

**Key directories:**

- [`src/`](./src/) — the core plugin: collections, hooks, jobs, REST endpoints, local API.
- [`adapters/pg/`](./adapters/pg/) — PostgreSQL + pgvector adapter.
- [`adapters/cf/`](./adapters/cf/) — Cloudflare Vectorize adapter.
- [`adapters/README.md`](./adapters/README.md) — `DbAdapter` interface contract for new adapters.
- [`dev/`](./dev/) — a working Payload app used for tests and manual verification.

**Job model:**

- `vectorize-realtime` (default queue) — single per-document embed jobs triggered by Payload create/update hooks.
- `prepare-bulk-embedding` — coordinator job that fans out one worker per collection for bulk runs.
- `poll-or-complete-single-batch` — polls a single provider batch, requeues itself until terminal, then writes embeddings.

See [Bulk Embeddings API → Bulk Task Model](#bulk-task-model) for the long version.

## Community

Contributions are welcome — please open an issue or PR. **We're especially looking for help adding more database adapters!** If you use MongoDB Atlas, SQLite, Pinecone, Qdrant, or any other vector-capable database with Payload CMS, we'd love your help building an adapter. See [adapters/README.md](./adapters/README.md) for the `DbAdapter` interface and how to get started. Open an issue to coordinate before starting work.

If this plugin is useful to you, **star the repo** and **open issues** for bugs, feature requests, docs gaps, or questions — community engagement directly drives our priorities.

### Development

Setup:

```bash
pnpm install
pnpm test:setup     # Boots the test Postgres via docker-compose
pnpm dev            # Runs the dev Payload app at http://localhost:3000
```

Common scripts:

| Script                    | Purpose                                                                       |
| ------------------------- | ----------------------------------------------------------------------------- |
| `pnpm dev`                | Run the dev Payload app in [`dev/`](./dev/)                                   |
| `pnpm test:int`           | Vitest integration tests against the real Postgres in `dev/.env.test`         |
| `pnpm test:adapters:pg`   | PG adapter integration tests                                                  |
| `pnpm test:adapters:cf`   | Cloudflare Vectorize adapter integration tests                                |
| `pnpm test:e2e`           | Playwright end-to-end tests                                                   |
| `pnpm test:setup` / `:teardown` | Bring the test Postgres up / down                                       |
| `pnpm lint`               | ESLint                                                                        |
| `pnpm build`              | Build the core plugin and both adapters                                       |
| `pnpm changeset`          | Add a Changeset entry before opening a PR                                     |

### Roadmap

**Already shipped:**

- **Multiple Knowledge Pools** — independent configurations and embedding functions per pool.
- **Database Adapter Architecture** — pluggable backends (PostgreSQL, Cloudflare Vectorize today).
- **More expressive queries** — configurable limits, per-collection scoping, and full Payload-style metadata filtering (see [Metadata Filtering](#metadata-filtering-where)).
- **Bulk Embed All** — admin button, provider callbacks, and run/batch tracking.
- **Serverless-friendly job model** — bulk runs are split into small, requeueable units (`prepare-bulk-embedding` and `poll-or-complete-single-batch`) so individual jobs stay well under typical serverless time limits. The `batchLimit` option (see [CollectionVectorizeOption](#collectionvectorizeoption)) lets you cap docs-per-job to fit your platform. Tested locally and on Node-style hosts; deeper Vercel-specific integration testing is on the help-wanted list.
- **Cloudflare Vectorize adapter** — `@payloadcms-vectorize/cf`.

**Help wanted** (priority is driven by community demand — open or 👍 an issue to push something up):

- **MongoDB adapter** — `@payloadcms-vectorize/mongodb` for MongoDB Atlas Vector Search.
- **Additional adapters** — Pinecone, Qdrant, SQLite, etc. See [adapters/README.md](./adapters/README.md) for the `DbAdapter` contract.
- **Vercel CI matrix** — exercising the serverless job model end-to-end on Vercel preview deployments.

Want one of these sooner? Star the repo and open an issue.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for release history, migration notes, and upgrade guides.

## License

[MIT](./LICENSE)
