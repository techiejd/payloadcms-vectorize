/** Configuration for a knowledge pool */

import { KnowledgePoolName } from 'payloadcms-vectorize'

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

// Type guard to check if Payload is using Postgres adapter
export function isPostgresPayload(payload: any): payload is any & {
  db: {
    pool?: { query: (sql: string, params?: any[]) => Promise<any> }
    drizzle?: { execute: (sql: string) => Promise<any> }
  }
} {
  return (
    typeof payload?.db?.pool?.query === 'function' ||
    typeof payload?.db?.drizzle?.execute === 'function'
  )
}

// Type for Payload with Postgres database
export type PostgresPayload = any & {
  db: {
    pool?: { query: (sql: string, params?: any[]) => Promise<any> }
    drizzle?: { execute: (sql: string) => Promise<any> }
  }
}
