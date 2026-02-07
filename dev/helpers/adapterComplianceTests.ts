import { describe, expect, test, beforeAll, afterAll } from 'vitest'
import type { DbAdapter, VectorSearchResult } from 'payloadcms-vectorize'
import type { Payload } from 'payload'

/**
 * Context required for running adapter compliance tests
 */
export type AdapterTestContext = {
  /** The adapter being tested */
  adapter: DbAdapter
  /** A Payload instance configured with the adapter */
  payload: Payload
  /** Name of the knowledge pool to test with */
  poolName: string
  /** Dimension of the embeddings */
  dims: number
  /** Optional cleanup function to run after tests */
  cleanup?: () => Promise<void>
}

/**
 * Factory function that creates a test context
 */
export type AdapterTestContextFactory = () => Promise<AdapterTestContext>

/**
 * Generates a random embedding vector of the specified dimension
 */
function generateRandomEmbedding(dims: number): number[] {
  return Array(dims)
    .fill(0)
    .map(() => Math.random() * 2 - 1) // Random values between -1 and 1
}

/**
 * Generates an embedding similar to the target (for testing similarity search)
 */
function generateSimilarEmbedding(target: number[], noise: number = 0.1): number[] {
  return target.map((v) => v + (Math.random() * noise * 2 - noise))
}

/**
 * Generates an embedding different from the target
 */
function generateDifferentEmbedding(dims: number): number[] {
  // Orthogonal-ish vector
  return Array(dims)
    .fill(0)
    .map((_, i) => (i % 2 === 0 ? 1 : -1))
}

/**
 * Runs the adapter compliance test suite.
 * This suite verifies that an adapter correctly implements the DbAdapter interface.
 *
 * @param getContext - Factory function that creates a test context
 *
 * @example
 * ```typescript
 * import { runAdapterComplianceTests } from './adapterComplianceTests'
 *
 * runAdapterComplianceTests(async () => {
 *   const { adapter, payload } = await setupPostgresAdapter()
 *   return {
 *     adapter,
 *     payload,
 *     poolName: 'test-pool',
 *     dims: 8,
 *     cleanup: async () => { await cleanupDatabase() }
 *   }
 * })
 * ```
 */
