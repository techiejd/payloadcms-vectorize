import { MongoClient } from 'mongodb'
import type { BasePayload } from 'payload'
import { __closeForTests } from '../../src/client.js'
import { __resetIndexCacheForTests } from '../../src/indexes.js'

/**
 * Minimal payload-shaped object that satisfies `getVectorizedPayload(payload).getDbAdapterCustom()`.
 *
 * `getVectorizedPayload` (src/types.ts) reads `payload.config.custom.createVectorizedPayloadObject`
 * and calls it with the payload to produce a `VectorizedPayload` whose `getDbAdapterCustom()`
 * returns the adapter's `getConfigExtension().custom`. We mirror that contract exactly.
 */
export function makeFakePayload(custom: Record<string, unknown>): BasePayload {
  const payload = {
    config: {
      custom: {
        createVectorizedPayloadObject: () => ({
          getDbAdapterCustom: () => custom,
        }),
      },
    },
    logger: {
      error: console.error.bind(console),
      info: console.log.bind(console),
    },
  } as unknown as BasePayload
  return payload
}

/** Spin up an admin client and drop the test DB. */
export async function dropTestDb(uri: string, dbName: string): Promise<void> {
  const c = new MongoClient(uri)
  try {
    await c.connect()
    await c.db(dbName).dropDatabase()
  } catch {
    // ignore — DB may not exist
  } finally {
    await c.close()
  }
}

export async function teardown(): Promise<void> {
  __resetIndexCacheForTests()
  await __closeForTests()
}
