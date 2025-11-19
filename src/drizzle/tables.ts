import type { KnowledgePoolName } from '../types.js'

type DrizzleTable = Record<string, any>

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
