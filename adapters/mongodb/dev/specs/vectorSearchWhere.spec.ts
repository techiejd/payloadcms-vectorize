import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { BasePayload, Where } from 'payload'
import type { DbAdapter, VectorSearchResult } from 'payloadcms-vectorize'
import { createMongoVectorIntegration } from '../../src/index.js'
import { DIMS, MONGO_URI } from './constants.js'
import { dropTestDb, makeFakePayload, teardown } from './utils.js'

const TEST_DB = `vectorize_mongo_where_${Date.now()}`
const FILTERABLE = ['status', 'category', 'views', 'rating', 'published', 'tags']

const articles = [
  {
    title: 'Published Tech Article',
    status: 'published', category: 'tech', views: 150,
    rating: 4.5, published: true, tags: 'javascript,nodejs,programming',
  },
  {
    title: 'Draft Tech Article',
    status: 'draft', category: 'tech', views: 0,
    rating: 0, published: false, tags: 'javascript',
  },
  {
    title: 'Published Design Article',
    status: 'published', category: 'design', views: 300,
    rating: 4.8, published: true, tags: 'ui,design,ux',
  },
  {
    title: 'Archived Tech Article',
    status: 'archived', category: 'tech', views: 50,
    rating: 3.5, published: false, tags: 'python,legacy',
  },
]

async function performVectorSearch(
  payload: BasePayload,
  adapter: DbAdapter,
  where?: Where,
  limit = 10,
): Promise<VectorSearchResult[]> {
  const queryEmbedding = Array(DIMS).fill(0.5)
  return adapter.search(payload, queryEmbedding, 'default', limit, where)
}

