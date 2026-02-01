import { Payload } from 'payload'
import { isPostgresPayload, PostgresPayload } from './types'
import toSnakeCase from 'to-snake-case'

export default async (
  payload: Payload,
  poolName: string,
  id: string,
  embedding: number[] | Float32Array,
) => {
  const isPostgres = isPostgresPayload(payload)
  if (!isPostgres) {
    throw new Error('[@payloadcms-vectorize/pg] Only works with Postgres')
  }
  const runSQL = async (sql: string, params?: any[]) => {
    if (postgresPayload.db.pool?.query) return postgresPayload.db.pool.query(sql, params)
    if (postgresPayload.db.drizzle?.execute) return postgresPayload.db.drizzle.execute(sql, params)
    throw new Error('[@payloadcms-vectorize/pg] Failed to persist vector column')
  }
  const literal = `[${Array.from(embedding).join(',')}]`
  const postgresPayload = payload as PostgresPayload
  const schemaName = postgresPayload.db.schemaName || 'public'
  // Drizzle converts camelCase collection slugs to snake_case table names
  const sql =
    `UPDATE "${schemaName}"."${toSnakeCase(poolName)}" SET embedding = $1 WHERE id = $2` as string
  try {
    await runSQL(sql, [literal, id])
  } catch (e) {
    const errorMessage = (e as Error).message || (e as any).toString()
    payload.logger.error(
      `[@payloadcms-vectorize/pg] Failed to persist vector column: ${errorMessage}`,
    )
    throw new Error(`[@payloadcms-vectorize/pg] Failed to persist vector column: ${e}`)
  }
}
