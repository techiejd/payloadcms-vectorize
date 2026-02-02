# @payloadcms-vectorize/cf

Cloudflare Vectorize adapter for [payloadcms-vectorize](https://github.com/techiejd/payloadcms-vectorize). Enables vector search capabilities using Cloudflare Vectorize.

## Prerequisites

- Cloudflare account with Vectorize index configured
- Payload CMS 3.x with any supported database adapter
- Node.js 18+

## Installation

```bash
pnpm add @payloadcms-vectorize/cf payloadcms-vectorize
```

## Quick Start

### 1. Create Vectorize Index

Create a Vectorize index in your Cloudflare dashboard or via Wrangler:

```bash
wrangler vectorize create my-vectorize-index --dimensions=384 --metric=cosine
```

### 2. Configure the Plugin

```typescript
import { buildConfig } from 'payload'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { createCloudflareVectorizeIntegration } from '@payloadcms-vectorize/cf'
import payloadcmsVectorize from 'payloadcms-vectorize'

// Create the integration
const integration = createCloudflareVectorizeIntegration(
  {
    default: {
      dims: 384, // Vector dimensions (must match your embedding model and Vectorize index)
    },
  },
  {
    vectorize: env.VECTORIZE, // Cloudflare Vectorize binding
  },
)

export default buildConfig({
  // ... your existing config
  db: postgresAdapter({
    pool: {
      connectionString: process.env.DATABASE_URL,
    },
  }),
  plugins: [
    payloadcmsVectorize({
      dbAdapter: integration.adapter,
      knowledgePools: {
        default: {
          collections: {
            posts: {
              toKnowledgePool: async (doc) => [{ chunk: doc.title || '' }],
            },
          },
          embeddingConfig: {
            version: 'v1.0.0',
            queryFn: embedQuery,
            realTimeIngestionFn: embedDocs,
          },
        },
      },
    }),
  ],
})
```

## Configuration

The `createCloudflareVectorizeIntegration` function accepts a configuration object where each key is a knowledge pool name:

```typescript
const integration = createCloudflareVectorizeIntegration(
  {
    poolName: {
      dims: number, // Required: Vector dimensions
    },
    // ... additional pools
  },
  {
    vectorize: binding, // Cloudflare Vectorize binding
  },
)
```

### Configuration Options

| Option | Type     | Required | Description                                                                                                                                       |
| ------ | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dims` | `number` | Yes      | Vector dimensions for the Vectorize index. Must match your embedding model's output dimensions and your Cloudflare Vectorize index configuration. |

### Cloudflare Bindings

| Property    | Type             | Required | Description                                                                                       |
| ----------- | ---------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `vectorize` | `VectorizeIndex` | Yes      | Cloudflare Vectorize binding for vector storage. Configured in `wrangler.toml` for Workers/Pages. |

## Integration Return Value

`createCloudflareVectorizeIntegration` returns an object with:

| Property  | Type        | Description                                                               |
| --------- | ----------- | ------------------------------------------------------------------------- |
| `adapter` | `DbAdapter` | The database adapter to pass to `payloadcmsVectorize({ dbAdapter: ... })` |

## Multiple Knowledge Pools

You can configure multiple knowledge pools with different dimensions:

```typescript
const integration = createCloudflareVectorizeIntegration(
  {
    documents: {
      dims: 1536,
    },
    images: {
      dims: 512,
    },
  },
  {
    vectorize: env.VECTORIZE,
  },
)

export default buildConfig({
  // ...
  plugins: [
    payloadcmsVectorize({
      dbAdapter: integration.adapter,
      knowledgePools: {
        documents: {
          collections: {
            /* ... */
          },
          embeddingConfig: {
            /* ... */
          },
        },
        images: {
          collections: {
            /* ... */
          },
          embeddingConfig: {
            /* ... */
          },
        },
      },
    }),
  ],
})
```

**Note:** Each knowledge pool requires a separate Vectorize index with matching dimensions.

## Using with Cloudflare AI

```typescript
export const embedDocs = async (texts: string[]): Promise<number[][]> => {
  const results = await Promise.all(
    texts.map((text) =>
      env.AI.run('@cf/baai/bge-small-en-v1.5', {
        text,
      }),
    ),
  )
  return results.map((r) => r.data[0])
}

export const embedQuery = async (text: string): Promise<number[]> => {
  const result = await env.AI.run('@cf/baai/bge-small-en-v1.5', {
    text,
  })
  return result.data[0]
}
```

## Using with Voyage AI

```typescript
import { embed, embedMany } from 'ai'
import { voyage } from 'voyage-ai-provider'

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

## License

MIT
