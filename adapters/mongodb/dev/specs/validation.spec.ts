import { describe, expect, test } from 'vitest'
import type { BasePayload } from 'payload'
import { createMongoVectorIntegration } from '../../src/index.js'
import type { MongoVectorIntegrationConfig } from '../../src/types.js'

const VALID: MongoVectorIntegrationConfig = {
  uri: 'mongodb://localhost:27017',
  dbName: 'test',
  pools: { default: { dimensions: 8 } },
}

const dummyPayload = {} as BasePayload

describe('createMongoVectorIntegration validation is deferred to call-time', () => {
  describe('construction does not throw on missing/invalid config', () => {
    test('missing uri', () => {
      expect(() =>
        createMongoVectorIntegration({ ...VALID, uri: undefined as any }),
      ).not.toThrow()
    })

    test('missing dbName', () => {
      expect(() =>
        createMongoVectorIntegration({ ...VALID, dbName: undefined as any }),
      ).not.toThrow()
    })

    test('empty pools', () => {
      expect(() => createMongoVectorIntegration({ ...VALID, pools: {} })).not.toThrow()
    })

    test('missing pools', () => {
      expect(() =>
        createMongoVectorIntegration({ ...VALID, pools: undefined as any }),
      ).not.toThrow()
    })

    test('invalid dimensions', () => {
      expect(() =>
        createMongoVectorIntegration({ ...VALID, pools: { default: { dimensions: 0 } } }),
      ).not.toThrow()
    })
  })

  describe('getConfigExtension does not throw at config-build time', () => {
    test('with fully missing config', () => {
      const { adapter } = createMongoVectorIntegration({
        uri: undefined as any,
        dbName: undefined as any,
        pools: undefined as any,
      })
      expect(() => adapter.getConfigExtension({} as any)).not.toThrow()
    })
  })

  describe('adapter methods throw at call-time when config is missing/invalid', () => {
    test('missing uri', async () => {
      const { adapter } = createMongoVectorIntegration({ ...VALID, uri: undefined as any })
      await expect(
        adapter.hasEmbeddingVersion(dummyPayload, 'default', 'col', 'doc-1', 'v1'),
      ).rejects.toThrow(/`uri` is required/)
    })

    test('missing dbName', async () => {
      const { adapter } = createMongoVectorIntegration({ ...VALID, dbName: undefined as any })
      await expect(
        adapter.hasEmbeddingVersion(dummyPayload, 'default', 'col', 'doc-1', 'v1'),
      ).rejects.toThrow(/`dbName` is required/)
    })

    test('empty pools', async () => {
      const { adapter } = createMongoVectorIntegration({ ...VALID, pools: {} })
      await expect(
        adapter.hasEmbeddingVersion(dummyPayload, 'default', 'col', 'doc-1', 'v1'),
      ).rejects.toThrow(/at least one pool/)
    })

    test('invalid dimensions', async () => {
      const { adapter } = createMongoVectorIntegration({
        ...VALID,
        pools: { default: { dimensions: 0 } },
      })
      await expect(
        adapter.hasEmbeddingVersion(dummyPayload, 'default', 'col', 'doc-1', 'v1'),
      ).rejects.toThrow(/positive numeric `dimensions`/)
    })
  })
})
