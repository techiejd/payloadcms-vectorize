// adapters/mongodb/dev/specs/convertWhere.spec.ts
import { describe, expect, test } from 'vitest'
import { convertWhereToMongo } from '../../src/convertWhere.js'

const FILTERABLE = ['status', 'category', 'views', 'rating', 'published', 'tags']

describe('convertWhereToMongo — pre-filter operators', () => {
  test('equals', () => {
    expect(
      convertWhereToMongo({ status: { equals: 'published' } }, FILTERABLE, 'p1'),
    ).toEqual({ preFilter: { status: { $eq: 'published' } }, postFilter: null })
  })

  test('not_equals (snake) and notEquals (camel)', () => {
    expect(
      convertWhereToMongo({ status: { not_equals: 'draft' } }, FILTERABLE, 'p1'),
    ).toEqual({ preFilter: { status: { $ne: 'draft' } }, postFilter: null })
    expect(
      convertWhereToMongo({ status: { notEquals: 'draft' } }, FILTERABLE, 'p1'),
    ).toEqual({ preFilter: { status: { $ne: 'draft' } }, postFilter: null })
  })

  test('in / not_in / notIn', () => {
    expect(
      convertWhereToMongo({ status: { in: ['a', 'b'] } }, FILTERABLE, 'p1'),
    ).toEqual({ preFilter: { status: { $in: ['a', 'b'] } }, postFilter: null })
    expect(
      convertWhereToMongo({ status: { not_in: ['a'] } }, FILTERABLE, 'p1'),
    ).toEqual({ preFilter: { status: { $nin: ['a'] } }, postFilter: null })
    expect(
      convertWhereToMongo({ status: { notIn: ['a'] } }, FILTERABLE, 'p1'),
    ).toEqual({ preFilter: { status: { $nin: ['a'] } }, postFilter: null })
  })

  test('greater_than / greaterThan / less_than_equal etc.', () => {
    expect(
      convertWhereToMongo({ views: { greater_than: 100 } }, FILTERABLE, 'p1'),
    ).toEqual({ preFilter: { views: { $gt: 100 } }, postFilter: null })
    expect(
      convertWhereToMongo({ views: { greaterThan: 100 } }, FILTERABLE, 'p1'),
    ).toEqual({ preFilter: { views: { $gt: 100 } }, postFilter: null })
    expect(
      convertWhereToMongo({ views: { greater_than_equal: 100 } }, FILTERABLE, 'p1'),
    ).toEqual({ preFilter: { views: { $gte: 100 } }, postFilter: null })
    expect(
      convertWhereToMongo({ views: { less_than: 100 } }, FILTERABLE, 'p1'),
    ).toEqual({ preFilter: { views: { $lt: 100 } }, postFilter: null })
    expect(
      convertWhereToMongo({ views: { less_than_equal: 100 } }, FILTERABLE, 'p1'),
    ).toEqual({ preFilter: { views: { $lte: 100 } }, postFilter: null })
  })

  test('exists true → $exists + $ne null', () => {
    expect(
      convertWhereToMongo({ category: { exists: true } }, FILTERABLE, 'p1'),
    ).toEqual({
      preFilter: { category: { $exists: true, $ne: null } },
      postFilter: null,
    })
  })

  test('exists false → $exists false OR $eq null', () => {
    expect(
      convertWhereToMongo({ category: { exists: false } }, FILTERABLE, 'p1'),
    ).toEqual({
      preFilter: { $or: [{ category: { $exists: false } }, { category: { $eq: null } }] },
      postFilter: null,
    })
  })

  test('multiple operators on same field combine via $and', () => {
    const result = convertWhereToMongo(
      { views: { greater_than: 50, less_than: 200 } },
      FILTERABLE,
      'p1',
    )
    expect(result).toEqual({
      preFilter: { $and: [{ views: { $gt: 50 } }, { views: { $lt: 200 } }] },
      postFilter: null,
    })
  })

  test('reserved field always usable even when filterableFields is empty', () => {
    expect(
      convertWhereToMongo(
        { sourceCollection: { equals: 'articles' } },
        [],
        'p1',
      ),
    ).toEqual({
      preFilter: { sourceCollection: { $eq: 'articles' } },
      postFilter: null,
    })
  })
})

