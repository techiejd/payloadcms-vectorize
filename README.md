# PayloadCMS Vectorize

A Payload CMS plugin that adds vector search capabilities to your collections using PostgreSQL's pgvector extension. Perfect for building RAG (Retrieval-Augmented Generation) applications and semantic search features.

## Features

- 🔍 **Semantic Search**: Vectorize any collection field for intelligent content discovery
- 🚀 **Automatic Vectorization**: Documents are automatically vectorized when created or updated
- 📊 **PostgreSQL Integration**: Built on pgvector for high-performance vector operations
- ⚡ **Background Processing**: Uses Payload's job system for non-blocking vectorization
- 🎯 **Flexible Chunking**: You provide the custom chunkers for different field types (text, rich text, etc.)
- 🔧 **Configurable**: Choose which collections and fields to vectorize
- 🌐 **REST API**: Built-in vector-search endpoint for querying vectorized content
- 🏊 **Multiple Knowledge Pools**: Separate knowledge pools with independent configurations (dims, ivfflatLists, embedding functions)

## Prerequisites

- Only tested on Payload CMS 3.37.0+
- PostgreSQL with pgvector extension
- Node.js 18+

## Installation

```bash
pnpm add payloadcms-vectorize
```

## Quick Start

### 1. Install pgvector

Make sure your PostgreSQL database has the pgvector extension:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

### 2. Configure the Plugin

```typescript
import { buildConfig } from 'payload'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { createVectorizeIntegration } from 'payloadcms-vectorize'

// Configure your embedding functions
const embedDocs = async (texts: string[]) => {
  // Your embedding logic here
  return texts.map(text => /* vector array */)
}

const embedQuery = async (text: string,
  payload: Payload,) => {
  // Your query embedding logic here
  return /* vector array */
}

// Configure your chunking functions
const chunkText = async (text: string,
  payload: Payload) => {
  return /* string array */
}

// See examples under chunkers.ts
const chunkRichText = async (richText: SerializedEditorState,
  payload: Payload) => {
  return /* string array */
}

// Create the integration with static configs (dims, ivfflatLists)
const { afterSchemaInitHook, payloadcmsVectorize } = createVectorizeIntegration({
  // Note limitation: Changing these values is currently not supported.
  // Migration is necessary.
  main: {
    dims: 1536, // Vector dimensions
    ivfflatLists: 100, // IVFFLAT index parameter
  },
  // You can add more knowledge pools with different static configs
  // products: {
  //   dims: 384,
  //   ivfflatLists: 50,
  // },
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
      // Knowledge pools - dynamic configs (collections, embedding functions)
      knowledgePools: {
        main: {
          // The collection-fields you want vectorized in this pool
          collections: {
            posts: {
              fields: {
                title: { chunker: chunkText },
                content: { chunker: chunkRichText },
              },
            },
          },
          embedDocs,
          embedQuery,
          embeddingVersion: 'v1.0.0',
        },
        // You can add more knowledge pools with different dynamic configs
        // products: {
        //   collections: { ... },
        //   embedDocs: differentEmbedDocs,
        //   embedQuery: differentEmbedQuery,
        //   embeddingVersion: 'v2.0.0',
        // },
      },
      // Optional plugin options:
      // queueName: 'custom-queue',
      // endpointOverrides: {
      //   path: '/custom-vector-search',
      //   enabled: true,
      // },
      // disabled: false,
    }),
  ],
})
```

### 3. Search Your Content

The plugin automatically creates a `/api/vector-search` endpoint:

```typescript
const response = await fetch('/api/vector-search', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: 'What is machine learning?', // Required: query
    knowledgePool: 'main', // Required: specify which knowledge pool to search
  }),
})

const results = await response.json()
// Returns: { results: [{ id, similarity, sourceCollection, docId, fieldPath, chunkText, ... }] }
```

## Configuration Options

### Plugin Options

| Option              | Type                                         | Required | Description                              |
| ------------------- | -------------------------------------------- | -------- | ---------------------------------------- |
| `knowledgePools`    | `Record<KnowledgePool, KnowledgePoolConfig>` | ✅       | Knowledge pools and their configurations |
| `queueName`         | `string`                                     | ❌       | Custom queue name for background jobs    |
| `endpointOverrides` | `object`                                     | ❌       | Customize the search endpoint            |
| `disabled`          | `boolean`                                    | ❌       | Disable plugin while keeping schema      |

