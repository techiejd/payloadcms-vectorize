// adapters/mongodb/src/convertWhere.ts
import type { Where } from 'payload'
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

export function convertWhereToMongo(
  where: Where,
  filterable: string[],
  poolName: string,
): ConvertResult {
  // Single-field leaf with only pre-filter operators (the simple, most-common path).
  const keys = Object.keys(where).filter((k) => k !== 'and' && k !== 'or')
  if (keys.length === 1) {
    const field = keys[0]
    const cond = where[field] as Record<string, unknown>
    if (!isFilterable(field, filterable)) {
      throw new Error(
        `[@payloadcms-vectorize/mongodb] Field "${field}" is not configured as filterableFields for pool "${poolName}"`,
      )
    }
    for (const op of Object.keys(cond)) {
      if (UNSUPPORTED_OPS.has(op)) {
        throw new Error(
          `[@payloadcms-vectorize/mongodb] Operator "${op}" is not supported`,
        )
      }
    }
    const onlyPreOps = Object.keys(cond).every(
      (op) => PRE_OPS.has(op) || op === 'exists',
    )
    if (onlyPreOps) {
      return { preFilter: leafToPre(field, cond), postFilter: null }
    }
  }
  // Tasks 6–8 expand this; for now, throw for unimplemented paths.
  throw new Error('[@payloadcms-vectorize/mongodb] convertWhereToMongo: path not implemented yet')
}

// POST_OPS is referenced by Task 6 — silences TS unused-symbol warnings until then.
void POST_OPS
