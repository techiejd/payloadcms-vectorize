import { describe, expect, test } from 'vitest'
import { splitWhere, matchesPostFilter } from '../../src/search.js'
import type { Where } from 'payload'

describe('CF adapter - splitWhere', () => {
  describe('simple field conditions', () => {
    test('equals maps to $eq natively', () => {
      const result = splitWhere({ status: { equals: 'published' } })
      expect(result.nativeFilter).toEqual({ status: { $eq: 'published' } })
      expect(result.postFilter).toBeNull()
    })

    test('not_equals maps to $ne natively', () => {
      const result = splitWhere({ status: { not_equals: 'draft' } })
      expect(result.nativeFilter).toEqual({ status: { $ne: 'draft' } })
      expect(result.postFilter).toBeNull()
    })

    test('notEquals maps to $ne natively', () => {
      const result = splitWhere({ status: { notEquals: 'draft' } })
      expect(result.nativeFilter).toEqual({ status: { $ne: 'draft' } })
      expect(result.postFilter).toBeNull()
    })

    test('in maps to $in natively', () => {
      const result = splitWhere({ status: { in: ['published', 'draft'] } })
      expect(result.nativeFilter).toEqual({ status: { $in: ['published', 'draft'] } })
      expect(result.postFilter).toBeNull()
    })

    test('not_in maps to $nin natively', () => {
      const result = splitWhere({ status: { not_in: ['draft'] } })
      expect(result.nativeFilter).toEqual({ status: { $nin: ['draft'] } })
      expect(result.postFilter).toBeNull()
    })

    test('notIn maps to $nin natively', () => {
      const result = splitWhere({ status: { notIn: ['draft'] } })
      expect(result.nativeFilter).toEqual({ status: { $nin: ['draft'] } })
      expect(result.postFilter).toBeNull()
    })

    test('greater_than maps to $gt natively', () => {
      const result = splitWhere({ views: { greater_than: 100 } })
      expect(result.nativeFilter).toEqual({ views: { $gt: 100 } })
      expect(result.postFilter).toBeNull()
    })

    test('greaterThan maps to $gt natively', () => {
      const result = splitWhere({ views: { greaterThan: 100 } })
      expect(result.nativeFilter).toEqual({ views: { $gt: 100 } })
      expect(result.postFilter).toBeNull()
    })

    test('greater_than_equal maps to $gte natively', () => {
      const result = splitWhere({ views: { greater_than_equal: 100 } })
      expect(result.nativeFilter).toEqual({ views: { $gte: 100 } })
      expect(result.postFilter).toBeNull()
    })

    test('less_than maps to $lt natively', () => {
      const result = splitWhere({ views: { less_than: 100 } })
      expect(result.nativeFilter).toEqual({ views: { $lt: 100 } })
      expect(result.postFilter).toBeNull()
    })

    test('lessThan maps to $lt natively', () => {
      const result = splitWhere({ views: { lessThan: 100 } })
      expect(result.nativeFilter).toEqual({ views: { $lt: 100 } })
      expect(result.postFilter).toBeNull()
    })

    test('less_than_equal maps to $lte natively', () => {
      const result = splitWhere({ views: { less_than_equal: 100 } })
      expect(result.nativeFilter).toEqual({ views: { $lte: 100 } })
      expect(result.postFilter).toBeNull()
    })
  })

  describe('non-native operators go to postFilter', () => {
    test('like goes to postFilter', () => {
      const result = splitWhere({ tags: { like: '%javascript%' } })
      expect(result.nativeFilter).toBeNull()
      expect(result.postFilter).toEqual({ tags: { like: '%javascript%' } })
    })

    test('contains goes to postFilter', () => {
      const result = splitWhere({ category: { contains: 'tech' } })
      expect(result.nativeFilter).toBeNull()
      expect(result.postFilter).toEqual({ category: { contains: 'tech' } })
    })

    test('exists goes to postFilter', () => {
      const result = splitWhere({ category: { exists: true } })
      expect(result.nativeFilter).toBeNull()
      expect(result.postFilter).toEqual({ category: { exists: true } })
    })
  })

  describe('and operator', () => {
    test('splits and conditions into native and post', () => {
      const result = splitWhere({
        and: [
          { status: { equals: 'published' } },
          { tags: { like: '%javascript%' } },
        ],
      })
      expect(result.nativeFilter).toEqual({ status: { $eq: 'published' } })
      expect(result.postFilter).toEqual({ tags: { like: '%javascript%' } })
    })

    test('all native conditions stay native', () => {
      const result = splitWhere({
        and: [
          { status: { equals: 'published' } },
          { views: { greater_than: 100 } },
        ],
      })
      expect(result.nativeFilter).toEqual({
        status: { $eq: 'published' },
        views: { $gt: 100 },
      })
      expect(result.postFilter).toBeNull()
    })

    test('all post conditions stay post', () => {
      const result = splitWhere({
        and: [
          { tags: { like: '%js%' } },
          { category: { contains: 'tech' } },
        ],
      })
      expect(result.nativeFilter).toBeNull()
      expect(result.postFilter).toEqual({
        and: [
          { tags: { like: '%js%' } },
          { category: { contains: 'tech' } },
        ],
      })
    })
  })

  describe('or operator', () => {
    test('entire or goes to postFilter (Vectorize does not support native or)', () => {
      const where: Where = {
        or: [
          { status: { equals: 'draft' } },
          { status: { equals: 'archived' } },
        ],
      }
      const result = splitWhere(where)
      expect(result.nativeFilter).toBeNull()
      expect(result.postFilter).toEqual(where)
    })
  })

  describe('mixed conditions', () => {
    test('multiple field conditions split correctly', () => {
      const result = splitWhere({
        status: { equals: 'published' },
        tags: { contains: 'javascript' },
      } as Where)
      expect(result.nativeFilter).toEqual({ status: { $eq: 'published' } })
      expect(result.postFilter).toEqual({ tags: { contains: 'javascript' } })
    })
  })
})

