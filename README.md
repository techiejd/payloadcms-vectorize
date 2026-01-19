# PayloadCMS Vectorize

A Payload CMS plugin that adds vector search capabilities to your collections using PostgreSQL's pgvector extension. Perfect for building RAG (Retrieval-Augmented Generation) applications and semantic search features.

## Features

- 🔍 **Semantic Search**: Vectorize any collection for intelligent content discovery
- 🚀 **Realtime**: Documents are automatically vectorized when created or updated in realtime, and vectors are deleted as soon as the document is deleted.
- 🧵 **Bulk embedding**: Run “Embed all” batches that backfill only documents missing the current `embeddingVersion` since the last bulk run in order to save money.
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

## Installation

```bash
pnpm add payloadcms-vectorize
```

## Quick Start

### 0. Have pgvector permissions

The plugin expects `vector` extension to be configured (`db: postgresAdapter({extensions: ['vector'],...})`) when Payload initializes. Your PostgreSQL database user must have permission to create extensions. If your user doesn't have these permissions, someone with permissions may need to manually create the extension once:

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
  mainKnowledgePool: {
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
        mainKnowledgePool: {
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
      // bulkQueueNames: { // Required iff `bulkEmbeddingsFns` included
      //   prepareBulkEmbedQueueName: ...,
      //   pollOrCompleteQueueName: ...,
      // },
    }),
  ],
  jobs: { // Remember to setup your cron for the embedding
    autoRun: [
      ...
    ],
  },
})
```

**Important:** `knowledgePools` must have **different names than your collections**—reusing a collection name for a knowledge pool **will cause schema conflicts**. (In this example, the knowledge pool is named 'mainKnowledgePool' and a collection named 'main-knowledge-pool' will be created.)

**⚠️ Important (Import map):** The import map tells Payload how to resolve component paths (like `'payloadcms-vectorize/client#EmbedAllButton'`) to actual React components. Without it, client components referenced in your collection configs won't render.

Run:

- After initial plugin setup and if in production mode.
- If client components (like the "Embed all" button) don't appear in the admin UI

```bash
pnpm run generate:importmap
```

**Note:** Payload automatically generates the import map on startup during development (HMR), so you typically don't need to run this manually in development. However:

- **For production builds**: You MUST run `pnpm run generate:importmap` BEFORE running `pnpm build`, otherwise custom components won't be found during the build process.
- **If client components don't appear**: Try manually generating the import map: `pnpm run generate:importmap`

**⚠️ Important:** Run this command:

- After initial plugin setup
- If the "Embed all" button doesn't appear in the admin UI

The import map tells Payload how to resolve component paths (like `'payloadcms-vectorize/client#EmbedAllButton'`) to actual React components. Without it, client components referenced in your collection configs won't render.

### 2. Initial Migration Setup

After configuring the plugin, you need to create an initial migration to set up the IVFFLAT indexes in your database.

**For new setups:**

1. Create your initial Payload migration (this will include the embedding columns via Drizzle schema):

   ```bash
   pnpm payload migrate:create --name initial
   ```

2. Use the migration CLI helper to add IVFFLAT index setup:

   ```bash
   pnpm payload vectorize:migrate
   ```

   The CLI automatically extracts your static configs from the Payload config and patches the migration file with the necessary IVFFLAT index creation SQL.

3. Review and apply the migration:
   ```bash
   pnpm payload migrate
   ```

**Note:** The embedding columns are created automatically by Drizzle via the `afterSchemaInitHook`, but the IVFFLAT indexes need to be added via migrations for proper schema management.

### 3. Search Your Content

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

Alternatively, you can use the local API directly on the Payload instance:

```typescript
import { getVectorizedPayload } from 'payloadcms-vectorize'

// After initializing Payload, get the vectorized payload object
const payload = await getPayload({ config, cron: true })
const vectorizedPayload = getVectorizedPayload(payload)

