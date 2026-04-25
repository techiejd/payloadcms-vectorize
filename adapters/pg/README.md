# @payloadcms-vectorize/pg

[![npm version](https://img.shields.io/npm/v/@payloadcms-vectorize/pg.svg)](https://www.npmjs.com/package/@payloadcms-vectorize/pg)
[![npm downloads](https://img.shields.io/npm/dm/@payloadcms-vectorize/pg.svg)](https://www.npmjs.com/package/@payloadcms-vectorize/pg)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](#license)
[![Payload CMS](https://img.shields.io/badge/Payload-3.x-000000.svg)](https://payloadcms.com)

PostgreSQL adapter for [payloadcms-vectorize](https://github.com/techiejd/payloadcms-vectorize). Enables vector search capabilities using PostgreSQL's pgvector extension.

> **Status:** `0.x` — pre-1.0. The public API is stabilizing but may still have breaking changes between minor releases. Track the [CHANGELOG](./CHANGELOG.md) before upgrading.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Static Configuration](#static-configuration)
- [Integration Return Value](#integration-return-value)
- [Migrations](#migrations)
- [PostgreSQL Custom Schema Support](#postgresql-custom-schema-support)
- [Multiple Knowledge Pools](#multiple-knowledge-pools)
- [Using with Voyage AI](#using-with-voyage-ai)
- [Contributing](#contributing)
- [Changelog](#changelog)
- [License](#license)

## Prerequisites

- PostgreSQL with the [pgvector](https://github.com/pgvector/pgvector) extension available.
- Payload CMS `3.x` with `@payloadcms/db-postgres` (peer-dep range: `>=3.0.0 <4.0.0`).
- `payloadcms-vectorize` matching this adapter's version (peer-dep range: `>=0.7.2`).
- Node.js `^18.20.2` or `>=20.9.0`.

## Installation

```bash
pnpm add @payloadcms-vectorize/pg payloadcms-vectorize
```

## Quick Start

### 1. Ensure pgvector permissions

The plugin expects the `vector` extension to be configured when Payload initializes. Your PostgreSQL database user must have permission to create extensions. If your user doesn't have these permissions, someone with permissions may need to manually create the extension once:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

**Note:** Most managed PostgreSQL services (like AWS RDS, Supabase, etc.) require superuser privileges or specific extension permissions. If you encounter permission errors, contact your database administrator or check your service's documentation.

### 2. Define your embedding functions

The plugin needs two functions: `embedQuery` (used at search time) and `embedDocs` (used at ingestion time). They must produce vectors whose length matches the `dims` you configure below. See [Using with Voyage AI](#using-with-voyage-ai) for a complete example, or supply any function with the same shape.

### 3. Configure the Plugin

```typescript
import { buildConfig } from 'payload'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { createPostgresVectorIntegration } from '@payloadcms-vectorize/pg'
import payloadcmsVectorize from 'payloadcms-vectorize'
import { embedQuery, embedDocs } from './embeddings' // see "Using with Voyage AI" below

// Create the integration with static configs (dims, ivfflatLists)
const integration = createPostgresVectorIntegration({
  // Note: Changing dims requires a migration with TRUNCATE.
  // Changing ivfflatLists rebuilds the index (non-destructive).
  default: {
    dims: 1536,        // Vector dimensions (must match your embedding model)
    ivfflatLists: 100, // IVFFLAT index parameter
  },
})

export default buildConfig({
  // ... your existing config
  db: postgresAdapter({
    // Configure the 'vector' extension
    extensions: ['vector'],
    // afterSchemaInitHook adds vector columns and IVFFLAT indexes to your schema
    afterSchemaInit: [integration.afterSchemaInitHook],
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

## Static Configuration

The `createPostgresVectorIntegration` function accepts a configuration object where each key is a knowledge pool name:

```typescript
const integration = createPostgresVectorIntegration({
  poolName: {
    dims: number,        // Required: Vector dimensions
    ivfflatLists: number // Required: IVFFLAT index lists parameter
  },
  // ... additional pools
})
```

### Configuration Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `dims` | `number` | Yes | Vector dimensions for the pgvector column. Must match your embedding model's output dimensions. |
| `ivfflatLists` | `number` | Yes | Number of lists for the IVFFLAT index. Higher values = faster queries but slower index builds. Recommended: `sqrt(num_rows)` to `num_rows / 1000`. |

## Integration Return Value

`createPostgresVectorIntegration` returns an object with:

| Property | Type | Description |
|----------|------|-------------|
| `afterSchemaInitHook` | Function | Hook for `postgresAdapter.afterSchemaInit` that adds vector columns and IVFFLAT indexes |
| `adapter` | `DbAdapter` | The database adapter to pass to `payloadcmsVectorize({ dbAdapter: ... })` |

## Migrations

### Initial Setup

After configuring the plugin, create and apply your initial migration. The IVFFLAT indexes are created automatically via the `afterSchemaInitHook` using Drizzle's `extraConfig`.

```bash
# Create migration (includes embedding columns and IVFFLAT indexes)
pnpm payload migrate:create --name initial

# Review the migration file in src/migrations/

# Apply the migration
pnpm payload migrate
```

### Changing `ivfflatLists`

Changing `ivfflatLists` is **non-destructive**. Simply update the config and create a new migration:

```bash
pnpm payload migrate:create --name update_ivfflat_lists
pnpm payload migrate
```

Drizzle will automatically generate SQL to rebuild the index with the new lists parameter.

### Changing `dims` (Destructive)

**Warning:** Changing `dims` is **DESTRUCTIVE** - it requires truncating the embeddings table and re-embedding all your data.

1. Update your static config with the new `dims` value

2. Create a migration:
   ```bash
   pnpm payload migrate:create --name change_dims
   ```

3. Run the vectorize:migrate CLI to add the TRUNCATE statement:
   ```bash
   pnpm payload vectorize:migrate
   ```

   The CLI will:
   - Detect the dims change
   - Patch the migration with `TRUNCATE TABLE ... CASCADE`
   - Add appropriate down migration to restore the old column type

4. Review the migration file

5. Apply the migration:
   ```bash
   pnpm payload migrate
   ```

6. Re-embed all documents using the bulk embed feature

### Schema Name Qualification

The CLI automatically uses the `schemaName` from your Postgres adapter configuration. If you use a custom schema (e.g., `postgresAdapter({ schemaName: 'custom' })`), all SQL in the migration will be properly qualified with that schema name.

### Idempotency

Running `pnpm payload vectorize:migrate` multiple times with no config changes will not create duplicate migrations. The CLI detects when no changes are needed and exits early.

## PostgreSQL Custom Schema Support

The adapter reads the `schemaName` configuration from your Postgres adapter.

When you configure a custom schema via `postgresAdapter({ schemaName: 'custom' })`, all plugin SQL queries (for vector columns, indexes, and embeddings) are qualified with that schema name. This is useful for multi-tenant setups or when content tables live in a dedicated schema.

Where `schemaName` is not specified, the adapter falls back to `public` as is the default adapter behaviour.

## Multiple Knowledge Pools

You can configure multiple knowledge pools with different dimensions and index parameters:

```typescript
const integration = createPostgresVectorIntegration({
  documents: {
    dims: 1536,
    ivfflatLists: 100,
  },
  images: {
    dims: 512,
    ivfflatLists: 50,
  },
})

export default buildConfig({
  db: postgresAdapter({
    extensions: ['vector'],
    afterSchemaInit: [integration.afterSchemaInitHook],
    // ...
  }),
  plugins: [
    payloadcmsVectorize({
      dbAdapter: integration.adapter,
      knowledgePools: {
        documents: {
          collections: { /* ... */ },
          embeddingConfig: { /* ... */ },
        },
        images: {
          collections: { /* ... */ },
          embeddingConfig: { /* ... */ },
        },
      },
    }),
  ],
})
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

## Contributing

Issues and PRs are welcome. The repo lives at [github.com/techiejd/payloadcms-vectorize](https://github.com/techiejd/payloadcms-vectorize) — please open an issue before sending a non-trivial PR so we can align on the approach.

For local development, see the root [README](../../README.md) and [docs/](../../docs/).

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for release notes. Releases are managed by [Changesets](https://github.com/changesets/changesets) — when contributing, run `pnpm changeset` to describe your change.

## License

[MIT](../../LICENSE)
