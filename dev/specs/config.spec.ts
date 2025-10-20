import { describe, expect, test } from 'vitest'
import { buildDummyConfig, dummyPluginOptions, plugin } from './constants.js'

describe('jobs.tasks merging', () => {
  test('adds tasks when none provided', async () => {
    const cfg = await buildDummyConfig({ jobs: { tasks: [] } })
    const tasks = cfg.jobs?.tasks
    expect(Array.isArray(tasks)).toBe(true)
    expect(tasks).toEqual([
      { slug: 'payloadcms-vectorize:vectorize', handler: expect.any(Function) },
    ])
  })
})

describe('/vector-search endpoint', () => {
  test('adds the endpoint by default', async () => {
    const cfg = await buildDummyConfig({})
    const endpoints = cfg.endpoints
    console.log('endpoints:', endpoints)
    expect(Array.isArray(endpoints)).toBe(true)
    expect(endpoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/vector-search',
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
      ]),
    )
  })
  test('uses the custom path when provided', async () => {
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