if (vectorizedPayload) {
  const results = await vectorizedPayload.search({
    query: 'What is machine learning?',
    knowledgePool: 'main',
    where: {
      category: { equals: 'guides' },
    },
    limit: 5,
  })
  // results is an array of VectorSearchResult
}
```

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

**Note:** Embedding deletion cannot be disabled. When a source document is deleted, all its embeddings are automatically deleted from all knowledge pools that contain that collection, regardless of how the embeddings were created (bulk or real-time). This behavior ensures data consistency and cannot be configured.

### Bulk Embeddings API

The bulk embedding API is designed for large-scale embedding using provider batch APIs (like Voyage AI). **Bulk runs are never auto-queued** - they must be triggered manually via the admin UI or API.

#### The bulk embedding callbacks

In order to get bulk embeddings to interface with your provider, you must define the following three callbacks per knowledge pool (the functions do not have to be unique so you can re-use across knowledge pools).

```typescript
type BulkEmbeddingsFns = {
  addChunk: (args: AddChunkArgs) => Promise<BatchSubmission | null>
  pollOrCompleteBatch: (args: PollOrCompleteBatchArgs) => Promise<PollBulkEmbeddingsResult>
  onError?: (args: OnBulkErrorArgs) => Promise<void>
}
```

#### `addChunk` - Accumulate and Submit

The plugin streams chunks to your callbacks one at a time; the callback is called for each chunk. You manage your own accumulation and decide when to submit based on file size.

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

- `null` - "I'm accumulating this chunk, not ready to submit yet"
- `{ providerBatchId }` - "I just submitted a batch to my provider"

**⚠️ Important contract:**

When you return a submission, the plugin assumes **all chunks currently in `pendingChunks` were submitted**. The plugin tracks chunks and creates batch records based on this assumption.

**About `isLastChunk`:**

- `isLastChunk=true` indicates this is the final chunk in the run
- Use this to flush any remaining accumulated chunks before the run completes

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

**Note:** If a single chunk exceeds your provider's file size or line limit, you'll need to handle that edge case in your implementation (e.g., skip it, split it, or fail gracefully).

#### `pollOrCompleteBatch` - Poll and Stream Results

Called repeatedly until the batch reaches a terminal status. When the batch completes, stream the outputs via the `onChunk` callback.

```typescript
type PollOrCompleteBatchArgs = {
  providerBatchId: string // You provided it in the earlier step when you submitted a batch.
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

1. The plugin calls `pollOrCompleteBatch` repeatedly for each batch
2. While the batch is in progress, return the status (`queued` or `running`) without calling `onChunk`
3. When the batch completes, stream each embedding result by calling `onChunk` for each output, then return `{ status: 'succeeded' }`
4. If the batch fails, return `{ status: 'failed', error: '...' }` without calling `onChunk`

**About the `id` field in outputs:**

- **Correlation**: The `id` in each `BulkEmbeddingOutput` must match the `chunk.id` that was passed to `addChunk`. This is how the plugin correlates outputs back to their original inputs.
- **Extraction**: When processing your provider's response, extract the `id` that you originally sent (e.g., from Voyage's `custom_id` field) and include it in the returned `BulkEmbeddingOutput`.
- **Example**: If you sent `{ custom_id: "posts:123:0", input: [...] }` to your provider, extract `result.custom_id` from the response and call `await onChunk({ id: result.custom_id, embedding: [...] })`.

#### `onError` - Cleanup on Failure (Optional)

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

### Bulk Task Model

The plugin uses separate Payload jobs for reliability with long-running providers:

- **`prepare-bulk-embedding`**: Streams through documents, calls your `addChunk` for each chunk, creates batch records.
- **`poll-or-complete-bulk-embedding`**: Polls all batches, requeues itself until done, then writes all successful embeddings (partial chunk failures are allowed).

### Queue Configuration

For bulk embedding, you must provide the bulk queue names.

