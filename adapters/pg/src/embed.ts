import { Payload } from 'payload'
import { isPostgresPayload } from './types.js'
import toSnakeCase from 'to-snake-case'

export default async (
  payload: Payload,
  poolName: string,
  id: string,
  embedding: number[] | Float32Array,
) => {
  if (!isPostgresPayload(payload)) {
    throw new Error('[@payloadcms-vectorize/pg] Only works with Postgres')
  }
  // After the type guard, payload is narrowed to PostgresPayload
  const runSQL = async (sql: string, params?: unknown[]) => {
    if (payload.db.pool?.query) return payload.db.pool.query(sql, params)
    if (payload.db.drizzle?.execute) return payload.db.drizzle.execute(sql)
    throw new Error('[@payloadcms-vectorize/pg] Failed to persist vector column')
  }
  const pgVectorLiteral = `[${Array.from(embedding).join(',')}]`
  const schemaName = payload.db.schemaName || 'public'
  // Drizzle converts camelCase collection slugs to snake_case table names
  const sqlStatement = `UPDATE "${schemaName}"."${toSnakeCase(poolName)}" SET embedding = $1 WHERE id = $2`
  try {
    await runSQL(sqlStatement, [pgVectorLiteral, id])
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e)
    payload.logger.error(
      `[@payloadcms-vectorize/pg] Failed to persist vector column: ${errorMessage}`,
    )
    throw new Error(`[@payloadcms-vectorize/pg] Failed to persist vector column: ${errorMessage}`)
  }
}
