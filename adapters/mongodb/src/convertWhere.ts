import type { Where } from 'payload'
import { escapeRegExp } from './escapeRegExp.js'
import { RESERVED_FILTER_FIELDS } from './types.js'

export interface ConvertResult {
  preFilter: Record<string, unknown> | null
  postFilter: Where | null
}

const PRE_OPS = new Map<string, string>([
  ['equals', '$eq'],
  ['not_equals', '$ne'],
  ['notEquals', '$ne'],
  ['in', '$in'],
  ['not_in', '$nin'],
  ['notIn', '$nin'],
  ['greater_than', '$gt'],
  ['greaterThan', '$gt'],
  ['greater_than_equal', '$gte'],
  ['greaterThanEqual', '$gte'],
  ['less_than', '$lt'],
  ['lessThan', '$lt'],
  ['less_than_equal', '$lte'],
  ['lessThanEqual', '$lte'],
])

const POST_OPS = new Set(['like', 'contains', 'all'])
const UNSUPPORTED_OPS = new Set(['near', 'within', 'intersects'])

function isFilterable(field: string, filterable: string[]): boolean {
  return (
    (RESERVED_FILTER_FIELDS as readonly string[]).includes(field) ||
    filterable.includes(field)
  )
}

function leafToPre(field: string, cond: Record<string, unknown>): Record<string, unknown> {
  const clauses: Record<string, unknown>[] = []
  for (const [op, val] of Object.entries(cond)) {
    if (op === 'exists') {
      if (val === true) {
        clauses.push({ [field]: { $exists: true, $ne: null } })
      } else {
        clauses.push({ $or: [{ [field]: { $exists: false } }, { [field]: { $eq: null } }] })
      }
      continue
    }
    const mongoOp = PRE_OPS.get(op)
    if (!mongoOp) continue
    clauses.push({ [field]: { [mongoOp]: val } })
  }
  if (clauses.length === 0) return {}
  if (clauses.length === 1) return clauses[0]
  return { $and: clauses }
}

function convertLeaf(
  where: Where,
  filterable: string[],
  poolName: string,
): ConvertResult {
  const keys = Object.keys(where)
  if (keys.length !== 1) {
    // Multiple top-level fields on the same object: treat as implicit AND.
    const synthetic: Where = { and: keys.map((k) => ({ [k]: where[k] }) as Where) }
    return convertWhereToMongo(synthetic, filterable, poolName)
  }
  const field = keys[0]
  const cond = where[field] as Record<string, unknown>
  if (!isFilterable(field, filterable)) {
    throw new Error(
      `[@payloadcms-vectorize/mongodb] Field "${field}" is not configured as filterableFields for pool "${poolName}"`,
    )
  }
  for (const op of Object.keys(cond)) {
    if (UNSUPPORTED_OPS.has(op)) {
      throw new Error(`[@payloadcms-vectorize/mongodb] Operator "${op}" is not supported`)
    }
  }
  const hasPostOp = Object.keys(cond).some((op) => POST_OPS.has(op))
  if (hasPostOp) {
    return { preFilter: null, postFilter: { [field]: cond } as Where }
  }
  return { preFilter: leafToPre(field, cond), postFilter: null }
}

export function convertWhereToMongo(
  where: Where,
  filterable: string[],
  poolName: string,
): ConvertResult {
  if ('and' in where && Array.isArray(where.and)) {
    const branches = where.and.map((b) => convertWhereToMongo(b, filterable, poolName))
    const preBranches = branches.filter((b) => b.preFilter).map((b) => b.preFilter!)
    const postBranches = branches.filter((b) => b.postFilter).map((b) => b.postFilter!)
    const preFilter =
      preBranches.length === 0
        ? null
        : preBranches.length === 1
          ? preBranches[0]
          : { $and: preBranches }
    const postFilter =
      postBranches.length === 0
        ? null
        : postBranches.length === 1
          ? postBranches[0]
          : ({ and: postBranches } as Where)
    return { preFilter, postFilter }
  }

  if ('or' in where && Array.isArray(where.or)) {
    const branches = where.or.map((b) => convertWhereToMongo(b, filterable, poolName))
    const anyPost = branches.some((b) => b.postFilter !== null)
    if (anyPost) {
      // Entire OR goes post — semantics require the whole disjunction to apply
      // to the post-vectorSearch document set.
      return { preFilter: null, postFilter: where }
    }
    const preBranches = branches.map((b) => b.preFilter!).filter((p) => p)
    const preFilter =
      preBranches.length === 0
        ? null
        : preBranches.length === 1
          ? preBranches[0]
          : { $or: preBranches }
    return { preFilter, postFilter: null }
  }

  return convertLeaf(where, filterable, poolName)
}

function valueMatchesOp(value: unknown, op: string, operand: unknown): boolean {
  switch (op) {
    case 'equals':
      return value === operand
    case 'not_equals':
    case 'notEquals':
      return value !== operand
    case 'in':
      return Array.isArray(operand) && operand.includes(value as never)
    case 'not_in':
    case 'notIn':
      return Array.isArray(operand) && !operand.includes(value as never)
    case 'greater_than':
    case 'greaterThan':
      return typeof value === 'number' && typeof operand === 'number' && value > operand
    case 'greater_than_equal':
    case 'greaterThanEqual':
      return typeof value === 'number' && typeof operand === 'number' && value >= operand
    case 'less_than':
    case 'lessThan':
      return typeof value === 'number' && typeof operand === 'number' && value < operand
    case 'less_than_equal':
    case 'lessThanEqual':
      return typeof value === 'number' && typeof operand === 'number' && value <= operand
    case 'exists':
      return operand
        ? value !== undefined && value !== null
        : value === undefined || value === null
    case 'like':
    case 'contains': {
      if (typeof operand !== 'string') return false
      const re = new RegExp(escapeRegExp(operand), 'i')
      if (Array.isArray(value)) {
        return value.some((v) => typeof v === 'string' && re.test(v))
      }
      return typeof value === 'string' && re.test(value)
    }
    case 'all':
      return (
        Array.isArray(value) &&
        Array.isArray(operand) &&
        operand.every((o) => value.includes(o as never))
      )
    default:
      return false
  }
}

export function evaluatePostFilter(doc: Record<string, unknown>, where: Where): boolean {
  if (!where || Object.keys(where).length === 0) return true
  if ('and' in where && Array.isArray(where.and)) {
    return where.and.every((c: Where) => evaluatePostFilter(doc, c))
  }
  if ('or' in where && Array.isArray(where.or)) {
    return where.or.some((c: Where) => evaluatePostFilter(doc, c))
  }
  for (const [field, condition] of Object.entries(where)) {
    if (field === 'and' || field === 'or') continue
    if (typeof condition !== 'object' || condition === null) continue
    const cond = condition as Record<string, unknown>
    for (const [op, operand] of Object.entries(cond)) {
      if (!valueMatchesOp(doc[field], op, operand)) return false
    }
  }
  return true
}
