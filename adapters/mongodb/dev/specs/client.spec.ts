import { MongoClient } from 'mongodb'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { __closeForTests, getMongoClient } from '../../src/client.js'

afterEach(async () => {
  vi.restoreAllMocks()
  await __closeForTests()
})

describe('getMongoClient cache', () => {
  test('a rejected connect attempt is not cached — the next call retries (verified by connect call count)', async () => {
    const bad = 'mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=200&directConnection=true'
    const connectSpy = vi.spyOn(MongoClient, 'connect')

    await expect(getMongoClient(bad)).rejects.toThrow()
    await expect(getMongoClient(bad)).rejects.toThrow()

    expect(connectSpy).toHaveBeenCalledTimes(2)
  })
})
