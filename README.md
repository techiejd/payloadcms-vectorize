# PayloadCMS Vectorize

A Payload CMS plugin that adds vector search capabilities to your collections using PostgreSQL's pgvector extension. Perfect for building RAG (Retrieval-Augmented Generation) applications and semantic search features.

## Features

- 🔍 **Semantic Search**: Vectorize any collection for intelligent content discovery
- 🚀 **Automatic**: Documents are automatically vectorized when created or updated, and vectors are deleted as soon as the document is deleted.
- 🧵 **Bulk embedding**: Run “Embed all” batches that backfill only documents missing the current `embeddingVersion`.
- 📊 **PostgreSQL Integration**: Built on pgvector for high-performance vector operations
- ⚡ **Background Processing**: Uses Payload's job system for non-blocking vectorization
- 🎯 **Flexible Chunking**: Drive chunk creation yourself with `toKnowledgePool` functions so you can combine any fields or content types
- 🧩 **Extensible Schema**: Attach custom `extensionFields` to the embeddings collection and persist values per chunk and use for querying.
- 🌐 **REST API**: Built-in vector-search endpoint with Payload-style `where` filtering and configurable limits
- 🏊 **Multiple Knowledge Pools**: Separate knowledge pools with independent configurations (dims, ivfflatLists, embedding functions) and needs.

## Prerequisites

- Payload CMS 3.x (tested on 3.69.0, previously tested on 3.37.0)
- PostgreSQL with pgvector extension
- Node.js 18+

**Note for Payload 3.54.0+:** When initializing Payload with `getPayload`, you must include `cron: true` if you want the cron jobs to run correctly:

```typescript
payload = await getPayload({ config, cron: true })
```

## Installation

```bash
pnpm add payloadcms-vectorize
```

## Quick Start

### 0. Have pgvector permissions

The plugin expects `vector` extension to be configured when Payload initializes. Your PostgreSQL database user must have permission to create extensions. If your user doesn't have these permissions, someone with permissions may need to manually create the extension once:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

**Note:** Most managed PostgreSQL services (like AWS RDS, Supabase, etc.) require superuser privileges or specific extension permissions. If you encounter permission errors, contact your database administrator or check your service's documentation.

### 1. Configure the Plugin

```typescript
import { buildConfig } from 'payload'
import type { Payload } from 'payload'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { createVectorizeIntegration } from 'payloadcms-vectorize'
import type { ToKnowledgePoolFn } from 'payloadcms-vectorize'

// Configure your embedding functions
const embedDocs = async (texts: string[]) => {
  // Your embedding logic here
  return texts.map((text) => /* vector array */)
}

const embedQuery = async (text: string) => {
  // Your query embedding logic here
  return /* vector array */
}

// Optional chunker helpers (see dev/helpers/chunkers.ts for ideas)
const chunkText = async (text: string, payload: Payload) => {
  return /* string array */
}

const chunkRichText = async (richText: any, payload: Payload) => {
  return /* string array */
}

// Convert a document into chunks + extension-field values
const postsToKnowledgePool: ToKnowledgePoolFn = async (doc, payload) => {
  const entries: Array<{ chunk: string; category?: string; priority?: number }> = []

  const titleChunks = await chunkText(doc.title ?? '', payload)
  titleChunks.forEach((chunk) =>
    entries.push({
      chunk,
      category: doc.category ?? 'general',
      priority: Number(doc.priority ?? 0),
    }),
  )

  const contentChunks = await chunkRichText(doc.content, payload)
  contentChunks.forEach((chunk) =>
    entries.push({
      chunk,
      category: doc.category ?? 'general',
      priority: Number(doc.priority ?? 0),
    }),
  )

  return entries
}

// Create the integration with static configs (dims, ivfflatLists)
const { afterSchemaInitHook, payloadcmsVectorize } = createVectorizeIntegration({
  // Note limitation: Changing these values requires a migration.
  main: {
    dims: 1536, // Vector dimensions
    ivfflatLists: 100, // IVFFLAT index parameter
  },
})

export default buildConfig({
  // ... your existing config
  db: postgresAdapter({
    // configure the 'vector' extension.
    extensions: ['vector'],
    // afterSchemaInitHook adds 'vector' to your schema
    afterSchemaInit: [afterSchemaInitHook],
    // ... your database config
  }),
  plugins: [
    payloadcmsVectorize({
      knowledgePools: {
        main: {
          collections: {
            posts: {
              toKnowledgePool: postsToKnowledgePool,
            },
          },
          extensionFields: [
            { name: 'category', type: 'text' },
            { name: 'priority', type: 'number' },
          ],
          embeddingConfig: {
            version: 'v1.0.0',
            queryFn: embedQuery,
            realTimeIngestionFn: embedDocs,
            // bulkEmbeddingsFns: { ... } // Optional: for batch API support
          },
        },
      },
      // Optional plugin options:
      // realtimeQueueName: 'custom-queue',
      // endpointOverrides: { path: '/custom-vector-search', enabled: true },
      // disabled: false,
    }),
  ],
})
```

