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
          embedDocs,
          embedQuery,
          embeddingVersion: 'v1.0.0',
        },
      },
      // Optional plugin options:
      // queueName: 'custom-queue',
      // endpointOverrides: { path: '/custom-vector-search', enabled: true }, // will be /api/custom-vector-search
      // disabled: false,
    }),
  ],
})
```

**Important:** `knowledgePools` must have **different names than your collections**—reusing a collection name for a knowledge pool **will cause schema conflicts**. (In this example, the knowledge pool is named 'main' and a collection named 'main' will be created.)

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
- `embedDocs`: `EmbedDocsFn` - Function to embed multiple documents
- `embedQuery`: `EmbedQueryFn` - Function to embed search queries
- `embeddingVersion`: `string` - Version string for tracking model changes
- `extensionFields?`: `Field[]` - Optional fields to extend the embeddings collection schema
- `bulkEmbeddings?`: Configuration for bulk embedding operations:
  - `ingestMode?`: `'realtime' | 'bulk'` - Default `'realtime'` queues embeddings immediately. `'bulk'` skips realtime embedding, deletes stale vectors on updates, and relies on the bulk job to backfill.
  - `prepareBulkEmbeddings(args)`: Callback to prepare a bulk embedding batch
  - `pollBulkEmbeddings(args)`: Callback to poll the status of a bulk embedding batch
  - `completeBulkEmbeddings(args)`: Callback to retrieve completed embeddings from a batch
    If `bulkEmbeddings` is omitted for a pool, the "Embed all" button is disabled and bulk is not available.

### Bulk Task Model

When bulk ingest mode is enabled, the plugin uses separate Payload jobs for reliability with long-running providers:

- **`prepare-bulk-embedding`**: One-shot task that collects missing embeddings and submits them to the provider. Short-lived.
- **`poll-or-complete-bulk-embedding`**: Polls the provider status and completes embedding ingestion when ready. Can requeue itself until completion.

### Queue Configuration

For production deployments with bulk embedding:

```typescript
// Recommended production setup
plugins: [
  payloadcmsVectorize({
    knowledgePools: { /* ... */ },
    realtimeQueueName: 'vectorize-realtime', // Separate realtime jobs (Optional)
    bulkQueueNames: {
      prepareBulkEmbedQueueName: 'vectorize-bulk-prepare', // Daily bulk preparation (Required if any knowledge pool uses bulk ingestion)
      pollOrCompleteQueueName: 'vectorize-bulk-poll',       // Frequent polling/completion (Required if any knowledge pool uses bulk ingestion)
    },
  }),
]

jobs: {
  // Payload processes jobs via autoRun. Use different schedules for different workloads.
  autoRun: [
    { cron: '*/5 * * * * *', limit: 10, queue: 'vectorize-realtime' }, // Optional: Process realtime jobs every 5 seconds
    { cron: '0 0 * * * *', limit: 1, queue: 'vectorize-bulk-prepare' }, // Required: Run bulk preparation once per hour (or daily)
    { cron: '*/30 * * * * *', limit: 5, queue: 'vectorize-bulk-poll' }, // Required: Poll bulk status every 30 seconds
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

### Bulk embedding (Embed all)

- Each knowledge pool’s embeddings list shows an **Embed all** admin button that queues a `payloadcms-vectorize:bulk-embed-all` job.
- Bulk runs only include documents that are missing embeddings for the pool’s current `embeddingVersion`.
- Progress is recorded in the `vector-bulk-embeddings-runs` collection (fields: `pool`, `embeddingVersion`, `providerBatchId`, `status`, counts, timestamps, `error`).
- Endpoint: **POST** `/api/vector-bulk-embed`

```jsonc
{
  "knowledgePool": "main",
}
```

Bulk callbacks are provider-agnostic:

- `prepareBulkEmbeddings({ payload, knowledgePool, embeddingVersion, inputs })`
- `pollBulkEmbeddings({ payload, knowledgePool, providerBatchId })`
- `completeBulkEmbeddings({ payload, knowledgePool, providerBatchId })`

If `bulkEmbeddings` is not provided, the plugin falls back to running `embedDocs` locally.

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

- **Migrations for vector dimensions**: Easy migration tools for changing vector dimensions and/or ivfflatLists after initial setup
- **MongoDB support**: Extend vector search capabilities to MongoDB databases
- **Vercel support**: Optimized deployment and configuration for Vercel hosting

**Want to see these features sooner?** Star this repository and open issues for the features you need most!
