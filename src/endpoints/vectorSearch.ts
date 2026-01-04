import type { BasePayload, PayloadHandler, Where } from 'payload'
import {
  sql,
  cosineDistance,
  inArray,
  eq,
  and,
  or,
  not,
  like,
  gt,
  gte,
  lt,
  lte,
  ne,
  isNull,
  isNotNull,
} from '@payloadcms/db-postgres/drizzle'

import toSnakeCase from 'to-snake-case'
import type {
  VectorSearchResult,
  KnowledgePoolName,
  KnowledgePoolDynamicConfig,
  VectorSearchQuery,
} from 'payloadcms-vectorize'
import { getEmbeddingsTable } from '../drizzle/tables.js'

export const createVectorSearchHandler = <TPoolNames extends KnowledgePoolName>(
  knowledgePools: Record<TPoolNames, KnowledgePoolDynamicConfig>,
) => {
  const _vectorSearch: PayloadHandler = async (req) => {
    if (!req || !req.json) {
      return Response.json({ error: 'Request is required' }, { status: 400 })
    }
    try {
      const {
        query,
        knowledgePool,
        where,
        limit = 10,
      }: VectorSearchQuery<TPoolNames> = await req.json()
      if (!query || typeof query !== 'string') {
        return Response.json({ error: 'Query is required and must be a string' }, { status: 400 })
      }
      if (!knowledgePool || typeof knowledgePool !== 'string') {
        return Response.json(
          { error: 'knowledgePool is required and must be a string' },
          { status: 400 },
        )
      }

      const poolConfig = knowledgePools[knowledgePool]
      if (!poolConfig) {
        return Response.json(
          { error: `Knowledge pool "${knowledgePool}" not found` },
          { status: 400 },
        )
      }

      const payload = req.payload

      // Generate embedding for the query using pool-specific queryFn
      const queryEmbedding = await (async () => {
        const qE = await poolConfig.embeddingConfig.queryFn(query)
        return Array.isArray(qE) ? qE : Array.from(qE)
      })()

      // Perform cosine similarity search using Drizzle
      const results = await performCosineSearch(
        payload,
        queryEmbedding,
        knowledgePool,
        limit,
        where,
      )

      return Response.json({ results })
    } catch (error) {
      return Response.json({ error: 'Internal server error' }, { status: 500 })
    }
  }
  return _vectorSearch
}

