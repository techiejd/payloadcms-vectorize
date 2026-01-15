import { describe, expect, test } from 'vitest'
import { buildDummyConfig, dummyPluginOptions, plugin } from './constants.js'

describe('jobs.tasks merging', () => {
  test('adds tasks when none provided', async () => {
    const cfg = await buildDummyConfig({ jobs: { tasks: [] } })
    const tasks = cfg.jobs?.tasks
    expect(Array.isArray(tasks)).toBe(true)
    expect(tasks).toEqual(
      expect.arrayContaining([
        { slug: 'payloadcms-vectorize:vectorize', handler: expect.any(Function) },
        { slug: 'payloadcms-vectorize:prepare-bulk-embedding', handler: expect.any(Function) },
        {
          slug: 'payloadcms-vectorize:poll-or-complete-bulk-embedding',
          handler: expect.any(Function),
        },
      ]),
    )
  })
})

describe('endpoints: /vector-search, /vector-bulk-embed', () => {
  test('adds the endpoints by default', async () => {
    const cfg = await buildDummyConfig({})
    const endpoints = cfg.endpoints
    expect(Array.isArray(endpoints)).toBe(true)
    expect(endpoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/vector-search',
          method: 'post',
          handler: expect.any(Function),
        }),
        expect.objectContaining({
          path: '/vector-bulk-embed',
          method: 'post',
          handler: expect.any(Function),
        }),
      ]),
    )
  })
  test('does not add the endpoint when disabled', async () => {
    const cfg = await buildDummyConfig({
      plugins: [plugin({ ...dummyPluginOptions, endpointOverrides: { enabled: false } })],
    })
    const endpoints = cfg.endpoints
    expect(Array.isArray(endpoints)).toBe(true)
    expect(endpoints).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/vector-search',
          method: 'post',
          handler: expect.any(Function),
        }),
        expect.objectContaining({
          path: '/vector-bulk-embed',
          method: 'post',
          handler: expect.any(Function),
        }),
        expect.objectContaining({
          path: '/vector-retry-failed-batch',
          method: 'post',
          handler: expect.any(Function),
        }),
      ]),
    )
  })
  test('uses the custom path when provided', async () => {
    // TODO: Add test for custom path for bulk embed and retry failed batch
    const cfg = await buildDummyConfig({
      plugins: [plugin({ ...dummyPluginOptions, endpointOverrides: { path: '/custom-path' } })],
    })
    const endpoints = cfg.endpoints
    expect(Array.isArray(endpoints)).toBe(true)
    expect(endpoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/custom-path',
          method: 'post',
          handler: expect.any(Function),
        }),
      ]),
    )
  })
})
