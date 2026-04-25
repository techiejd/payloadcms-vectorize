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
