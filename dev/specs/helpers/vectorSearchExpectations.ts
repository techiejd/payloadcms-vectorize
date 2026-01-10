import { expect } from 'vitest'
import type { VectorSearchResult } from '../../../src/types.js'

/**
 * Shared test expectations for vector search results
 * Can be used by both endpoint tests and direct method tests
 */
export function expectVectorSearchResults(results: VectorSearchResult[]) {
  expect(Array.isArray(results)).toBe(true)
  expect(results.length).toBeGreaterThan(0)
}

export function expectVectorSearchResultShape(result: VectorSearchResult) {
  expect(result).toHaveProperty('id')
  expect(result).toHaveProperty('similarity')
  expect(result).toHaveProperty('sourceCollection')
  expect(result).toHaveProperty('docId')
  expect(result).toHaveProperty('chunkIndex')
  expect(result).toHaveProperty('chunkText')
  expect(result).toHaveProperty('embeddingVersion')
}

export function expectResultsOrderedBySimilarity(results: VectorSearchResult[]) {
  expect(results.length).toBeGreaterThan(1)

  for (let i = 0; i < results.length - 1; i++) {
    expect(results[i].similarity).toBeGreaterThanOrEqual(results[i + 1].similarity)
  }
}

export function expectResultsRespectLimit(results: VectorSearchResult[], limit: number) {
  expect(results.length).toBeLessThanOrEqual(limit)
}

export function expectResultsRespectWhere(
  results: VectorSearchResult[],
  predicate: (result: VectorSearchResult) => boolean,
) {
  expect(results.length).toBeGreaterThan(0)
  for (const result of results) {
    expect(predicate(result)).toBe(true)
  }
}

export function expectResultsContainTitle(
  results: VectorSearchResult[],
  title: string,
  postId: string,
  embeddingVersion: string,
) {
  expect(results).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        sourceCollection: 'posts',
        docId: postId,
        chunkIndex: 0,
        chunkText: title,
        embeddingVersion,
      }),
    ]),
  )
}

/**
 * Run all common search result expectations
 */
export function expectValidVectorSearchResults(
  results: VectorSearchResult[],
  options?: {
    minResults?: number
    checkShape?: boolean
    checkOrdering?: boolean
    expectedTitle?: { title: string; postId: string; embeddingVersion: string }
    wherePredicate?: (result: VectorSearchResult) => boolean
  },
) {
  expectVectorSearchResults(results)

  if (options?.checkShape && results.length > 0) {
    expectVectorSearchResultShape(results[0])
  }

  if (options?.checkOrdering && results.length > 1) {
    expectResultsOrderedBySimilarity(results)
  }

  if (options?.expectedTitle) {
    expectResultsContainTitle(
      results,
      options.expectedTitle.title,
      options.expectedTitle.postId,
      options.expectedTitle.embeddingVersion,
    )
  }

  if (options?.wherePredicate) {
    expectResultsRespectWhere(results, options.wherePredicate)
  }
}
