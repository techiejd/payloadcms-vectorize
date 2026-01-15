import { expect } from 'vitest'
import type { BulkEmbedResult } from '../../src/types.js'

export const expectGoodResult = (result: BulkEmbedResult | undefined) => {
  expect(result).toBeDefined()
  expect(result!.status).toBe('queued')
  expect((result as any).conflict).toBeUndefined()
}