### Knowledge Pool Config

Knowledge pools are configured in two steps. The static configs define the database schema (migration required), while dynamic configs define runtime behavior (no migration required).

**1. Static Config** (passed to `createVectorizeIntegration`):

- `dims`: `number` - Vector dimensions for pgvector column
- `ivfflatLists`: `number` - IVFFLAT index parameter

The embeddings collection name will be the same as the knowledge pool name.

**2. Dynamic Config** (passed to `payloadcmsVectorize`):

- `collections`: `Record<string, CollectionVectorizeOption>` - Collections and fields to vectorize
- `embedDocs`: `EmbedDocsFn` - Function to embed multiple documents
- `embedQuery`: `EmbedQueryFn` - Function to embed search queries
- `embeddingVersion`: `string` - Version string for tracking model changes

## Chunkers

The plugin includes examples chunkers for common field types:
// Not yet provided publicly because maintenance is not guaranteed

- `chunkText`: For plain text fields
- `chunkRichText`: For Lexical rich text fields

You must create (or copy) custom chunkers:

```typescript
const customChunker = async (value: any, payload: Payload) => {
  // Your custom chunking logic
  return ['chunk1', 'chunk2', 'chunk3']
}
```

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

```json
{
  "query": "Your search query",
  "knowledgePool": "main"
}
```

**Parameters:**

- `query` (required): The search query string
- `knowledgePool` (required): The knowledge pool identifier to search in

**Response:**

```json
{
  "results": [
    {
      "id": "embedding_id",
      "similarity": 0.85,
      "sourceCollection": "posts",
      "docId": "post_id",
      "fieldPath": "content",
      "chunkIndex": 0,
      "chunkText": "Relevant text chunk",
      "embeddingVersion": "v1.0.0"
    }
  ]
}
```

## Migration from v0.1.0 to v0.2.0

Version 0.2.0 introduces support for multiple knowledge pools. This is a **breaking change** that requires updating your configuration.

### Before (v0.1.0):

```typescript
const { afterSchemaInitHook, payloadcmsVectorize } = createVectorizeIntegration({
  dims: 1536,
  ivfflatLists: 100,
})

payloadcmsVectorize({
  collections: {
    posts: { fields: { ... } },
  },
  embedDocs,
  embedQuery,
  embeddingVersion: 'v1.0.0',
})
```

### After (v0.2.0):

```typescript
// Static configs (schema-related) passed to createVectorizeIntegration
const { afterSchemaInitHook, payloadcmsVectorize } = createVectorizeIntegration({
  main: {
    dims: 1536,
    ivfflatLists: 100,
  },
})

// Dynamic configs (runtime behavior) passed to payloadcmsVectorize
payloadcmsVectorize({
  knowledgePools: {
    main: {
      collections: {
        posts: { fields: { ... } },
      },
      embedDocs,
      embedQuery,
      embeddingVersion: 'v1.0.0',
    },
  },
})
```

### API Changes

The vector search endpoint now requires a `knowledgePool` parameter:

```typescript
// Before
{ query: 'search term' }

// After
{ query: 'search term', knowledgePool: 'main' }
```

### Benefits of Multiple Knowledge Pools

- **Separate knowledge domains**: Keep different types of content in separate pools
- **Different technical requirements**: Each pool can have different `dims`, `ivfflatLists`, and embedding functions
- **Flexible organization**: Collections can appear in multiple pools if needed
- **Independent versioning**: Each pool can track its own embedding model version

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

The following features are planned for future releases based on community interest and stars:

- **Migrations for vector dimensions**: Easy migration tools for changing vector dimensions and/or ivfflatLists after initial setup
- **MongoDB support**: Extend vector search capabilities to MongoDB databases
- **Vercel support**: Optimized deployment and configuration for Vercel hosting
- **Batch embedding**: More efficient bulk embedding operations for large datasets
- **'Embed all' button**: Admin UI button to re-embed all content after embeddingVersion changes
- **More expressive queries**: Add ability to change query limit, search on certain collections or certain fields.

**Want to see these features sooner?** Star this repository and open issues for the features you need most!