```typescript
plugins: [
  payloadcmsVectorize({
    knowledgePools: { /* ... */ },
    realtimeQueueName: 'vectorize-realtime', // optional
    bulkQueueNames: { // required iff you are using bulk embeddings
      prepareBulkEmbedQueueName: 'vectorize-bulk-prepare',
      pollOrCompleteQueueName: 'vectorize-bulk-poll',
    },
  }),
]

jobs: {
  autoRun: [ // Must match
    { cron: '*/5 * * * * *', limit: 10, queue: 'vectorize-realtime' },
    { cron: '0 0 * * * *', limit: 1, queue: 'vectorize-bulk-prepare' },
    { cron: '*/30 * * * * *', limit: 5, queue: 'vectorize-bulk-poll' },
  ],
}
```

## Changing Static Config (ivfflatLists or dims) & Migrations

**⚠️ Important:** Changing `dims` is **DESTRUCTIVE** - it requires re-embedding all your data. Changing `ivfflatLists` rebuilds the index (non-destructive but may take time).

When you change static config values (`dims` or `ivfflatLists`):

1. **Update your static config** in `payload.config.ts`:

   ```typescript
   const { afterSchemaInitHook, payloadcmsVectorize } = createVectorizeIntegration({
     mainKnowledgePool: {
       dims: 1536, // Changed from previous value
       ivfflatLists: 200, // Changed from previous value
     },
   })
   ```