export const runAdapterComplianceTests = (getContext: AdapterTestContextFactory) => {
  describe('DbAdapter Compliance Suite', () => {
    let ctx: AdapterTestContext

    beforeAll(async () => {
      ctx = await getContext()
    })

    afterAll(async () => {
      if (ctx?.cleanup) {
        await ctx.cleanup()
      }
    })

    describe('getConfigExtension()', () => {
      test('returns a valid config extension object', () => {
        const extension = ctx.adapter.getConfigExtension({} as any)

        expect(extension).toBeDefined()
        expect(typeof extension).toBe('object')
      })

      test('bins property is an array if present', () => {
        const extension = ctx.adapter.getConfigExtension({} as any)

        if (extension.bins !== undefined) {
          expect(Array.isArray(extension.bins)).toBe(true)
          for (const bin of extension.bins) {
            expect(bin).toHaveProperty('key')
            expect(bin).toHaveProperty('scriptPath')
            expect(typeof bin.key).toBe('string')
            expect(typeof bin.scriptPath).toBe('string')
          }
        }
      })

      test('custom property is an object if present', () => {
        const extension = ctx.adapter.getConfigExtension({} as any)

        if (extension.custom !== undefined) {
          expect(typeof extension.custom).toBe('object')
        }
      })
    })

    describe('storeEmbedding()', () => {
      test('persists embedding without error (number[])', async () => {
        const embedding = generateRandomEmbedding(ctx.dims)

        // Create a document first
        const doc = await ctx.payload.create({
          collection: ctx.poolName as any,
          data: {
            sourceCollection: 'test-collection',
            docId: `test-embed-1-${Date.now()}`,
            chunkIndex: 0,
            chunkText: 'test text for embedding',
            embeddingVersion: 'v1-test',
          },
        })

        await expect(
          ctx.adapter.storeEmbedding(ctx.payload, ctx.poolName, String(doc.id), embedding),
        ).resolves.not.toThrow()
      })

      test('persists embedding without error (Float32Array)', async () => {
        const embedding = new Float32Array(generateRandomEmbedding(ctx.dims))

        const doc = await ctx.payload.create({
          collection: ctx.poolName as any,
          data: {
            sourceCollection: 'test-collection',
            docId: `test-embed-2-${Date.now()}`,
            chunkIndex: 0,
            chunkText: 'test text for Float32Array',
            embeddingVersion: 'v1-test',
          },
        })

        await expect(
          ctx.adapter.storeEmbedding(ctx.payload, ctx.poolName, String(doc.id), embedding),
        ).resolves.not.toThrow()
      })
    })

    describe('search()', () => {
      let targetEmbedding: number[]
      let similarDocId: string
      let differentDocId: string

      beforeAll(async () => {
        // Create test documents with known embeddings
        targetEmbedding = generateRandomEmbedding(ctx.dims)
        const similarEmbedding = generateSimilarEmbedding(targetEmbedding, 0.05)
        const differentEmbedding = generateDifferentEmbedding(ctx.dims)

        // Create similar document
        const similarDoc = await ctx.payload.create({
          collection: ctx.poolName as any,
          data: {
            sourceCollection: 'test-collection',
            docId: `test-search-similar-${Date.now()}`,
            chunkIndex: 0,
            chunkText: 'similar document',
            embeddingVersion: 'v1-test',
          },
        })
        similarDocId = String(similarDoc.id)
        await ctx.adapter.storeEmbedding(ctx.payload, ctx.poolName, similarDocId, similarEmbedding)

        // Create different document
        const differentDoc = await ctx.payload.create({
          collection: ctx.poolName as any,
          data: {
            sourceCollection: 'test-collection',
            docId: `test-search-different-${Date.now()}`,
            chunkIndex: 0,
            chunkText: 'different document',
            embeddingVersion: 'v1-test',
          },
        })
        differentDocId = String(differentDoc.id)
        await ctx.adapter.storeEmbedding(
          ctx.payload,
          ctx.poolName,
          differentDocId,
          differentEmbedding,
        )
      })

      test('returns an array of results', async () => {
        const results = await ctx.adapter.search(ctx.payload, targetEmbedding, ctx.poolName)

        expect(Array.isArray(results)).toBe(true)
      })

      test('results contain required fields', async () => {
        const results = await ctx.adapter.search(ctx.payload, targetEmbedding, ctx.poolName)

        for (const result of results) {
          expect(result).toHaveProperty('id')
          expect(result).toHaveProperty('score')
          expect(result).toHaveProperty('sourceCollection')
          expect(result).toHaveProperty('docId')
          expect(result).toHaveProperty('chunkIndex')
          expect(result).toHaveProperty('chunkText')
          expect(result).toHaveProperty('embeddingVersion')

          expect(typeof result.id).toBe('string')
          expect(typeof result.score).toBe('number')
          expect(typeof result.sourceCollection).toBe('string')
          expect(typeof result.docId).toBe('string')
          expect(typeof result.chunkIndex).toBe('number')
          expect(typeof result.chunkText).toBe('string')
          expect(typeof result.embeddingVersion).toBe('string')
        }
      })

      test('results are ordered by score (highest first)', async () => {
        const results = await ctx.adapter.search(ctx.payload, targetEmbedding, ctx.poolName, 10)

        for (let i = 1; i < results.length; i++) {
          expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score)
        }
      })

      test('respects limit parameter', async () => {
        const results = await ctx.adapter.search(ctx.payload, targetEmbedding, ctx.poolName, 1)

        expect(results.length).toBeLessThanOrEqual(1)
      })

      test('similar document ranks higher than different document', async () => {
        const results = await ctx.adapter.search(ctx.payload, targetEmbedding, ctx.poolName, 10)

        const similarIndex = results.findIndex((r) => r.id === similarDocId)
        const differentIndex = results.findIndex((r) => r.id === differentDocId)

        // Both should be found
        if (similarIndex !== -1 && differentIndex !== -1) {
          // Similar should rank higher (lower index = higher rank)
          expect(similarIndex).toBeLessThan(differentIndex)
        }
      })

      test('score values are in valid range', async () => {
        const results = await ctx.adapter.search(ctx.payload, targetEmbedding, ctx.poolName)

        for (const result of results) {
          // Score range depends on adapter implementation
          // For cosine similarity: -1 to 1
          // For other metrics: may vary
          expect(typeof result.score).toBe('number')
          expect(Number.isFinite(result.score)).toBe(true)
        }
      })
    })
  })
}

/**
 * Export types for use in adapter test files
 */
export type { DbAdapter, VectorSearchResult }
