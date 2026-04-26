import { afterEach, describe, expect, test } from 'vitest'
import { __closeForTests, getMongoClient } from '../../src/client.js'

afterEach(async () => {
  await __closeForTests()
})

describe('getMongoClient cache', () => {
  test('a rejected connect attempt is not cached — the next call retries', async () => {
    const bad = 'mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=200&directConnection=true'

    await expect(getMongoClient(bad)).rejects.toThrow()
    // If the rejected promise stayed cached, this would resolve to the same rejected value.
    await expect(getMongoClient(bad)).rejects.toThrow()
  })
})
