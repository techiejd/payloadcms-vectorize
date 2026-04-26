import { MongoClient } from 'mongodb'

const clientCache = new Map<string, Promise<MongoClient>>()

export function getMongoClient(uri: string): Promise<MongoClient> {
  let p = clientCache.get(uri)
  if (!p) {
    p = MongoClient.connect(uri).catch((err) => {
      clientCache.delete(uri)
      throw err
    })
    clientCache.set(uri, p)
  }
  return p
}

/**
 * Test-only helper. NOT exported from `index.ts` — referenced by the dev test
 * suites via deep import to avoid leaking into the published API.
 */
export async function __closeForTests(): Promise<void> {
  const promises = Array.from(clientCache.values())
  clientCache.clear()
  for (const p of promises) {
    try {
      const c = await p
      await c.close()
    } catch {
      // ignore; client may not have connected
    }
  }
}
