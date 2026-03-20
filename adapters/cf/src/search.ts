import { BasePayload, Where } from 'payload'
import { KnowledgePoolName, VectorSearchResult } from 'payloadcms-vectorize'
import { getVectorizeBinding } from './types.js'

export default async (
  payload: BasePayload,
  queryEmbedding: number[],
  poolName: KnowledgePoolName,
  limit: number = 10,
  where?: Where,
): Promise<Array<VectorSearchResult>> => {
  const vectorizeBinding = getVectorizeBinding(payload)

  try {
    const queryOptions: Record<string, any> = {
      topK: limit,
      returnMetadata: 'all' as const,
    }

    let postFilter: Where | null = null

    if (where) {
      const split = splitWhere(where)
      if (split.nativeFilter && Object.keys(split.nativeFilter).length > 0) {
        queryOptions.filter = split.nativeFilter
      }
      postFilter = split.postFilter
    }

    const results = await vectorizeBinding.query(queryEmbedding, queryOptions)

    if (!results.matches) {
      return []
    }

    const RESERVED_METADATA = ['sourceCollection', 'docId', 'chunkIndex', 'chunkText', 'embeddingVersion']

    let searchResults: VectorSearchResult[] = results.matches.map((match) => {
      const metadata = match.metadata || {}
      const extensionFields = Object.fromEntries(
        Object.entries(metadata).filter(([k]) => !RESERVED_METADATA.includes(k))
      )
      return {
        id: match.id,
        score: match.score || 0,
        sourceCollection: String(metadata.sourceCollection || ''),
        docId: String(metadata.docId || ''),
        chunkIndex: typeof metadata.chunkIndex === 'number' ? metadata.chunkIndex : parseInt(String(metadata.chunkIndex || '0'), 10),
        chunkText: String(metadata.chunkText || ''),
        embeddingVersion: String(metadata.embeddingVersion || ''),
        ...extensionFields,
      }
    })

    if (postFilter) {
      searchResults = searchResults.filter((r) => matchesPostFilter(r, postFilter!))
    }

    return searchResults
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e)
    payload.logger.error(`[@payloadcms-vectorize/cf] Search failed: ${errorMessage}`)
    throw new Error(`[@payloadcms-vectorize/cf] Search failed: ${errorMessage}`)
  }
}

export type VectorizeFilter = Record<string, Record<string, unknown>>

export interface FilterSplit {
  nativeFilter: VectorizeFilter | null
  postFilter: Where | null
}

const NATIVE_OPERATOR_MAP: Record<string, string> = {
  equals: '$eq',
  not_equals: '$ne',
  notEquals: '$ne',
  in: '$in',
  not_in: '$nin',
  notIn: '$nin',
  greater_than: '$gt',
  greaterThan: '$gt',
  greater_than_equal: '$gte',
  greaterThanEqual: '$gte',
  less_than: '$lt',
  lessThan: '$lt',
  less_than_equal: '$lte',
  lessThanEqual: '$lte',
}

export function splitWhere(where: Where): FilterSplit {
  const nativeFilter: VectorizeFilter = {}
  const postFilterClauses: Where[] = []

  if ('and' in where && Array.isArray(where.and)) {
    for (const clause of where.and) {
      const split = splitWhere(clause)
      if (split.nativeFilter) {
        Object.assign(nativeFilter, split.nativeFilter)
      }
      if (split.postFilter) {
        postFilterClauses.push(split.postFilter)
      }
    }
    return {
      nativeFilter: Object.keys(nativeFilter).length > 0 ? nativeFilter : null,
      postFilter: postFilterClauses.length > 0
        ? (postFilterClauses.length === 1 ? postFilterClauses[0] : { and: postFilterClauses })
        : null,
    }
  }

  if ('or' in where && Array.isArray(where.or)) {
    return { nativeFilter: null, postFilter: where }
  }

  for (const [fieldName, condition] of Object.entries(where)) {
    if (fieldName === 'and' || fieldName === 'or') continue
    if (typeof condition !== 'object' || condition === null || Array.isArray(condition)) continue

    const cond = condition as Record<string, unknown>
    let handled = false

    for (const [payloadOp, cfOp] of Object.entries(NATIVE_OPERATOR_MAP)) {
      if (payloadOp in cond) {
        nativeFilter[fieldName] = { [cfOp]: cond[payloadOp] }
        handled = true
        break
      }
    }

    if (!handled) {
      postFilterClauses.push({ [fieldName]: condition } as Where)
    }
  }

  return {
    nativeFilter: Object.keys(nativeFilter).length > 0 ? nativeFilter : null,
    postFilter: postFilterClauses.length > 0
      ? (postFilterClauses.length === 1 ? postFilterClauses[0] : { and: postFilterClauses })
      : null,
  }
}

export function matchesPostFilter(doc: Record<string, any>, where: Where): boolean {
  if (!where || Object.keys(where).length === 0) return true

  if ('and' in where && Array.isArray(where.and)) {
    return where.and.every((clause: Where) => matchesPostFilter(doc, clause))
  }

  if ('or' in where && Array.isArray(where.or)) {
    return where.or.some((clause: Where) => matchesPostFilter(doc, clause))
  }

  for (const [field, condition] of Object.entries(where)) {
    if (field === 'and' || field === 'or') continue
    if (typeof condition !== 'object' || condition === null) continue

    const value = doc[field]
    const cond = condition as Record<string, unknown>

    if ('like' in cond && typeof cond.like === 'string') {
      const pattern = String(cond.like)
        .replace(/%/g, '\x00')
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\x00/g, '.*')
      if (!new RegExp(`^${pattern}$`, 'i').test(String(value ?? ''))) return false
    }

    if ('contains' in cond && typeof cond.contains === 'string') {
      if (!String(value ?? '').toLowerCase().includes(String(cond.contains).toLowerCase())) return false
    }

    if ('exists' in cond && typeof cond.exists === 'boolean') {
      const exists = value !== undefined && value !== null
      if (cond.exists !== exists) return false
    }

    if ('equals' in cond && value !== cond.equals) return false
    if ('not_equals' in cond && value === cond.not_equals) return false
    if ('notEquals' in cond && value === cond.notEquals) return false
    if ('in' in cond && Array.isArray(cond.in) && !cond.in.includes(value)) return false
    if ('not_in' in cond && Array.isArray(cond.not_in) && cond.not_in.includes(value)) return false
    if ('notIn' in cond && Array.isArray(cond.notIn) && (cond.notIn as any[]).includes(value)) return false
    if ('greater_than' in cond && !(value > (cond.greater_than as any))) return false
    if ('greaterThan' in cond && !(value > (cond.greaterThan as any))) return false
    if ('greater_than_equal' in cond && !(value >= (cond.greater_than_equal as any))) return false
    if ('greaterThanEqual' in cond && !(value >= (cond.greaterThanEqual as any))) return false
    if ('less_than' in cond && !(value < (cond.less_than as any))) return false
    if ('lessThan' in cond && !(value < (cond.lessThan as any))) return false
    if ('less_than_equal' in cond && !(value <= (cond.less_than_equal as any))) return false
    if ('lessThanEqual' in cond && !(value <= (cond.lessThanEqual as any))) return false
  }

  return true
}
