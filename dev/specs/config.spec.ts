import { describe, expect, test } from 'vitest'
import { buildDummyConfig } from './constants.js'

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

function _fakePayload(): any {
  return {
    db: {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
}