describe('CF adapter - matchesPostFilter', () => {
  const doc = {
    status: 'published',
    category: 'tech',
    views: 150,
    rating: 4.5,
    tags: 'javascript,nodejs,programming',
    published: true,
  }

  describe('equals / not_equals', () => {
    test('equals matches', () => {
      expect(matchesPostFilter(doc, { status: { equals: 'published' } })).toBe(true)
    })

    test('equals rejects', () => {
      expect(matchesPostFilter(doc, { status: { equals: 'draft' } })).toBe(false)
    })

    test('not_equals matches', () => {
      expect(matchesPostFilter(doc, { status: { not_equals: 'draft' } })).toBe(true)
    })

    test('not_equals rejects', () => {
      expect(matchesPostFilter(doc, { status: { not_equals: 'published' } })).toBe(false)
    })

    test('notEquals matches', () => {
      expect(matchesPostFilter(doc, { status: { notEquals: 'draft' } })).toBe(true)
    })
  })

  describe('in / notIn', () => {
    test('in matches', () => {
      expect(matchesPostFilter(doc, { status: { in: ['published', 'draft'] } })).toBe(true)
    })

    test('in rejects', () => {
      expect(matchesPostFilter(doc, { status: { in: ['draft', 'archived'] } })).toBe(false)
    })

    test('not_in matches', () => {
      expect(matchesPostFilter(doc, { status: { not_in: ['draft', 'archived'] } })).toBe(true)
    })

    test('not_in rejects', () => {
      expect(matchesPostFilter(doc, { status: { not_in: ['published'] } })).toBe(false)
    })

    test('notIn matches', () => {
      expect(matchesPostFilter(doc, { status: { notIn: ['draft'] } })).toBe(true)
    })
  })

  describe('like / contains', () => {
    test('like with wildcards matches', () => {
      expect(matchesPostFilter(doc, { tags: { like: '%javascript%' } })).toBe(true)
    })

    test('like rejects non-matching', () => {
      expect(matchesPostFilter(doc, { tags: { like: '%python%' } })).toBe(false)
    })

    test('like is case insensitive', () => {
      expect(matchesPostFilter(doc, { tags: { like: '%JavaScript%' } })).toBe(true)
    })

    test('like treats regex special characters as literals', () => {
      expect(matchesPostFilter(doc, { tags: { like: '%node.s%' } })).toBe(false)
      expect(matchesPostFilter(doc, { tags: { like: '%nodejs%' } })).toBe(true)
    })

    test('contains matches substring', () => {
      expect(matchesPostFilter(doc, { category: { contains: 'tech' } })).toBe(true)
    })

    test('contains rejects non-matching', () => {
      expect(matchesPostFilter(doc, { category: { contains: 'design' } })).toBe(false)
    })

    test('contains is case insensitive', () => {
      expect(matchesPostFilter(doc, { category: { contains: 'Tech' } })).toBe(true)
    })
  })

  describe('comparison operators', () => {
    test('greater_than matches', () => {
      expect(matchesPostFilter(doc, { views: { greater_than: 100 } })).toBe(true)
    })

    test('greater_than rejects', () => {
      expect(matchesPostFilter(doc, { views: { greater_than: 200 } })).toBe(false)
    })

    test('greaterThan matches', () => {
      expect(matchesPostFilter(doc, { views: { greaterThan: 100 } })).toBe(true)
    })

    test('greater_than_equal matches on boundary', () => {
      expect(matchesPostFilter(doc, { views: { greater_than_equal: 150 } })).toBe(true)
    })

    test('less_than matches', () => {
      expect(matchesPostFilter(doc, { views: { less_than: 200 } })).toBe(true)
    })

    test('less_than rejects', () => {
      expect(matchesPostFilter(doc, { views: { less_than: 100 } })).toBe(false)
    })

    test('lessThan matches', () => {
      expect(matchesPostFilter(doc, { rating: { lessThan: 4.6 } })).toBe(true)
    })

    test('less_than_equal matches on boundary', () => {
      expect(matchesPostFilter(doc, { views: { less_than_equal: 150 } })).toBe(true)
    })
  })

  describe('exists operator', () => {
    test('exists true matches present field', () => {
      expect(matchesPostFilter(doc, { category: { exists: true } })).toBe(true)
    })

    test('exists true rejects null field', () => {
      expect(matchesPostFilter({ ...doc, category: null }, { category: { exists: true } })).toBe(false)
    })

    test('exists false matches null field', () => {
      expect(matchesPostFilter({ ...doc, category: null }, { category: { exists: false } })).toBe(true)
    })

    test('exists false matches undefined field', () => {
      const { category, ...noCategory } = doc
      expect(matchesPostFilter(noCategory, { category: { exists: false } })).toBe(true)
    })

    test('exists false rejects present field', () => {
      expect(matchesPostFilter(doc, { category: { exists: false } })).toBe(false)
    })
  })

  describe('and / or', () => {
    test('and: all conditions must match', () => {
      expect(matchesPostFilter(doc, {
        and: [
          { status: { equals: 'published' } },
          { category: { equals: 'tech' } },
        ],
      })).toBe(true)
    })

    test('and: fails if any condition fails', () => {
      expect(matchesPostFilter(doc, {
        and: [
          { status: { equals: 'published' } },
          { category: { equals: 'design' } },
        ],
      })).toBe(false)
    })

    test('or: matches if any condition matches', () => {
      expect(matchesPostFilter(doc, {
        or: [
          { status: { equals: 'draft' } },
          { category: { equals: 'tech' } },
        ],
      })).toBe(true)
    })

    test('or: fails if no condition matches', () => {
      expect(matchesPostFilter(doc, {
        or: [
          { status: { equals: 'draft' } },
          { category: { equals: 'design' } },
        ],
      })).toBe(false)
    })
  })

  describe('nested logic', () => {
    test('and/or combination: (published AND tech) OR draft', () => {
      expect(matchesPostFilter(doc, {
        or: [
          {
            and: [
              { status: { equals: 'published' } },
              { category: { equals: 'tech' } },
            ],
          },
          { status: { equals: 'draft' } },
        ],
      })).toBe(true)
    })

    test('or within and', () => {
      expect(matchesPostFilter(doc, {
        and: [
          {
            or: [
              { status: { equals: 'published' } },
              { status: { equals: 'draft' } },
            ],
          },
          { views: { greater_than: 100 } },
        ],
      })).toBe(true)
    })

    test('nested fails correctly', () => {
      expect(matchesPostFilter(doc, {
        and: [
          {
            or: [
              { status: { equals: 'draft' } },
              { status: { equals: 'archived' } },
            ],
          },
          { views: { greater_than: 100 } },
        ],
      })).toBe(false)
    })
  })

  describe('edge cases', () => {
    test('empty where matches everything', () => {
      expect(matchesPostFilter(doc, {} as Where)).toBe(true)
    })

    test('undefined field returns false for equals', () => {
      expect(matchesPostFilter(doc, { nonExistent: { equals: 'value' } })).toBe(false)
    })
  })
})
