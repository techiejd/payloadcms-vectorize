import type { Payload } from 'payload'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { makeDummyEmbedDocs, makeDummyEmbedQuery, testEmbeddingVersion } from 'helpers/embed.js'
import { type SerializedEditorState } from '@payloadcms/richtext-lexical/lexical'
import { buildDummyConfig, DIMS, getInitialMarkdownContent } from './constants.js'
import {
  BULK_QUEUE_NAMES,
  createMockBulkEmbeddings,
  createTestDb,
  destroyPayload,
  waitForVectorizationJobs,
} from './utils.js'
import { getPayload } from 'payload'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { chunkText } from 'helpers/chunkers.js'
import { createVectorSearchHandlers } from '../../src/endpoints/vectorSearch.js'
import payloadcmsVectorize, { DbAdapter, type KnowledgePoolDynamicConfig } from 'payloadcms-vectorize'
import { createMockAdapter } from 'helpers/mockAdapter.js'
import type { VectorSearchResult } from '../../src/types.js'

const embedFn = makeDummyEmbedQuery(DIMS)

async function performVectorSearch(
  payload: Payload,
  adapter: DbAdapter,
  query: string,
  knowledgePool: string = 'default',
  where?: any,
  limit: number = 100,
): Promise<VectorSearchResult[]> {
  const knowledgePools: Record<string, KnowledgePoolDynamicConfig> = {
    default: {
      collections: {},
      embeddingConfig: {
        version: testEmbeddingVersion,
        queryFn: makeDummyEmbedQuery(DIMS),
        realTimeIngestionFn: makeDummyEmbedDocs(DIMS),
      },
    },
  }
  const searchHandler = createVectorSearchHandlers(knowledgePools, adapter).requestHandler

  const mockRequest = {
    json: async () => ({
      query,
      knowledgePool,
      ...(where ? { where } : {}),
      limit,
    }),
    payload,
  } as any

  const response = await searchHandler(mockRequest)
  const json = await response.json()

  if (response.status !== 200) {
    throw new Error(`Search failed: ${json.error}`)
  }

  return json.results
}

