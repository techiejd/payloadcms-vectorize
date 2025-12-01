import type { Payload, SanitizedConfig } from 'payload'

import { buildConfig, getPayload } from 'payload'
import { beforeAll, describe, expect, test } from 'vitest'
import { createVectorizeIntegration } from 'payloadcms-vectorize'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { createTestDb } from './utils.js'
import type { PostgresPayload } from '../../src/types.js'

const DIMS_POOL1 = 8
const DIMS_POOL2 = 16

describe('Multiple knowledge pools', () => {
  let config: SanitizedConfig
  let payload: Payload
  const dbName = 'multipools_test'

  beforeAll(async () => {
    await createTestDb({ dbName })

    const multiPoolIntegration = createVectorizeIntegration({
      pool1: {
        dims: DIMS_POOL1,
        ivfflatLists: 1,
      },
      pool2: {
        dims: DIMS_POOL2,
        ivfflatLists: 2,
      },
    })

    const multiPoolPluginOptions = {
      knowledgePools: {
        pool1: {
          collections: {},
          embedDocs: async (texts: string[]) => texts.map(() => new Array(DIMS_POOL1).fill(0)),
          embedQuery: async () => new Array(DIMS_POOL1).fill(0),
          embeddingVersion: 'test-pool1',
        },
        pool2: {
          collections: {},
          embedDocs: async (texts: string[]) => texts.map(() => new Array(DIMS_POOL2).fill(0)),
          embedQuery: async () => new Array(DIMS_POOL2).fill(0),
          embeddingVersion: 'test-pool2',
        },
      },
    }

    config = await buildConfig({
      secret: 'test-secret',
      collections: [],
      editor: lexicalEditor(),
      db: postgresAdapter({
        extensions: ['vector'],
        afterSchemaInit: [multiPoolIntegration.afterSchemaInitHook],
        pool: {
          connectionString: `postgresql://postgres:password@localhost:5433/${dbName}`,
        },
      }),
      plugins: [multiPoolIntegration.payloadcmsVectorize(multiPoolPluginOptions)],
    })

    payload = await getPayload({ config })
  })

  test('creates two embeddings collections with vector columns', async () => {
    const collections = payload.collections
    expect(collections).toHaveProperty('pool1')
    expect(collections).toHaveProperty('pool2')

    const db = (payload as PostgresPayload).db
    const schemaName = db.schemaName || 'public'
    const tablesRes = await db.pool?.query(
      `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = '${schemaName}'
          AND table_name IN ('pool1', 'pool2')
      `,
    )

    expect(tablesRes?.rowCount).toBe(2)

    const columnsRes = await db.pool?.query(
      `
        SELECT table_name, column_name, udt_name
        FROM information_schema.columns
        WHERE table_schema = '${schemaName}'
          AND table_name IN ('pool1', 'pool2')
          AND column_name = 'embedding'
      `,
    )

    expect(columnsRes?.rowCount).toBe(2)
    columnsRes?.rows.forEach((row: { udt_name: string }) => {
      expect(row.udt_name).toBe('vector')
    })
  })
})
