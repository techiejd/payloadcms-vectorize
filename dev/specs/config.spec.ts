import { describe, expect, test } from 'vitest'
import { buildConfig, type Payload } from 'payload'
import { buildDummyConfig, dummyPluginOptions, plugin, vectorizeCronJob } from './constants.js'

describe('jobs.autoRun merging', () => {
  test('adds autoRun when none provided', async () => {
    const cfg = await buildDummyConfig({ jobs: { tasks: [] } })
    const autoRun = cfg.jobs?.autoRun
    expect(Array.isArray(autoRun)).toBe(true)
    expect(autoRun).toEqual([vectorizeCronJob])
  })

  test('appends to existing autoRun array', async () => {
    const existing = [{ cron: '*/5 * * * * *', limit: 1, queue: 'default' }]
    const cfg = await buildDummyConfig({ jobs: { tasks: [], autoRun: existing } })
    const autoRun = cfg.jobs?.autoRun
    expect(Array.isArray(autoRun)).toBe(true)
    expect(autoRun).toEqual([...existing, vectorizeCronJob])
  })

  test('wraps sync function returning array', async () => {
    const incoming = (_payload: Payload) => [{ cron: '*/15 * * * * *', limit: 2, queue: 'q1' }]
    const cfg = await buildDummyConfig({ jobs: { tasks: [], autoRun: incoming } })
    const autoRun = cfg.jobs?.autoRun
    expect(typeof autoRun).toBe('function')
    const resolved = (autoRun as (p: Payload) => any[])(_fakePayload())
    expect(Array.isArray(resolved)).toBe(true)
    expect(resolved).toEqual([{ cron: '*/15 * * * * *', limit: 2, queue: 'q1' }, vectorizeCronJob])
  })

  test('wraps async function returning Promise<array>', async () => {
    const incoming = async (_payload: Payload) => [
      { cron: '*/20 * * * * *', limit: 3, queue: 'q2' },
    ]
    const cfg = await buildDummyConfig({ jobs: { tasks: [], autoRun: incoming } })
    const autoRun = cfg.jobs?.autoRun
    expect(typeof autoRun).toBe('function')
    const resolved = await (autoRun as (p: Payload) => Promise<any[]>)(_fakePayload())
    expect(Array.isArray(resolved)).toBe(true)
    expect(resolved).toEqual([{ cron: '*/20 * * * * *', limit: 3, queue: 'q2' }, vectorizeCronJob])
  })

  test('preserves incoming autoRun when plugin provides no cron', async () => {
    const existing = [{ cron: '*/7 * * * * *', limit: 4, queue: 'keep-me' }]
    const cfg = await buildConfig({
      secret: 'test-secret',
      collections: [],
      db: {} as any,
      jobs: { tasks: [], autoRun: existing },
      plugins: [plugin({ ...dummyPluginOptions, queueNameOrCronJob: undefined as any })],
    })
    const autoRun = cfg.jobs?.autoRun
    expect(Array.isArray(autoRun)).toBe(true)
    expect(autoRun).toEqual(existing)
  })
})

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