describe('WHERE clause operators - comprehensive tests', () => {
  let payload: Payload
  let adapter: DbAdapter
  let markdownContent: SerializedEditorState
  const dbName = 'where_clause_test'

  beforeAll(async () => {
    await createTestDb({ dbName })
    adapter = createMockAdapter()

    const config = await buildDummyConfig({
      jobs: {
        tasks: [],
        autoRun: [
          {
            cron: '*/5 * * * * *',
            limit: 10,
          },
        ],
      },
      collections: [
        {
          slug: 'articles',
          fields: [
            { name: 'title', type: 'text' },
            { name: 'status', type: 'text' },
            { name: 'category', type: 'text' },
            { name: 'views', type: 'number' },
            { name: 'rating', type: 'number' },
            { name: 'published', type: 'checkbox' },
            { name: 'tags', type: 'text' },
          ],
        },
      ],
      db: postgresAdapter({
        pool: {
          connectionString: `postgresql://postgres:password@localhost:5433/${dbName}`,
        },
      }),
      plugins: [
        payloadcmsVectorize({
          dbAdapter: adapter,
          knowledgePools: {
            default: {
              collections: {
                articles: {
                  toKnowledgePool: async (doc) => {
                    const chunks: Array<{
                      chunk: string
                      status?: string
                      category?: string
                      views?: number
                      rating?: number
                      published?: boolean
                      tags?: string
                    }> = []

                    if (doc.title) {
                      chunks.push({
                        chunk: doc.title,
                        status: doc.status || 'draft',
                        category: doc.category || 'general',
                        views: doc.views ?? 0,
                        rating: doc.rating ?? 0,
                        published: doc.published ?? false,
                        tags: doc.tags || 'none',
                      })
                    }

                    return chunks
                  },
                },
              },
              extensionFields: [
                { name: 'status', type: 'text' },
                { name: 'category', type: 'text' },
                { name: 'views', type: 'number' },
                { name: 'rating', type: 'number' },
                { name: 'published', type: 'checkbox' },
                { name: 'tags', type: 'text' },
              ],
              embeddingConfig: {
                version: testEmbeddingVersion,
                queryFn: makeDummyEmbedQuery(DIMS),
                realTimeIngestionFn: makeDummyEmbedDocs(DIMS),
              },
            },
          },
          bulkQueueNames: BULK_QUEUE_NAMES,
        }),
      ],
    })

    payload = await getPayload({
      config,
      key: `where-clause-test-${Date.now()}`,
      cron: true,
    })

    markdownContent = await getInitialMarkdownContent(config)

    // Create test data
    await payload.create({
      collection: 'articles',
      data: {
        title: 'Published Tech Article',
        status: 'published',
        category: 'tech',
        views: 150,
        rating: 4.5,
        published: true,
        tags: 'javascript,nodejs,programming',
      },
    })

    await payload.create({
      collection: 'articles',
      data: {
        title: 'Draft Tech Article',
        status: 'draft',
        category: 'tech',
        views: 0,
        rating: 0,
        published: false,
        tags: 'javascript',
      },
    })

    await payload.create({
      collection: 'articles',
      data: {
        title: 'Published Design Article',
        status: 'published',
        category: 'design',
        views: 300,
        rating: 4.8,
        published: true,
        tags: 'ui,design,ux',
      },
    })

    await payload.create({
      collection: 'articles',
      data: {
        title: 'Archived Tech Article',
        status: 'archived',
        category: 'tech',
        views: 50,
        rating: 3.5,
        published: false,
        tags: 'python,legacy',
      },
    })

    await waitForVectorizationJobs(payload)
  })

  afterAll(async () => {
    await destroyPayload(payload)
  })

  describe('equals operator', () => {
    test('filters by exact text match', async () => {
      const results = await performVectorSearch(payload, adapter, 'Article', 'default', {
        status: { equals: 'published' },
      })

      expect(results.length).toBeGreaterThan(0)
      results.forEach((r) => {
        expect(r.status).toBe('published')
      })
    })

    test('returns empty results when no match', async () => {
      const results = await performVectorSearch(payload, adapter, 'Article', 'default', {
        status: { equals: 'nonexistent' },
      })

      expect(results).toEqual([])
    })
  })

  describe('not_equals / notEquals operator', () => {
    test('filters by non-equal text match', async () => {
      const results = await performVectorSearch(payload, adapter, 'Article', 'default', {
        status: { not_equals: 'draft' },
      })

      expect(results.length).toBeGreaterThan(0)
      results.forEach((r) => {
        expect(r.status).not.toBe('draft')
      })
    })

    test('notEquals variant works', async () => {
      const results = await performVectorSearch(payload, adapter, 'Article', 'default', {
        status: { notEquals: 'archived' },
      })

      expect(results.length).toBeGreaterThan(0)
      results.forEach((r) => {
        expect(r.status).not.toBe('archived')
      })
    })
  })

  describe('in / notIn operators', () => {
    test('filters by multiple allowed values', async () => {
      const results = await performVectorSearch(payload, adapter, 'Article', 'default', {
        status: { in: ['published', 'draft'] },
      })

      expect(results.length).toBeGreaterThan(0)
      results.forEach((r) => {
        expect(['published', 'draft']).toContain(r.status)
      })
    })

    test('handles empty in array', async () => {
      const results = await performVectorSearch(payload, adapter, 'Article', 'default', {
        status: { in: [] },
      })

      expect(results).toEqual([])
    })

    test('filters by excluded values', async () => {
      const results = await performVectorSearch(payload, adapter, 'Article', 'default', {
        status: { not_in: ['draft', 'archived'] },
      })

      expect(results.length).toBeGreaterThan(0)
      results.forEach((r) => {
        expect(['draft', 'archived']).not.toContain(r.status)
      })
    })

    test('notIn variant works', async () => {
      const results = await performVectorSearch(payload, adapter, 'Article', 'default', {
        status: { notIn: ['archived'] },
      })

      expect(results.length).toBeGreaterThan(0)
      results.forEach((r) => {
        expect(r.status).not.toBe('archived')
      })
    })
  })

  describe('like / contains operators', () => {
    test('filters by substring match with like', async () => {
      const results = await performVectorSearch(payload, adapter, 'Article', 'default', {
        tags: { like: '%javascript%' },
      })

      expect(results.length).toBeGreaterThan(0)
      results.forEach((r) => {
        expect(r.tags).toContain('javascript')
      })
    })

    test('filters by substring match with contains', async () => {
      const results = await performVectorSearch(payload, adapter, 'Article', 'default', {
        category: { contains: 'tech' },
      })

      expect(results.length).toBeGreaterThan(0)
      results.forEach((r) => {
        expect(r.category).toContain('tech')
      })
    })

    test('like is case sensitive', async () => {
      const results = await performVectorSearch(payload, adapter, 'Article', 'default', {
        tags: { like: '%Python%' },
      })

      // This should handle case sensitivity properly
      // The actual behavior depends on Postgres default collation
      expect(Array.isArray(results)).toBe(true)
    })
  })

  describe('comparison operators (numbers)', () => {
    test('greater_than filters numeric fields', async () => {
      const results = await performVectorSearch(payload, adapter, 'Article', 'default', {
        views: { greater_than: 100 },
      })

      expect(results.length).toBeGreaterThan(0)
      results.forEach((r) => {
        expect(r.views).toBeGreaterThan(100)
      })
    })

    test('greaterThan variant works', async () => {
      const results = await performVectorSearch(payload, adapter, 'Article', 'default', {
        views: { greaterThan: 100 },
      })

      expect(results.length).toBeGreaterThan(0)
      results.forEach((r) => {
        expect(r.views).toBeGreaterThan(100)
      })
    })

    test('greater_than_equal filters inclusive', async () => {
      const results = await performVectorSearch(payload, adapter, 'Article', 'default', {
        views: { greater_than_equal: 150 },
      })

      expect(results.length).toBeGreaterThan(0)
      results.forEach((r) => {
        expect(r.views).toBeGreaterThanOrEqual(150)
      })
    })

    test('less_than filters numeric fields', async () => {
      const results = await performVectorSearch(payload, adapter, 'Article', 'default', {
        views: { less_than: 200 },
      })

      expect(results.length).toBeGreaterThan(0)
      results.forEach((r) => {
        expect(r.views).toBeLessThan(200)
      })
    })

    test('less_than_equal filters inclusive', async () => {
      const results = await performVectorSearch(payload, adapter, 'Article', 'default', {
        views: { less_than_equal: 150 },
      })

      expect(results.length).toBeGreaterThan(0)
      results.forEach((r) => {
        expect(r.views).toBeLessThanOrEqual(150)
      })
    })

    test('lessThan variant works', async () => {
      const results = await performVectorSearch(payload, adapter, 'Article', 'default', {
        rating: { lessThan: 4.6 },
      })

      expect(results.length).toBeGreaterThan(0)
      results.forEach((r) => {
        expect(r.rating).toBeLessThan(4.6)
      })
    })

    test('range query combining greater and less than', async () => {
      const results = await performVectorSearch(payload, adapter, 'Article', 'default', {
        and: [
          { views: { greater_than: 50 } },
          { views: { less_than: 200 } },
        ],
      })

      expect(results.length).toBeGreaterThan(0)
      results.forEach((r) => {
        expect(r.views).toBeGreaterThan(50)
        expect(r.views).toBeLessThan(200)
      })
    })
  })

  describe('exists operator (null checks)', () => {
    test('exists true filters non-null values', async () => {
      const results = await performVectorSearch(payload, adapter, 'Article', 'default', {
        category: { exists: true },
      })

      expect(results.length).toBeGreaterThan(0)
      results.forEach((r) => {
        expect(r.category).toBeDefined()
        expect(r.category).not.toBeNull()
      })
    })

    test('exists false filters null values', async () => {
      const results = await performVectorSearch(payload, adapter, 'Article', 'default', {
        category: { exists: false },
      })

      // Could be empty or contain nulls
      results.forEach((r) => {
        expect(r.category === null || r.category === undefined).toBe(true)
      })
    })
  })

  describe('AND operator - combining multiple conditions', () => {
    test('combines multiple text conditions', async () => {
      const results = await performVectorSearch(payload, adapter, 'Article', 'default', {
        and: [
          { status: { equals: 'published' } },
          { category: { equals: 'tech' } },
        ],
      })

      expect(results.length).toBeGreaterThan(0)
      results.forEach((r) => {
        expect(r.status).toBe('published')
        expect(r.category).toBe('tech')
      })
    })

    test('combines text and numeric conditions', async () => {
      const results = await performVectorSearch(payload, adapter, 'Article', 'default', {
        and: [
          { status: { equals: 'published' } },
          { views: { greater_than: 100 } },
        ],
      })

      expect(results.length).toBeGreaterThan(0)
      results.forEach((r) => {
        expect(r.status).toBe('published')
        expect(r.views).toBeGreaterThan(100)
      })
    })

    test('empty and array returns no results', async () => {
      const results = await performVectorSearch(payload, adapter, 'Article', 'default', {
        and: [],
      })

      expect(results).toEqual([])
    })

    test('and with single condition', async () => {
      const results = await performVectorSearch(payload, adapter, 'Article', 'default', {
        and: [{ status: { equals: 'published' } }],
      })

      expect(results.length).toBeGreaterThan(0)
      results.forEach((r) => {
        expect(r.status).toBe('published')
      })
    })
  })

  describe('OR operator - alternative conditions', () => {
    test('returns results matching any condition', async () => {
      const results = await performVectorSearch(payload, adapter, 'Article', 'default', {
        or: [
          { status: { equals: 'draft' } },
          { status: { equals: 'archived' } },
        ],
      })

      expect(results.length).toBeGreaterThan(0)
      results.forEach((r) => {
        expect(['draft', 'archived']).toContain(r.status)
      })
    })

    test('or with numeric conditions', async () => {
      const results = await performVectorSearch(payload, adapter, 'Article', 'default', {
        or: [
          { views: { greater_than: 200 } },
          { rating: { greater_than: 4.7 } },
        ],
      })

      expect(results.length).toBeGreaterThan(0)
      results.forEach((r) => {
        const matchesViews = r.views > 200
        const matchesRating = r.rating > 4.7
        expect(matchesViews || matchesRating).toBe(true)
      })
    })

    test('empty or array returns no results', async () => {
      const results = await performVectorSearch(payload, adapter, 'Article', 'default', {
        or: [],
      })

      expect(results).toEqual([])
    })

    test('or with single condition', async () => {
      const results = await performVectorSearch(payload, adapter, 'Article', 'default', {
        or: [{ status: { equals: 'published' } }],
      })

      expect(results.length).toBeGreaterThan(0)
      results.forEach((r) => {
        expect(r.status).toBe('published')
      })
    })
  })

  describe('complex nested logic', () => {
    test('and/or combination: (published tech) OR (archived)', async () => {
      const results = await performVectorSearch(payload, adapter, 'Article', 'default', {
        or: [
          {
            and: [
              { status: { equals: 'published' } },
              { category: { equals: 'tech' } },
            ],
          },
          { status: { equals: 'archived' } },
        ],
      })

      expect(results.length).toBeGreaterThan(0)
      results.forEach((r) => {
        const isPublishedTech = r.status === 'published' && r.category === 'tech'
        const isArchived = r.status === 'archived'
        expect(isPublishedTech || isArchived).toBe(true)
      })
    })

    test('multiple and conditions with negation', async () => {
      const results = await performVectorSearch(payload, adapter, 'Article', 'default', {
        and: [
          { status: { not_equals: 'draft' } },
          { category: { equals: 'tech' } },
          { views: { greater_than_equal: 0 } },
        ],
      })

      expect(results.length).toBeGreaterThan(0)
      results.forEach((r) => {
        expect(r.status).not.toBe('draft')
        expect(r.category).toBe('tech')
        expect(r.views).toBeGreaterThanOrEqual(0)
      })
    })

    test('nested or within and', async () => {
      const results = await performVectorSearch(payload, adapter, 'Article', 'default', {
        and: [
          {
            or: [
              { status: { equals: 'published' } },
              { status: { equals: 'draft' } },
            ],
          },
          { views: { greater_than: 0 } },
        ],
      })

      expect(results.length).toBeGreaterThan(0)
      results.forEach((r) => {
        expect(['published', 'draft']).toContain(r.status)
        expect(r.views).toBeGreaterThan(0)
      })
    })
  })

  describe('edge cases', () => {
    test('non-existent field is silently ignored', async () => {
      const results = await performVectorSearch(payload, adapter, 'Article', 'default', {
        nonExistentField: { equals: 'value' },
      })

      // Should not error, behavior depends on implementation
      expect(Array.isArray(results)).toBe(true)
    })

    test('filter by docId (reserved field)', async () => {
      // Get a known docId first
      const allResults = await performVectorSearch(payload, adapter, 'Article', 'default', {})
      expect(allResults.length).toBeGreaterThan(0)

      const targetDocId = allResults[0].docId
      const results = await performVectorSearch(payload, adapter, 'Article', 'default', {
        docId: { equals: targetDocId },
      })

      expect(results.length).toBeGreaterThan(0)
      results.forEach((r) => {
        expect(r.docId).toBe(targetDocId)
      })
    })

    test('filter by sourceCollection', async () => {
      const results = await performVectorSearch(payload, adapter, 'Article', 'default', {
        sourceCollection: { equals: 'articles' },
      })

      expect(results.length).toBeGreaterThan(0)
      results.forEach((r) => {
        expect(r.sourceCollection).toBe('articles')
      })
    })

    test('type mismatch: string operator on numeric field', async () => {
      // This should either error gracefully or handle the mismatch
      let error: Error | null = null
      try {
        await performVectorSearch(payload, adapter, 'Article', 'default', {
          views: { contains: 'text' },
        })
      } catch (e) {
        error = e as Error
      }

      // Either succeeds with no results or throws clear error
      expect(error === null || error.message.includes('WHERE')).toBe(true)
    })

    test('numeric filter on text field', async () => {
      let error: Error | null = null
      try {
        await performVectorSearch(payload, adapter, 'Article', 'default', {
          status: { greater_than: 100 },
        })
      } catch (e) {
        error = e as Error
      }

      expect(error === null || error.message.includes('WHERE')).toBe(true)
    })
  })

  describe('integration with limit and ordering', () => {
    test('where clause combined with limit', async () => {
      const results = await performVectorSearch(
        payload,
        adapter,
        'Article',
        'default',
        {
          status: { equals: 'published' },
        },
        5,
      )

      expect(results.length).toBeLessThanOrEqual(5)
      results.forEach((r) => {
        expect(r.status).toBe('published')
      })
    })

    test('where results are still ordered by relevance score', async () => {
      const results = await performVectorSearch(payload, adapter, 'Article', 'default', {
        category: { equals: 'tech' },
      })

      if (results.length > 1) {
        for (let i = 0; i < results.length - 1; i++) {
          expect(results[i].score).toBeGreaterThanOrEqual(results[i + 1].score)
        }
      }
    })
  })
})