describe('convertWhereToMongo — post-filter operators', () => {
  test('like routes the whole leaf to post-filter (verbatim Where)', () => {
    expect(
      convertWhereToMongo({ tags: { like: 'javascript' } }, FILTERABLE, 'p1'),
    ).toEqual({
      preFilter: null,
      postFilter: { tags: { like: 'javascript' } },
    })
  })

  test('contains routes the whole leaf to post-filter', () => {
    expect(
      convertWhereToMongo({ category: { contains: 'tech' } }, FILTERABLE, 'p1'),
    ).toEqual({
      preFilter: null,
      postFilter: { category: { contains: 'tech' } },
    })
  })

  test('mixed pre + post operators on same leaf → entire leaf goes to post', () => {
    expect(
      convertWhereToMongo(
        { tags: { equals: 'a', like: 'javascript' } },
        FILTERABLE,
        'p1',
      ),
    ).toEqual({
      preFilter: null,
      postFilter: { tags: { equals: 'a', like: 'javascript' } },
    })
  })

  test('all routes to post-filter', () => {
    expect(
      convertWhereToMongo({ tags: { all: ['a', 'b'] } }, FILTERABLE, 'p1'),
    ).toEqual({
      preFilter: null,
      postFilter: { tags: { all: ['a', 'b'] } },
    })
  })

  test('unsupported geo op throws', () => {
    expect(() =>
      convertWhereToMongo({ loc: { near: [0, 0] } }, ['loc'], 'p1'),
    ).toThrowError(/not supported/)
  })
})

describe('convertWhereToMongo — and/or composition', () => {
  test('and: all branches pre → combined preFilter via $and', () => {
    const result = convertWhereToMongo(
      {
        and: [
          { status: { equals: 'published' } },
          { views: { greater_than: 100 } },
        ],
      },
      FILTERABLE,
      'p1',
    )
    expect(result).toEqual({
      preFilter: {
        $and: [
          { status: { $eq: 'published' } },
          { views: { $gt: 100 } },
        ],
      },
      postFilter: null,
    })
  })

  test('and: mix of pre + post → pre kept native, post in {and:[...]}', () => {
    const result = convertWhereToMongo(
      {
        and: [
          { status: { equals: 'published' } },
          { tags: { like: 'javascript' } },
        ],
      },
      FILTERABLE,
      'p1',
    )
    expect(result).toEqual({
      preFilter: { status: { $eq: 'published' } },
      postFilter: { tags: { like: 'javascript' } },
    })
  })

  test('or: all branches pre → combined preFilter via $or', () => {
    const result = convertWhereToMongo(
      {
        or: [
          { status: { equals: 'draft' } },
          { status: { equals: 'archived' } },
        ],
      },
      FILTERABLE,
      'p1',
    )
    expect(result).toEqual({
      preFilter: {
        $or: [
          { status: { $eq: 'draft' } },
          { status: { $eq: 'archived' } },
        ],
      },
      postFilter: null,
    })
  })

  test('or: any branch is post → entire or goes to post-filter', () => {
    const where: any = {
      or: [
        { status: { equals: 'published' } },
        { tags: { like: 'javascript' } },
      ],
    }
    const result = convertWhereToMongo(where, FILTERABLE, 'p1')
    expect(result.preFilter).toBeNull()
    expect(result.postFilter).toEqual(where)
  })

  test('nested and/or: (published AND tech) OR (archived)', () => {
    const where: any = {
      or: [
        {
          and: [
            { status: { equals: 'published' } },
            { category: { equals: 'tech' } },
          ],
        },
        { status: { equals: 'archived' } },
      ],
    }
    const result = convertWhereToMongo(where, FILTERABLE, 'p1')
    expect(result.preFilter).toEqual({
      $or: [
        { $and: [{ status: { $eq: 'published' } }, { category: { $eq: 'tech' } }] },
        { status: { $eq: 'archived' } },
      ],
    })
    expect(result.postFilter).toBeNull()
  })

  test('and with single condition reduces to that condition', () => {
    const result = convertWhereToMongo(
      { and: [{ status: { equals: 'published' } }] },
      FILTERABLE,
      'p1',
    )
    expect(result).toEqual({
      preFilter: { status: { $eq: 'published' } },
      postFilter: null,
    })
  })
})