**Important:** `knowledgePools` must have **different names than your collections**—reusing a collection name for a knowledge pool **will cause schema conflicts**. (In this example, the knowledge pool is named 'main' and a collection named 'main' will be created.)

### 1.5. Generate Import Map (Required for Admin UI)

After configuring the plugin, you must generate the import map so that Payload can resolve client components (like the "Embed all" button) in the admin UI for bulk embeddings:

```bash
pnpm run generate:importmap
```

**⚠️ Important:** Run this command:

- After initial plugin setup
- If the "Embed all" button doesn't appear in the admin UI

The import map tells Payload how to resolve component paths (like `'payloadcms-vectorize/client#EmbedAllButton'`) to actual React components. Without it, client components referenced in your collection configs won't render.

### 2. Search Your Content

The plugin automatically creates a `/api/vector-search` endpoint:

```typescript
const response = await fetch('/api/vector-search', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: 'What is machine learning?', // Required
    knowledgePool: 'main', // Required
    where: {
      category: { equals: 'guides' }, // Optional Payload-style filter
    },
    limit: 5, // Optional (defaults to 10)
  }),
})

const { results } = await response.json()
// Each result contains: id, similarity, sourceCollection, docId, chunkIndex, chunkText,
// embeddingVersion, and any extensionFields you attached (e.g., category, priority).
```

## Configuration Options

### Plugin Options

| Option              | Type                                                                   | Required | Description                                                                 |
| ------------------- | ---------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------- |
| `knowledgePools`    | `Record<KnowledgePool, KnowledgePoolDynamicConfig>`                    | ✅       | Knowledge pools and their configurations                                    |
| `realtimeQueueName` | `string`                                                               | ❌       | Custom queue name for realtime vectorization jobs                           |
| `bulkQueueNames`    | `{prepareBulkEmbedQueueName: string, pollOrCompleteQueueName: string}` | ❌       | Queue names for bulk embedding jobs (required if any pool uses bulk ingest) |
| `endpointOverrides` | `object`                                                               | ❌       | Customize the search endpoint                                               |
| `disabled`          | `boolean`                                                              | ❌       | Disable plugin while keeping schema                                         |

### Knowledge Pool Config

Knowledge pools are configured in two steps. The static configs define the database schema (migration required), while dynamic configs define runtime behavior (no migration required).

**1. Static Config** (passed to `createVectorizeIntegration`):

- `dims`: `number` - Vector dimensions for pgvector column
- `ivfflatLists`: `number` - IVFFLAT index parameter

The embeddings collection name will be the same as the knowledge pool name.

**2. Dynamic Config** (passed to `payloadcmsVectorize`):

- `collections`: `Record<string, CollectionVectorizeOption>` - Collections and their chunking configs
- `extensionFields?`: `Field[]` - Optional fields to extend the embeddings collection schema
- `embeddingConfig`: Embedding configuration object:
  - `version`: `string` - Version string for tracking model changes
  - `queryFn`: `EmbedQueryFn` - Function to embed search queries
  - `realTimeIngestionFn?`: `EmbedDocsFn` - Function for real-time embedding on document changes
  - `bulkEmbeddingsFns?`: Streaming bulk embedding callbacks (see below)

If `realTimeIngestionFn` is provided, documents are embedded immediately on create/update.
If only `bulkEmbeddingsFns` is provided (no `realTimeIngestionFn`), embedding only happens via manual bulk runs.
If neither is provided, embedding is disabled for that pool.

### Bulk Embeddings API

The bulk embedding API is designed for large-scale embedding using provider batch APIs (like Voyage AI). **Bulk runs are never auto-queued** - they must be triggered manually via the admin UI or API.

#### The Streaming Model

The plugin streams chunks to your callbacks one at a time, giving you full control over batching based on your provider's file size limits:

```typescript
type BulkEmbeddingsFns = {
  addChunk: (args: AddChunkArgs) => Promise<BatchSubmission | null>
  pollBatch: (args: PollBatchArgs) => Promise<PollBulkEmbeddingsResult>
  completeBatch: (args: CompleteBatchArgs) => Promise<BulkEmbeddingOutput[]>
  onError?: (args: OnBulkErrorArgs) => Promise<void>
}
```

#### `addChunk` - Accumulate and Submit

Called for each chunk. You manage your own accumulation and decide when to submit based on file size.

```typescript
type AddChunkArgs = {
  chunk: { id: string; text: string }
  isLastChunk: boolean
}

type BatchSubmission = {
  providerBatchId: string
}
```

