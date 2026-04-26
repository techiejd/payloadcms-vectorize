import { MongoClient } from 'mongodb'
import { buildConfig, getPayload } from 'payload'
import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import payloadcmsVectorize from 'payloadcms-vectorize'
import type { BasePayload, CollectionConfig } from 'payload'
import type { KnowledgePoolDynamicConfig } from 'payloadcms-vectorize'

export type KnowledgePoolsConfig = Record<string, KnowledgePoolDynamicConfig>
import { __closeForTests } from '../../src/client.js'
import { __resetIndexCacheForTests } from '../../src/indexes.js'
import { createMongoVectorIntegration } from '../../src/index.js'
import type { MongoVectorIntegrationConfig } from '../../src/types.js'

export interface BuildMongoTestPayloadArgs {
  uri: string
  dbName: string
  pools: MongoVectorIntegrationConfig['pools']
  collections?: CollectionConfig[]
  knowledgePools: KnowledgePoolsConfig
}

export async function buildMongoTestPayload(args: BuildMongoTestPayloadArgs): Promise<{
  payload: BasePayload
  adapter: ReturnType<typeof createMongoVectorIntegration>['adapter']
}> {
  const vectorDbName = `${args.dbName}_vectors`

  await dropTestDb(args.uri, args.dbName)
  await dropTestDb(args.uri, vectorDbName)

  const { adapter } = createMongoVectorIntegration({
    uri: args.uri,
    dbName: vectorDbName,
    pools: args.pools,
  })

  const config = await buildConfig({
    secret: 'test-secret',
    editor: lexicalEditor(),
    collections: args.collections ?? [],
    db: mongooseAdapter({ url: injectDbName(args.uri, args.dbName) }),
    plugins: [
      payloadcmsVectorize({
        dbAdapter: adapter,
        knowledgePools: args.knowledgePools,
      }),
    ],
  })

  const payload = await getPayload({
    config,
    key: `mongodb-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    cron: false,
  })
  return { payload, adapter }
}

/**
 * Insert a database name into a Mongo connection string between the host
 * and the optional query string. Requires a path-less URI (host[:port] only,
 * optionally followed by `?query`). Throws on URIs that already carry a path
 * component (e.g. `mongodb+srv://cluster/myapp`) — concatenating onto those
 * silently produces an invalid double-path URI like `.../myapp/test`.
 */
function injectDbName(uri: string, dbName: string): string {
  const queryIdx = uri.indexOf('?')
  const base = queryIdx === -1 ? uri : uri.slice(0, queryIdx)
  const query = queryIdx === -1 ? '' : uri.slice(queryIdx)
  const schemeEnd = base.indexOf('://')
  const afterScheme = schemeEnd === -1 ? base : base.slice(schemeEnd + 3)
  const slashIdx = afterScheme.indexOf('/')
  if (slashIdx !== -1 && afterScheme.slice(slashIdx + 1).replace(/\/+$/, '').length > 0) {
    throw new Error(
      `[buildMongoTestPayload] Mongo URI must be path-less (host[:port] only); got ${uri}. ` +
        `Strip the default-DB path before passing in.`,
    )
  }
  const baseNoSlash = base.replace(/\/+$/, '')
  return `${baseNoSlash}/${dbName}${query}`
}

export async function dropTestDb(uri: string, dbName: string): Promise<void> {
  const c = new MongoClient(uri)
  try {
    await c.connect()
    await c.db(dbName).dropDatabase()
  } catch {
    // ignore
  } finally {
    await c.close()
  }
}

/**
 * Tear down a booted test payload + both databases + module caches.
 *
 * Mirrors the pg adapter's `destroyPayload` pattern: destroying the payload
 * instance closes the Mongoose connection opened by `mongooseAdapter`. Without
 * this, each spec leaks a live Mongoose connection and the suite eventually
 * exhausts the pool.
 */
export async function teardownDbs(
  payload: BasePayload,
  uri: string,
  dbName: string,
): Promise<void> {
  try {
    await payload.destroy()
  } catch {
    // ignore — destroy is best-effort during teardown
  }
  await dropTestDb(uri, dbName)
  await dropTestDb(uri, `${dbName}_vectors`)
  __resetIndexCacheForTests()
  await __closeForTests()
}