import { evaluatePostFilter } from '../../src/convertWhere.js'

describe('evaluatePostFilter', () => {
  test('like with case-insensitive substring match', () => {
    expect(
      evaluatePostFilter({ tags: 'JavaScript' }, { tags: { like: 'javascript' } }),
    ).toBe(true)
    expect(
      evaluatePostFilter({ tags: 'python' }, { tags: { like: 'javascript' } }),
    ).toBe(false)
  })

  test('contains works on scalar string', () => {
    expect(
      evaluatePostFilter({ category: 'technology' }, { category: { contains: 'tech' } }),
    ).toBe(true)
    expect(
      evaluatePostFilter({ category: 'design' }, { category: { contains: 'tech' } }),
    ).toBe(false)
  })

  test('contains on array uses elemMatch-style', () => {
    expect(
      evaluatePostFilter({ tags: ['react', 'javascript'] }, { tags: { contains: 'java' } }),
    ).toBe(true)
    expect(
      evaluatePostFilter({ tags: ['python'] }, { tags: { contains: 'java' } }),
    ).toBe(false)
  })

  test('like with regex special chars does NOT match unintended values', () => {
    // Pattern "foo.bar" must match the literal dot, not any char.
    expect(
      evaluatePostFilter({ tags: 'fooXbar' }, { tags: { like: 'foo.bar' } }),
    ).toBe(false)
    expect(
      evaluatePostFilter({ tags: 'foo.bar' }, { tags: { like: 'foo.bar' } }),
    ).toBe(true)
  })

  test('all on array', () => {
    expect(
      evaluatePostFilter({ tags: ['a', 'b', 'c'] }, { tags: { all: ['a', 'b'] } }),
    ).toBe(true)
    expect(
      evaluatePostFilter({ tags: ['a'] }, { tags: { all: ['a', 'b'] } }),
    ).toBe(false)
  })

  test('and combinator', () => {
    const w: any = {
      and: [
        { status: { equals: 'published' } },
        { tags: { like: 'javascript' } },
      ],
    }
    expect(
      evaluatePostFilter({ status: 'published', tags: 'JavaScript,react' }, w),
    ).toBe(true)
    expect(
      evaluatePostFilter({ status: 'draft', tags: 'JavaScript,react' }, w),
    ).toBe(false)
  })

  test('or combinator', () => {
    const w: any = {
      or: [
        { status: { equals: 'published' } },
        { tags: { like: 'javascript' } },
      ],
    }
    expect(evaluatePostFilter({ status: 'published', tags: 'python' }, w)).toBe(true)
    expect(evaluatePostFilter({ status: 'draft', tags: 'JavaScript' }, w)).toBe(true)
    expect(evaluatePostFilter({ status: 'draft', tags: 'python' }, w)).toBe(false)
  })

  test('pre-filter operators also evaluable in post path (for OR mixed branches)', () => {
    expect(
      evaluatePostFilter({ status: 'published' }, { status: { equals: 'published' } }),
    ).toBe(true)
    expect(
      evaluatePostFilter({ views: 150 }, { views: { greater_than: 100 } }),
    ).toBe(true)
    expect(
      evaluatePostFilter({ views: 50 }, { views: { greater_than: 100 } }),
    ).toBe(false)
  })
})