describe('Mongo adapter — WHERE clause operators', () => {
  let adapter: DbAdapter
  let payload: BasePayload

  beforeAll(async () => {
    await dropTestDb(MONGO_URI, TEST_DB)
    const { adapter: a } = createMongoVectorIntegration({
      uri: MONGO_URI,
      dbName: TEST_DB,
      pools: {
        default: {
          dimensions: DIMS,
          filterableFields: FILTERABLE,
          numCandidates: 50,
        },
      },
    })
    adapter = a
    const ext = adapter.getConfigExtension({} as any)
    payload = makeFakePayload(ext.custom!)

    let i = 0
    for (const a of articles) {
      const embedding = Array(DIMS).fill(0.5).map((v) => v + Math.random() * 0.05)
      await adapter.storeChunk(payload, 'default', {
        sourceCollection: 'articles',
        docId: `art-${i++}`,
        chunkIndex: 0,
        chunkText: a.title,
        embeddingVersion: 'v1',
        embedding,
        extensionFields: {
          status: a.status,
          category: a.category,
          views: a.views,
          rating: a.rating,
          published: a.published,
          tags: a.tags,
        },
      })
    }
    await new Promise((r) => setTimeout(r, 1200))
  }, 90_000)

  afterAll(async () => {
    await dropTestDb(MONGO_URI, TEST_DB)
    await teardown()
  })

  describe('equals operator', () => {
    test('filters by exact text match', async () => {
      const r = await performVectorSearch(payload, adapter, { status: { equals: 'published' } })
      expect(r.length).toBeGreaterThan(0)
      r.forEach((x) => expect(x.status).toBe('published'))
    })

    test('returns empty when no match', async () => {
      const r = await performVectorSearch(payload, adapter, { status: { equals: 'missing' } })
      expect(r).toEqual([])
    })
  })

  describe('not_equals / notEquals operator', () => {
    test('filters by non-equal text match', async () => {
      const r = await performVectorSearch(payload, adapter, { status: { not_equals: 'draft' } })
      expect(r.length).toBeGreaterThan(0)
      r.forEach((x) => expect(x.status).not.toBe('draft'))
    })

    test('notEquals variant', async () => {
      const r = await performVectorSearch(payload, adapter, { status: { notEquals: 'archived' } })
      expect(r.length).toBeGreaterThan(0)
      r.forEach((x) => expect(x.status).not.toBe('archived'))
    })
  })

  describe('in / not_in / notIn operators', () => {
    test('in', async () => {
      const r = await performVectorSearch(payload, adapter, { status: { in: ['published', 'draft'] } })
      expect(r.length).toBeGreaterThan(0)
      r.forEach((x) => expect(['published', 'draft']).toContain(x.status))
    })
    test('not_in', async () => {
      const r = await performVectorSearch(payload, adapter, { status: { not_in: ['draft', 'archived'] } })
      expect(r.length).toBeGreaterThan(0)
      r.forEach((x) => expect(['draft', 'archived']).not.toContain(x.status))
    })
    test('notIn', async () => {
      const r = await performVectorSearch(payload, adapter, { status: { notIn: ['archived'] } })
      expect(r.length).toBeGreaterThan(0)
      r.forEach((x) => expect(x.status).not.toBe('archived'))
    })
  })

  describe('like / contains operators (post-filter)', () => {
    test('like substring match', async () => {
      const r = await performVectorSearch(payload, adapter, { tags: { like: 'javascript' } })
      expect(r.length).toBeGreaterThan(0)
      r.forEach((x) => expect((x.tags as string).toLowerCase()).toContain('javascript'))
    })
    test('contains substring match', async () => {
      const r = await performVectorSearch(payload, adapter, { category: { contains: 'tech' } })
      expect(r.length).toBeGreaterThan(0)
      r.forEach((x) => expect(x.category).toContain('tech'))
    })
    test('like regex special chars do NOT match unintended values', async () => {
      // None of our fixtures contain "foo.bar" — the dot must be escaped.
      const r = await performVectorSearch(payload, adapter, { tags: { like: 'foo.bar' } })
      expect(r).toEqual([])
    })
  })

  describe('comparison operators (numbers)', () => {
    test('greater_than', async () => {
      const r = await performVectorSearch(payload, adapter, { views: { greater_than: 100 } })
      expect(r.length).toBeGreaterThan(0)
      r.forEach((x) => expect(x.views).toBeGreaterThan(100))
    })
    test('greaterThan variant', async () => {
      const r = await performVectorSearch(payload, adapter, { views: { greaterThan: 100 } })
      expect(r.length).toBeGreaterThan(0)
      r.forEach((x) => expect(x.views).toBeGreaterThan(100))
    })
    test('greater_than_equal', async () => {
      const r = await performVectorSearch(payload, adapter, { views: { greater_than_equal: 150 } })
      expect(r.length).toBeGreaterThan(0)
      r.forEach((x) => expect(x.views).toBeGreaterThanOrEqual(150))
    })
    test('less_than', async () => {
      const r = await performVectorSearch(payload, adapter, { views: { less_than: 200 } })
      expect(r.length).toBeGreaterThan(0)
      r.forEach((x) => expect(x.views).toBeLessThan(200))
    })
    test('less_than_equal', async () => {
      const r = await performVectorSearch(payload, adapter, { views: { less_than_equal: 150 } })
      expect(r.length).toBeGreaterThan(0)
      r.forEach((x) => expect(x.views).toBeLessThanOrEqual(150))
    })
    test('lessThan variant on float', async () => {
      const r = await performVectorSearch(payload, adapter, { rating: { lessThan: 4.6 } })
      expect(r.length).toBeGreaterThan(0)
      r.forEach((x) => expect(x.rating).toBeLessThan(4.6))
    })
    test('range via and', async () => {
      const r = await performVectorSearch(payload, adapter, {
        and: [{ views: { greater_than: 50 } }, { views: { less_than: 200 } }],
      })
      expect(r.length).toBeGreaterThan(0)
      r.forEach((x) => {
        expect(x.views).toBeGreaterThan(50)
        expect(x.views).toBeLessThan(200)
      })
    })
  })

  describe('exists operator', () => {
    test('exists true', async () => {
      const r = await performVectorSearch(payload, adapter, { category: { exists: true } })
      r.forEach((x) => expect(x.category != null).toBe(true))
    })
    test('exists false', async () => {
      const r = await performVectorSearch(payload, adapter, { category: { exists: false } })
      r.forEach((x) => expect(x.category == null).toBe(true))
    })
  })

  describe('AND operator', () => {
    test('text + text', async () => {
      const r = await performVectorSearch(payload, adapter, {
        and: [{ status: { equals: 'published' } }, { category: { equals: 'tech' } }],
      })
      expect(r.length).toBeGreaterThan(0)
      r.forEach((x) => {
        expect(x.status).toBe('published')
        expect(x.category).toBe('tech')
      })
    })
    test('text + numeric', async () => {
      const r = await performVectorSearch(payload, adapter, {
        and: [{ status: { equals: 'published' } }, { views: { greater_than: 100 } }],
      })
      expect(r.length).toBeGreaterThan(0)
      r.forEach((x) => {
        expect(x.status).toBe('published')
        expect(x.views).toBeGreaterThan(100)
      })
    })
    test('and with single condition', async () => {
      const r = await performVectorSearch(payload, adapter, {
        and: [{ status: { equals: 'published' } }],
      })
      expect(r.length).toBeGreaterThan(0)
      r.forEach((x) => expect(x.status).toBe('published'))
    })
    test('and with one pre + one post operator', async () => {
      const r = await performVectorSearch(payload, adapter, {
        and: [{ status: { equals: 'published' } }, { tags: { like: 'javascript' } }],
      })
      expect(r.length).toBeGreaterThan(0)
      r.forEach((x) => {
        expect(x.status).toBe('published')
        expect((x.tags as string).toLowerCase()).toContain('javascript')
      })
    })
  })

  describe('OR operator', () => {
    test('two text branches', async () => {
      const r = await performVectorSearch(payload, adapter, {
        or: [{ status: { equals: 'draft' } }, { status: { equals: 'archived' } }],
      })
      expect(r.length).toBeGreaterThan(0)
      r.forEach((x) => expect(['draft', 'archived']).toContain(x.status))
    })
    test('two numeric branches', async () => {
      const r = await performVectorSearch(payload, adapter, {
        or: [{ views: { greater_than: 200 } }, { rating: { greater_than: 4.7 } }],
      })
      expect(r.length).toBeGreaterThan(0)
      r.forEach((x) => {
        const a = (x.views as number) > 200
        const b = (x.rating as number) > 4.7
        expect(a || b).toBe(true)
      })
    })
    test('or with single condition', async () => {
      const r = await performVectorSearch(payload, adapter, {
        or: [{ status: { equals: 'published' } }],
      })
      expect(r.length).toBeGreaterThan(0)
      r.forEach((x) => expect(x.status).toBe('published'))
    })
    test('or with one post-filter branch routes whole or to post', async () => {
      const r = await performVectorSearch(payload, adapter, {
        or: [{ status: { equals: 'published' } }, { tags: { like: 'python' } }],
      })
      expect(r.length).toBeGreaterThan(0)
      r.forEach((x) => {
        const a = x.status === 'published'
        const b = (x.tags as string).toLowerCase().includes('python')
        expect(a || b).toBe(true)
      })
    })
  })

  describe('complex nested logic', () => {
    test('(published AND tech) OR archived', async () => {
      const r = await performVectorSearch(payload, adapter, {
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
      expect(r.length).toBeGreaterThan(0)
      r.forEach((x) => {
        const tech = x.status === 'published' && x.category === 'tech'
        const arch = x.status === 'archived'
        expect(tech || arch).toBe(true)
      })
    })
  })

  describe('reserved fields filterable without declaration', () => {
    test('sourceCollection equals works on a pool that did not declare it', async () => {
      const r = await performVectorSearch(payload, adapter, {
        sourceCollection: { equals: 'articles' },
      })
      expect(r.length).toBeGreaterThan(0)
      r.forEach((x) => expect(x.sourceCollection).toBe('articles'))
    })
  })

  describe('configuration errors', () => {
    test('filtering on undeclared field throws clearly', async () => {
      await expect(
        performVectorSearch(payload, adapter, {
          undeclared: { equals: 'x' },
        } as any),
      ).rejects.toThrowError(/not configured as filterableFields/)
    })
  })

  describe('limit', () => {
    test('returns at most `limit` results ordered by score', async () => {
      const r = await performVectorSearch(payload, adapter, undefined, 2)
      expect(r.length).toBeLessThanOrEqual(2)
      for (let i = 1; i < r.length; i++) {
        expect(r[i - 1].score).toBeGreaterThanOrEqual(r[i].score)
      }
    })
  })
})
