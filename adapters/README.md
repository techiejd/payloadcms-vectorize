# PayloadCMS Vectorize - Database Adapters

The `payloadcms-vectorize` plugin uses a database adapter architecture to support different database backends for vector storage and search. This document explains how adapters work and how to create your own.

## Available Adapters

| Adapter | Package | Database |
|---------|---------|----------|
| PostgreSQL | `@payloadcms-vectorize/pg` | PostgreSQL with pgvector |

## DbAdapter Interface

All database adapters must implement the `DbAdapter` interface exported from `payloadcms-vectorize`:

```typescript
import type { Config, BasePayload, Payload, Where } from 'payload'
import type { KnowledgePoolName, VectorSearchResult } from 'payloadcms-vectorize'

export type DbAdapter = {
  /**
   * Extends the Payload config with adapter-specific configuration.
   * Called during plugin initialization.
   *
   * @param payloadCmsConfig - The Payload CMS config object
   * @returns Configuration extension with optional bins (CLI commands) and custom data
   */
  getConfigExtension: (payloadCmsConfig: Config) => {
    bins?: { key: string; scriptPath: string }[]
    custom?: Record<string, any>
  }

  /**
   * Performs a vector search.
   *
   * @param payload - The Payload instance
   * @param queryEmbedding - The query vector to search for
   * @param poolName - The knowledge pool to search in
   * @param limit - Maximum number of results (optional)
   * @param where - Payload-style where clause for filtering (optional)
   * @returns Array of search results with relevance scores
   */
  search: (
    payload: BasePayload,
    queryEmbedding: number[],
    poolName: KnowledgePoolName,
    limit?: number,
    where?: Where,
  ) => Promise<Array<VectorSearchResult>>

  /**
   * Stores an embedding vector for a document chunk.
   *
   * @param payload - The Payload instance
   * @param poolName - The knowledge pool to store in
   * @param id - The embedding record ID
   * @param embedding - The vector to store
   */
  storeEmbedding: (
    payload: Payload,
    poolName: KnowledgePoolName,
    id: string,
    embedding: number[] | Float32Array,
  ) => Promise<void>
}
```

## Creating a Custom Adapter

To create a custom adapter for a new database backend:

### 1. Create the adapter package

```
my-adapter/
├── src/
│   ├── index.ts      # Main entry point, exports integration factory
│   ├── search.ts     # Vector search implementation
│   └── embed.ts      # Embedding storage implementation (storeEmbedding)
├── package.json
└── README.md
```

### 2. Implement the integration factory

Your adapter should export a factory function that returns:
- Any database-specific hooks (e.g., schema initialization)
- The `DbAdapter` implementation

```typescript
import type { DbAdapter } from 'payloadcms-vectorize'

export type MyAdapterConfig = {
  [poolName: string]: {
    dims: number
    // ... other database-specific options
  }
}

export const createMyVectorIntegration = (
  config: MyAdapterConfig,
): {
  // Database-specific hooks (optional)
  someHook?: SomeHookType
  // Required: the adapter implementation
  adapter: DbAdapter
} => {
  const adapter: DbAdapter = {
    getConfigExtension: (payloadCmsConfig) => {
      return {
        // Optional: register CLI commands
        bins: [
          {
            key: 'vectorize:my-command',
            scriptPath: '/path/to/script.js',
          },
        ],
        // Optional: store adapter-specific data
        custom: {
          _staticConfigs: config,
        },
      }
    },

    search: async (payload, queryEmbedding, poolName, limit, where) => {
      // Implement vector search for your database
      // Must return Array<VectorSearchResult>
    },

    storeEmbedding: async (payload, poolName, id, embedding) => {
      // Implement embedding storage for your database
    },
  }

  return { adapter }
}
```

### 3. Define peer dependencies

Your adapter should have peer dependencies on:
- `payload` - The Payload CMS package
- `payloadcms-vectorize` - The vectorize plugin
- Your database adapter (e.g., `@payloadcms/db-mongodb`)

```json
{
  "peerDependencies": {
    "payload": ">=3.0.0 <4.0.0",
    "payloadcms-vectorize": ">=0.5.4 <1.0.0",
    "@payloadcms/db-your-db": ">=3.0.0 <4.0.0"
  }
}
```

### 4. Usage in Payload config

Users will use your adapter like this:

```typescript
import { buildConfig } from 'payload'
import { myDbAdapter } from '@payloadcms/db-my-db'
import { createMyVectorIntegration } from 'my-vectorize-adapter'
import payloadcmsVectorize from 'payloadcms-vectorize'

const integration = createMyVectorIntegration({
  default: {
    dims: 1536,
    // ... other options
  },
})

export default buildConfig({
  db: myDbAdapter({
    // ... your database config
    // Include any hooks from the integration if needed
  }),
  plugins: [
    payloadcmsVectorize({
      dbAdapter: integration.adapter,
      knowledgePools: {
        default: {
          // ... pool config
        },
      },
    }),
  ],
})
```

## VectorSearchResult Type

The `search` method must return results conforming to this type:

```typescript
export type VectorSearchResult = {
  /** The embedding record ID */
  id: string
  /** Relevance score (higher = more relevant). Range depends on adapter implementation. */
  score: number
  /** Source collection slug */
  sourceCollection: string
  /** Source document ID */
  docId: string
  /** Chunk index within the document */
  chunkIndex: number
  /** The text content of the chunk */
  chunkText: string
  /** Embedding version string */
  embeddingVersion: string
  /** Any extension field values */
  [key: string]: any
}
```

## Contributing

Want to add support for a new database? We welcome contributions! Please open an issue first to discuss the implementation approach.