**Return values:**

- `null` - "I'm accumulating this chunk, not ready to submit yet"
- `{ providerBatchId }` - "I just submitted a batch to my provider"

**⚠️ Important contract about which chunks are included in a submission:**

- When `isLastChunk=false` and you return a submission: all pending chunks **EXCEPT** the current one were submitted (current chunk starts fresh accumulation)
- When `isLastChunk=true` and you return a submission: all pending chunks **INCLUDING** the current one were submitted

**Example implementation:**

```typescript
let accumulated: BulkEmbeddingInput[] = []
let accumulatedSize = 0
const FILE_SIZE_LIMIT = 50 * 1024 * 1024 // 50MB

addChunk: async ({ chunk, isLastChunk }) => {
  const chunkSize = JSON.stringify(chunk).length

  // Would exceed limit? Submit what we have, keep current for next batch
  if (accumulatedSize + chunkSize > FILE_SIZE_LIMIT && accumulated.length > 0) {
    const result = await submitToProvider(accumulated)
    accumulated = [chunk] // Start fresh WITH current chunk
    accumulatedSize = chunkSize
    return { providerBatchId: result.id }
  }

  accumulated.push(chunk)
  accumulatedSize += chunkSize

  // Last chunk? Must flush everything
  if (isLastChunk && accumulated.length > 0) {
    const result = await submitToProvider(accumulated)
    accumulated = []
    accumulatedSize = 0
    return { providerBatchId: result.id }
  }

  return null
}
```

**Note:** If a single chunk exceeds your provider's file size limit, you'll need to handle that edge case in your implementation (e.g., skip it, split it, or fail gracefully).

#### `pollBatch` - Check Status

Called repeatedly until the batch reaches a terminal status.

```typescript
type PollBatchArgs = { providerBatchId: string }

type PollBulkEmbeddingsResult = {
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'
  counts?: { inputs?: number; succeeded?: number; failed?: number }
  error?: string
}
```

#### `completeBatch` - Download Results

Called after all batches succeed. Download the embeddings from your provider.

```typescript
type CompleteBatchArgs = { providerBatchId: string }

type BulkEmbeddingOutput = {
  id: string // Must match the chunk.id from addChunk
  embedding?: number[]
  error?: string
}
```

#### `onError` - Cleanup on Failure (Optional)

Called when the bulk run fails. Use this to clean up provider-side resources (delete files, cancel batches). The run can be re-queued after cleanup.

```typescript
type OnBulkErrorArgs = {
  providerBatchIds: string[]
  error: Error
}
```

### Bulk Task Model

The plugin uses separate Payload jobs for reliability with long-running providers:

- **`prepare-bulk-embedding`**: Streams through documents, calls your `addChunk` for each chunk, creates batch records.
- **`poll-or-complete-bulk-embedding`**: Polls all batches, requeues itself until done, then atomically writes all embeddings.

### Queue Configuration

For production deployments with bulk embedding:

```typescript
plugins: [
  payloadcmsVectorize({
    knowledgePools: { /* ... */ },
    realtimeQueueName: 'vectorize-realtime',
    bulkQueueNames: {
      prepareBulkEmbedQueueName: 'vectorize-bulk-prepare',
      pollOrCompleteQueueName: 'vectorize-bulk-poll',
    },
  }),
]

jobs: {
  autoRun: [
    { cron: '*/5 * * * * *', limit: 10, queue: 'vectorize-realtime' },
    { cron: '0 0 * * * *', limit: 1, queue: 'vectorize-bulk-prepare' },
    { cron: '*/30 * * * * *', limit: 5, queue: 'vectorize-bulk-poll' },
  ],
}
```

#### CollectionVectorizeOption

- `toKnowledgePool (doc, payload)` – return an array of `{ chunk, ...extensionFieldValues }`. Each object becomes one embedding row and the index in the array determines `chunkIndex`.

Reserved column names: `sourceCollection`, `docId`, `chunkIndex`, `chunkText`, `embeddingVersion`. Avoid reusing them in `extensionFields`.

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

## Validation & retries

- Each entry returned by `toKnowledgePool` must be an object with a required `chunk` string.
- If any entry is malformed, the vectorize job fails with `hasError = true` and an error message listing invalid indices.
- To retry after fixing your `toKnowledgePool` logic, clear `hasError` and `completedAt` (and set `processing` to `false` if needed) on the failed `payload-jobs` row. The queue runner will pick it up on the next interval.

## PostgreSQL Custom Schema Support

The plugin reads the `schemaName` configuration from your Postgres adapter within the Payload config.

When you configure a custom schema via `postgresAdapter({ schemaName: 'custom' })`, all plugin SQL queries (for vector columns, indexes, and embeddings) are qualified with that schema name. This is useful for multi-tenant setups or when content tables live in a dedicated schema.

