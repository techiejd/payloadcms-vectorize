# PayloadCMS Vectorize

A Payload CMS plugin that adds vector search capabilities to your collections using PostgreSQL's pgvector extension. Perfect for building RAG (Retrieval-Augmented Generation) applications and semantic search features.

## Features

- 🔍 **Semantic Search**: Vectorize any collection for intelligent content discovery
- 🚀 **Automatic**: Documents are automatically vectorized when created or updated, and vectors are deleted as soon as the document is deleted.
- 📊 **PostgreSQL Integration**: Built on pgvector for high-performance vector operations
- ⚡ **Background Processing**: Uses Payload's job system for non-blocking vectorization
- 🎯 **Flexible Chunking**: Drive chunk creation yourself with `toKnowledgePool` functions so you can combine any fields or content types
- 🧩 **Extensible Schema**: Attach custom `extensionFields` to the embeddings collection and persist values per chunk and use for querying.
- 🌐 **REST API**: Built-in vector-search endpoint with Payload-style `where` filtering and configurable limits
- 🏊 **Multiple Knowledge Pools**: Separate knowledge pools with independent configurations (dims, ivfflatLists, embedding functions) and needs.

## Prerequisites

- Only tested on Payload CMS 3.37.0+
- PostgreSQL with pgvector extension
- Node.js 18+

## Installation

```bash
pnpm add payloadcms-vectorize
```

## Quick Start

### 0. Install pgvector

The plugin automatically creates the `vector` extension when Payload initializes. However, your PostgreSQL database user must have permission to create extensions. If your user doesn't have these permissions, you may need to manually create the extension once:

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

| Option              | Type                                                | Required | Description                              |
| ------------------- | --------------------------------------------------- | -------- | ---------------------------------------- |
| `knowledgePools`    | `Record<KnowledgePool, KnowledgePoolDynamicConfig>` | ✅       | Knowledge pools and their configurations |
| `queueName`         | `string`                                            | ❌       | Custom queue name for background jobs    |
| `endpointOverrides` | `object`                                            | ❌       | Customize the search endpoint            |
| `disabled`          | `boolean`                                           | ❌       | Disable plugin while keeping schema      |

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

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for release history, migration notes, and upgrade guides.

## Requirements

- Payload CMS ^3.37.0
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

The following features are planned for future releases based on community interest and stars:

- **Migrations for vector dimensions**: Easy migration tools for changing vector dimensions and/or ivfflatLists after initial setup
- **MongoDB support**: Extend vector search capabilities to MongoDB databases
- **Vercel support**: Optimized deployment and configuration for Vercel hosting
- **Batch embedding**: More efficient bulk embedding operations for large datasets
- **'Embed all' button**: Admin UI button to re-embed all content after embeddingVersion changes

**Want to see these features sooner?** Star this repository and open issues for the features you need most!