async function performCosineSearch(
  payload: BasePayload,
  queryEmbedding: number[],
  poolName: KnowledgePoolName,
  limit: number = 10,
  whereClause?: Where,
): Promise<Array<VectorSearchResult>> {
  const isPostgres = payload.db?.pool?.query || payload.db?.drizzle

  if (!isPostgres) {
    throw new Error('Only works with Postgres')
  }

  // In PayloadCMS, payload.db IS the adapter, and drizzle is at payload.db.drizzle
  const adapter = payload.db
  if (!adapter) {
    throw new Error('Drizzle adapter not found')
  }

  // Get drizzle instance
  const drizzle = adapter.drizzle
  if (!drizzle) {
    throw new Error('Drizzle instance not found in adapter')
  }

  // Get collection config and table name
  const collectionConfig = payload.collections[poolName]?.config
  if (!collectionConfig) {
    throw new Error(`Collection ${poolName} not found`)
  }

  const table = getEmbeddingsTable(poolName)
  if (!table) {
    throw new Error(
      `[payloadcms-vectorize] Embeddings table for knowledge pool "${poolName}" not registered. Ensure the plugin's afterSchemaInit hook ran and the pool exists.`,
    )
  }

  // Use Drizzle's query builder with cosineDistance function
  // cosineDistance returns distance, so we calculate similarity as 1 - distance
  // The table from fullSchema should have columns as direct properties
  const embeddingColumn = table.embedding
  if (!embeddingColumn) {
    throw new Error(
      `Embedding column not found in table for pool "${poolName}". Available properties: ${Object.keys(table).join(', ')}`,
    )
  }

  // Convert WHERE clause to Drizzle conditions
  let drizzleWhere: any = undefined
  if (whereClause) {
    drizzleWhere = convertWhereToDrizzle(whereClause, table, collectionConfig.flattenedFields)
    if (drizzleWhere === null) {
      // WHERE clause resulted in an empty condition (e.g., empty 'and' or 'or' array)
      // This semantically means "match nothing", so return empty results
      throw new Error(
        `[payloadcms-vectorize] WHERE clause resulted in no valid conditions. This typically occurs when using empty 'and' or 'or' arrays, or when all field conditions reference non-existent columns.`,
      )
    }
    if (drizzleWhere === undefined) {
      // WHERE clause could not be converted (invalid structure or unsupported operators)
      throw new Error(
        `[payloadcms-vectorize] WHERE clause could not be converted to Drizzle conditions. Please check that all field names exist and operators are supported.`,
      )
    }
  }

  // Build query using Drizzle's query builder
  // Column names in the table are camelCase (docId, chunkText, etc.)
  // but their database names are snake_case (doc_id, chunk_text, etc.)
  // The table from fullSchema should have columns as direct properties
  // Calculate similarity: 1 - cosineDistance (distance)
  // Need to cast 1 to numeric to avoid "integer - vector" error
  const distanceExpr = cosineDistance(embeddingColumn, queryEmbedding)

  // Build select object with similarity
  const selectObj: Record<string, any> = {
    id: table.id, // ensure we select id explicitly
    similarity: sql<number>`1 - (${distanceExpr})`,
  }

  // Add reserved + extension fields from collection config
  for (const field of collectionConfig.fields ?? []) {
    if (typeof field === 'object' && 'name' in field) {
      const name = field.name as string
      if (name in table) {
        selectObj[name] = table[name]
      } else if (toSnakeCase(name) in table) {
        selectObj[name] = table[toSnakeCase(name)]
      }
    }
  }

  let query: any = drizzle.select(selectObj).from(table)

  // Add WHERE clause if provided
  if (drizzleWhere) {
    query = query.where(drizzleWhere)
  }

  // Order by cosine distance (ascending = most similar first) and limit
  // Reuse the same distance expression for ordering
  query = query.orderBy(distanceExpr).limit(limit)

  // Execute the query
  const result = await query

  return mapRowsToResults(result, collectionConfig)
}

/**
 * Convert Payload WHERE clause to Drizzle conditions
 * Simplified version inspired by Payload's buildQuery
 */