2. **Create a migration** using the CLI helper:
  
   ```bash
   pnpm payload migrate:create --name migration_name
   ```

   ```bash
   pnpm payload vectorize:migrate
   ```

   The CLI will:
   - Detect changes in your static configs
   - Create a new Payload migration using `payload.db.createMigration`
   - Patch it with appropriate SQL:
     - **If `ivfflatLists` changed**: Rebuilds the IVFFLAT index with the new `lists` parameter (DROP + CREATE INDEX)
     - **If `dims` changed**: Truncates the embeddings table (DESTRUCTIVE - you'll need to re-embed)

3. **Review the migration file** in `src/migrations/` - it will be named something like `*_vectorize-config.ts`

4. **Apply the migration**:

   ```bash
   pnpm payload migrate
   ```

5. **If `dims` changed**: Re-embed all your documents using the bulk embed feature.

**Schema name qualification:**

The CLI automatically uses the `schemaName` from your Postgres adapter configuration. If you use a custom schema (e.g., `postgresAdapter({ schemaName: 'custom' })`), all SQL in the migration will be properly qualified with that schema name.

**Idempotency:**

Running `pnpm payload vectorize:migrate` multiple times with no config changes will not create duplicate migrations. The CLI detects when no changes are needed and exits early.

**Development workflow:**

During development, you may want to disable Payload's automatic schema push to ensure migrations are used:

- Set `migrations: { disableAutomaticMigrations: true }` in your Payload config, or
- Avoid using `pnpm payload migrate:status --force` which auto-generates migrations

This ensures your vector-specific migrations are properly applied.

**Runtime behavior:**

The `ensurePgvectorArtifacts` function is now **presence-only** - it checks that pgvector artifacts (extension, column, index) exist but does not create or modify them. If artifacts are missing, it throws descriptive errors prompting you to run migrations. This ensures migrations are the single source of truth for schema changes.

### Endpoints

#### POST `/api/vector-bulk-embed`

Starts a bulk embedding run for a knowledge pool via HTTP. This is the REST API equivalent of `vectorizedPayload.bulkEmbed()`.

**Request Body:**

```json
{
  "knowledgePool": "default"
}
```

**Success Response** (202 Accepted):

```json
{
  "runId": "123",
  "status": "queued"
}
```

**Conflict Response** (409 Conflict) - when a run is already active:

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
  -d '{"knowledgePool": "default"}'
```

#### POST `/api/vector-retry-failed-batch`

Retries a failed batch from a bulk embedding run via HTTP. This is the REST API equivalent of `vectorizedPayload.retryFailedBatch()`.

**Request Body:**

```json
{
  "batchId": "123"
}
```

**Success Response** (202 Accepted):

```json
{
  "batchId": "123",
  "newBatchId": "456",
  "runId": "789",
  "status": "queued"
}
```

**Already Retried Response** (202 Accepted) - when batch was already retried:

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

You can see more examples in `dev/helpers/embed.ts`

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
- **Import map note:** In development (`pnpm dev`), Payload auto-generates the import map. For production builds (`pnpm build`), you must run `pnpm run generate:importmap` first (see Quick Start above).
- Bulk runs only include documents with mismatched embedding versions for the pool's current `embeddingConfig.version` from the previous bulk run (unless none has been done in which case it embeds all).
- Progress is recorded in `vector-bulk-embeddings-runs` and `vector-bulk-embeddings-batches` admin UI collections.
- You can re-run failed bulk embeddings from `vector-bulk-embeddings-batches` admin UI and you can link to the failed batches from the `vector-bulk-embeddings-runs` admin UI.
- Endpoints: **POST** `/api/vector-bulk-embed` and `/api/vector-retry-failed-batch`

```jsonc
{
  "knowledgePool": "main",
}
```

The bulk embedding process has **three levels of failure**:

- **Run level**: If any chunk fails during ingestion (toKnowledgePool), the entire run fails and no embeddings are written. This is fully atomic. Your onError is expected to handle clean up from this stage.
- **Batch level**: If any batch fails during polling, the entire run is marked as failed but embeddings from working batches are written.
- **Chunk level**: If individual chunks fail during completion (e.g., provider returns errors for specific inputs), the run still succeeds and successful embeddings are written. Failed chunks are tracked in `failedChunkData` (with structured `collection`, `documentId`, and `chunkIndex` fields) and passed to the `onError` callback for cleanup.

This design allows for partial success: if 100 chunks are processed and 2 fail, 98 embeddings are written and the 2 failures are tracked for potential retry.

**Error Recovery:** If a run fails, you can re-queue it. If you provided an `onError` callback, it will be called with all `providerBatchIds` so you can clean up provider-side resources before retrying.

If `bulkEmbeddingsFns` is not provided, the "Embed all" button is disabled.

### Local API

The plugin provides a `getVectorizedPayload(payload)` function which returns a 'vectorizedPayload' (an object) with `search`, `queueEmbed`, `bulkEmbed` and `retryFailedBatch` methods.

#### Getting the Vectorized Payload Object

Use the `getVectorizedPayload` function to get the vectorized payload object with all vectorize methods:

```typescript
import { getVectorizedPayload } from 'payloadcms-vectorize'

const payload = await getPayload({ config, cron: true })
const vectorizedPayload = getVectorizedPayload(payload)

if (vectorizedPayload) {
  // Use all vectorize methods
  const results = await vectorizedPayload.search({
    query: 'search query',
    knowledgePool: 'main',
  })

  await vectorizedPayload.queueEmbed({
    collection: 'posts',
    docId: 'some-id',
  })

  await vectorizedPayload.bulkEmbed({
    knowledgePool: 'main',
  })
}
```

#### `vectorizedPayload.search(params)`

Perform vector search programmatically without making an HTTP request.

**Parameters:**

- `params.query` (required): Search query string
- `params.knowledgePool` (required): Knowledge pool identifier to search in
- `params.where` (optional): Payload-style `Where` clause evaluated against the embeddings collection + any `extensionFields`
- `params.limit` (optional): Maximum results to return (defaults to `10`)

**Returns:** `Promise<Array<VectorSearchResult>>`

**Example:**

```typescript
import { getVectorizedPayload } from 'payloadcms-vectorize'

const payload = await getPayload({ config, cron: true })
const vectorizedPayload = getVectorizedPayload<'main'>(payload)

if (vectorizedPayload) {
  const results = await vectorizedPayload.search({
    query: 'What is machine learning?',
    knowledgePool: 'main',
    where: {
      category: { equals: 'guides' },
    },
    limit: 5,
  })
}
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
import { getVectorizedPayload } from 'payloadcms-vectorize'

const payload = await getPayload({ config, cron: true })
const vectorizedPayload = getVectorizedPayload(payload)

if (vectorizedPayload) {
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
      content: {
        /* ... */
      },
    },
  })
}
```

#### `vectorizedPayload.bulkEmbed(params)`

Starts a bulk embedding run for a knowledge pool. This method queues a background job that will process all documents in the knowledge pool's collections, chunk them, and submit them to your embedding provider via the `bulkEmbeddingsFns.addChunk` callback.

**Parameters:**

- `params.knowledgePool` (required): The name of the knowledge pool to embed

**Returns:** `Promise<BulkEmbedResult>`

**Success Response:**

```typescript
{
  runId: string // ID of the created bulk embedding run
  status: 'queued' // Initial status of the run
}
```

**Conflict Response** (if a run is already active):

```typescript
{
  runId: string // ID of the existing active run
  status: 'queued' | 'running' // Status of the existing run
  message: string // Explanation of why a new run wasn't started
  conflict: true // Indicates a conflict occurred
}
```

**Example:**

```typescript
const result = await vectorizedPayload.bulkEmbed({ knowledgePool: 'default' })
if ('conflict' in result && result.conflict) {
  console.log('A run is already active:', result.message)
} else {
  console.log('Bulk embed started with run ID:', result.runId)
}
```

**Notes:**

- Only one bulk embedding run can be active per knowledge pool at a time
- The run will process documents that need embedding (those with mismatched `embeddingVersion` or new documents since the last successful run)
- Progress can be tracked via the `vector-bulk-embeddings-runs` and `vector-bulk-embeddings-batches` collections in the admin UI
- The run status will progress: `queued` → `running` → `succeeded` or `failed`

#### `vectorizedPayload.retryFailedBatch(params)`

Retries a failed batch from a bulk embedding run. This method reconstructs the chunks from the batch's metadata, resubmits them to your embedding provider, and creates a new batch record. The original batch is marked as `retried` and linked to the new batch.

**Parameters:**

- `params.batchId` (required): The ID of the failed batch to retry

**Returns:** `Promise<RetryFailedBatchResult>`

**Success Response:**

```typescript
{
  batchId: string        // ID of the batch being retried
  newBatchId: string     // ID of the newly created batch
  runId: string          // ID of the parent run
  status: 'queued'       // Status of the new batch
  message?: string       // Optional confirmation message
}
```

**Already Retried Response** (if batch was already retried):

```typescript
{
  batchId: string // ID of the original batch
  newBatchId: string // ID of the existing retry batch
  runId: string // ID of the parent run
  status: 'queued' // Status of the retry batch
  message: string // Message indicating batch was already retried
}
```

**Error Response:**

```typescript
{
  error: string          // Error message
  conflict?: true        // Present if error is due to a conflict (e.g., run still active)
}
```

**Example:**

```typescript
const result = await vectorizedPayload.retryFailedBatch({ batchId: '123' })
if ('error' in result) {
  console.error('Failed to retry batch:', result.error)
} else {
  console.log(`Batch ${result.batchId} retried. New batch ID: ${result.newBatchId}`)
}
```

**Notes:**

- Only batches with `failed` or `retried` status can be retried
- The parent run must be in a terminal state (`succeeded` or `failed`) - cannot retry while run is `queued` or `running`
- If the parent run was `succeeded` or `failed`, it will be reset to `running` status
- The original batch is marked as `retried` and linked to the new batch via the `retriedBatch` field
- Chunks are reconstructed from the batch's metadata, so metadata must still exist for the retry to work
- If a batch was already retried, calling this method again returns the existing retry batch instead of creating a duplicate

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for release history, migration notes, and upgrade guides.

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

- **MongoDB support**: Extend vector search capabilities to MongoDB databases
- **Vercel support**: Optimized deployment and configuration for Vercel hosting

**Want to see these features sooner?** Star this repository and open issues for the features you need most!