Where schemaName is not specified within the postgresAdapter in the Payload config, the plugin falls back to `public` as is default adapter behaviour.

## Example

### Using with Voyage AI

```typescript
import { voyageEmbedDocs, voyageEmbedQuery } from 'voyage-ai-provider'

export const embedDocs = async (texts: string[]): Promise<number[][]> => {
  const embedResult = await embedMany({
    model: voyage.textEmbeddingModel('voyage-3.5-lite'),
    values: texts,
    providerOptions: {
      voyage: { inputType: 'document' },
    },
  })
  return embedResult.embeddings
}
export const embedQuery = async (text: string): Promise<number[]> => {
  const embedResult = await embed({
    model: voyage.textEmbeddingModel('voyage-3.5-lite'),
    value: text,
    providerOptions: {
      voyage: { inputType: 'query' },
    },
  })
  return embedResult.embedding
}
```

## API Reference

### Search Endpoint

**POST** `/api/vector-search`

Search for similar content using vector similarity.

**Request Body:**

```jsonc
{
  "query": "Your search query",
  "knowledgePool": "main",
  "where": {
    "category": { "equals": "guides" },
    "priority": { "gte": 3 },
  },
  "limit": 5,
}
```

**Parameters**

- `query` (required): Search query string
- `knowledgePool` (required): Knowledge pool identifier to search in
- `where` (optional): Payload-style `Where` clause evaluated against the embeddings collection + any `extensionFields`
- `limit` (optional): Maximum results to return (defaults to `10`)

**Response:**

```jsonc
{
  "results": [
    {
      "id": "embedding_id",
      "similarity": 0.85,
      "sourceCollection": "posts",
      "docId": "post_id",
      "chunkIndex": 0,
      "chunkText": "Relevant text chunk",
      "embeddingVersion": "v1.0.0",
      "category": "guides", // example extension field
      "priority": 4, // example extension field
    },
  ],
}
```

### Bulk Embedding (Embed All)

- Each knowledge pool's embeddings list shows an **Embed all** admin button that triggers a bulk run.
- **Note:** Make sure you've run `pnpm run generate:importmap` after plugin configuration, otherwise the button won't appear.
- Bulk runs only include documents missing embeddings for the pool's current `embeddingConfig.version`.
- Progress is recorded in `vector-bulk-embeddings-runs` and `vector-bulk-embeddings-batches` collections.
- Endpoint: **POST** `/api/vector-bulk-embed`

```jsonc
{
  "knowledgePool": "main",
}
```

The bulk embedding process is **atomic**: either all embeddings are written or none are. If any batch fails, the run is marked failed and no partial writes occur.

**Error Recovery:** If a run fails, you can re-queue it. If you provided an `onError` callback, it will be called with all `providerBatchIds` so you can clean up provider-side resources before retrying.

If `bulkEmbeddingsFns` is not provided, the "Embed all" button is disabled.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for release history, migration notes, and upgrade guides.

## Requirements

- Payload CMS >=3.0.0 <4.0.0 (tested on 3.69.0, previously tested on 3.37.0)
- PostgreSQL with pgvector extension
- Node.js ^18.20.2

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## ⭐ Star This Repository

If you find this plugin useful, please give it a star! Stars help us understand how many developers are using this plugin and directly influence our development priorities. More stars = more features, better performance, and faster bug fixes.

## 🐛 Report Issues & Request Features

Help us prioritize development by opening issues for:

- **Bugs**: Something not working as expected
- **Feature requests**: New functionality you'd like to see
- **Improvements**: Ways to make existing features better
- **Documentation**: Missing or unclear information
- **Questions**: I'll answer through the issues.

The more detailed your issue, the better I can understand and address your needs. Issues with community engagement (reactions, comments) get higher priority!

## 🗺️ Roadmap

Thank you for the stars! The following updates have been completed:

- **Multiple Knowledge Pools**: You can create separate knowledge pools with independent configurations (dims, ivfflatLists, embedding functions) and needs. Each pool operates independently, allowing you to organize your vectorized content by domain, use case, or any other criteria that makes sense for your application.
- **More expressive queries**: Added ability to change query limit, search on certain collections or certain fields
- **Bulk embed all**: Batch backfills with admin button, provider callbacks, and run tracking.

The following features are planned for future releases based on community interest and stars:

- **Bulk prepare progress visibility**: Real-time progress tracking during the prepare phase for large collections
- **Migrations for vector dimensions**: Easy migration tools for changing vector dimensions and/or ivfflatLists after initial setup
- **MongoDB support**: Extend vector search capabilities to MongoDB databases
- **Vercel support**: Optimized deployment and configuration for Vercel hosting

**Want to see these features sooner?** Star this repository and open issues for the features you need most!