function convertWhereToDrizzle(where: Where, table: any, fields: any[]): any {
  if (!where || typeof where !== 'object') {
    return undefined
  }

  // Handle 'and' operator
  if ('and' in where && Array.isArray(where.and)) {
    const conditions = where.and
      .map((condition) => convertWhereToDrizzle(condition, table, fields))
      .filter((c) => c !== undefined && c !== null)
    if (conditions.length === 0) return null
    if (conditions.length === 1) return conditions[0]
    return and(...conditions)
  }

  // Handle 'or' operator
  if ('or' in where && Array.isArray(where.or)) {
    const conditions = where.or
      .map((condition) => convertWhereToDrizzle(condition, table, fields))
      .filter((c) => c !== undefined && c !== null)
    if (conditions.length === 0) return null
    if (conditions.length === 1) return conditions[0]
    return or(...conditions)
  }

  // Handle field conditions - collect all field conditions and combine with AND
  const fieldConditions: any[] = []
  for (const [fieldName, condition] of Object.entries(where)) {
    if (fieldName === 'and' || fieldName === 'or') continue

    // Get the column from the table
    // Drizzle tables have columns as direct properties
    // Try camelCase first, then snake_case as fallback
    // Use 'in' operator to check existence, then access the property
    let column: any = undefined
    if (fieldName in table) {
      column = table[fieldName]
    } else if (toSnakeCase(fieldName) in table) {
      column = table[toSnakeCase(fieldName)]
    } else if (table.columns) {
      // Fallback to table.columns if it exists
      if (fieldName in table.columns) {
        column = table.columns[fieldName]
      } else if (toSnakeCase(fieldName) in table.columns) {
        column = table.columns[toSnakeCase(fieldName)]
      }
    }

    if (!column) {
      // Field not found, skip (could be a nested field we don't support)
      continue
    }

    if (typeof condition !== 'object' || condition === null || Array.isArray(condition)) {
      continue
    }

    const cond = condition as Record<string, any>

    // Handle equals
    if ('equals' in cond) {
      fieldConditions.push(eq(column, cond.equals))
      continue
    }

    // Handle not_equals / notEquals
    if ('not_equals' in cond || 'notEquals' in cond) {
      fieldConditions.push(ne(column, cond.not_equals ?? cond.notEquals))
      continue
    }

    // Handle in
    if ('in' in cond && Array.isArray(cond.in)) {
      fieldConditions.push(inArray(column, cond.in))
      continue
    }

    // Handle not_in / notIn
    if ('not_in' in cond || 'notIn' in cond) {
      const values = cond.not_in ?? cond.notIn
      if (Array.isArray(values)) {
        fieldConditions.push(not(inArray(column, values)))
      }
      continue
    }

    // Handle like
    if ('like' in cond && typeof cond.like === 'string') {
      fieldConditions.push(like(column, cond.like))
      continue
    }

    // Handle contains
    if ('contains' in cond && typeof cond.contains === 'string') {
      fieldConditions.push(like(column, `%${cond.contains}%`))
      continue
    }

    // Handle greater_than / greaterThan
    if ('greater_than' in cond || 'greaterThan' in cond) {
      fieldConditions.push(gt(column, cond.greater_than ?? cond.greaterThan))
      continue
    }

    // Handle greater_than_equal / greaterThanEqual
    if ('greater_than_equal' in cond || 'greaterThanEqual' in cond) {
      fieldConditions.push(gte(column, cond.greater_than_equal ?? cond.greaterThanEqual))
      continue
    }

    // Handle less_than / lessThan
    if ('less_than' in cond || 'lessThan' in cond) {
      fieldConditions.push(lt(column, cond.less_than ?? cond.lessThan))
      continue
    }

    // Handle less_than_equal / lessThanEqual
    if ('less_than_equal' in cond || 'lessThanEqual' in cond) {
      fieldConditions.push(lte(column, cond.less_than_equal ?? cond.lessThanEqual))
      continue
    }

    // Handle exists (null check)
    if ('exists' in cond && typeof cond.exists === 'boolean') {
      fieldConditions.push(cond.exists ? isNotNull(column) : isNull(column))
      continue
    }
  }

  // Combine all field conditions with AND
  if (fieldConditions.length === 0) {
    return undefined
  }
  if (fieldConditions.length === 1) {
    return fieldConditions[0]
  }
  return and(...fieldConditions)
}

function mapRowsToResults(rows: any[], collectionConfig: any): Array<VectorSearchResult> {
  // Collect names of fields that are typed as number on the collection
  const numberFields = new Set<string>()
  if (collectionConfig?.fields) {
    for (const field of collectionConfig.fields) {
      if (typeof field === 'object' && 'name' in field && field.type === 'number') {
        numberFields.add(field.name as string)
      }
    }
  }

  return rows.map((row: any) => {
    // Drizzle returns columns with the names we selected (camelCase)
    // Handle both camelCase and snake_case for robustness
    const rawDocId = row.docId ?? row.doc_id
    const rawChunkIndex = row.chunkIndex ?? row.chunk_index
    const rawSimilarity = row.similarity

    const result: any = {
      ...row,
      id: String(row.id),
      docId: String(rawDocId),
      similarity:
        typeof rawSimilarity === 'number' ? rawSimilarity : parseFloat(String(rawSimilarity)),
      chunkIndex:
        typeof rawChunkIndex === 'number' ? rawChunkIndex : parseInt(String(rawChunkIndex), 10),
    }

    // Ensure any number fields from the schema are numbers in the result
    for (const fieldName of numberFields) {
      const value = result[fieldName]
      if (value != null && typeof value !== 'number') {
        const parsed = parseFloat(String(value))
        if (!Number.isNaN(parsed)) {
          result[fieldName] = parsed
        }
      }
    }

    return result
  })
}
