import type { KnowledgePoolName } from '../types.js'
import type { Table } from '@payloadcms/db-postgres/drizzle'

// Extend Table to allow dynamic column access (for extension fields)
type DrizzleTable = Table & Record<string, any>

const embeddingsTables = new Map<KnowledgePoolName, DrizzleTable>()

export function registerEmbeddingsTable(poolName: KnowledgePoolName, table: DrizzleTable): void {
  embeddingsTables.set(poolName, table)
}

export function getEmbeddingsTable(poolName: KnowledgePoolName): DrizzleTable | undefined {
  return embeddingsTables.get(poolName)
}

export function clearEmbeddingsTables(): void {
  embeddingsTables.clear()
}
