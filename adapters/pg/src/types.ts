/** Configuration for a knowledge pool */

import { KnowledgePoolName } from 'payloadcms-vectorize'
import type { Payload } from 'payload'

/** Note current limitation: needs a migration in order to change */
export type KnowledgePoolsConfig = Record<
  KnowledgePoolName,
  {
    /** Vector dimensions for pgvector column */
    dims: number
    /** IVFFLAT lists parameter used when creating the index */
    ivfflatLists: number
  }
>

/** Shape of the Postgres-specific db properties we need */
export interface PostgresDb {
  pool?: { query: (sql: string, params?: unknown[]) => Promise<unknown> }
  drizzle?: Record<string, unknown> & { execute?: (sql: string) => Promise<unknown> }
  schemaName?: string
}

/** Payload instance with a Postgres database adapter */
export type PostgresPayload = Payload & {
  db: PostgresDb
}

/** Type guard to check if Payload is using Postgres adapter */
export function isPostgresPayload(payload: Payload): payload is PostgresPayload {
  const db = payload.db as unknown as Record<string, unknown>
  const pool = db?.pool as Record<string, unknown> | undefined
  const drizzle = db?.drizzle as Record<string, unknown> | undefined
  return typeof pool?.query === 'function' || typeof drizzle?.execute === 'function'
}
