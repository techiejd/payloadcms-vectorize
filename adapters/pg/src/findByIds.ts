import { inArray } from '@payloadcms/db-postgres/drizzle'
import { BasePayload, SanitizedCollectionConfig } from 'payload'
import { KnowledgePoolName, EmbeddingRecord } from 'payloadcms-vectorize'
import toSnakeCase from 'to-snake-case'
import { getEmbeddingsTable } from './drizzle.js'

export default async (
  payload: BasePayload,
  poolName: KnowledgePoolName,
  ids: string[],
  populateEmbedding = false,
): Promise<Array<EmbeddingRecord>> => {
  if (ids.length === 0) return []

  const isPostgres = payload.db?.pool?.query || payload.db?.drizzle
  if (!isPostgres) {
    throw new Error('[@payloadcms-vectorize/pg] Only works with Postgres')
  }
  const drizzle = payload.db?.drizzle
  if (!drizzle) {
    throw new Error('[@payloadcms-vectorize/pg] Drizzle instance not found in adapter')
  }

  const collectionConfig = payload.collections[poolName]?.config
  if (!collectionConfig) {
    throw new Error(`[@payloadcms-vectorize/pg] Collection ${poolName} not found`)
  }

  const table = getEmbeddingsTable(poolName)
  if (!table) {
    throw new Error(
      `[@payloadcms-vectorize/pg] Embeddings table for knowledge pool "${poolName}" not registered.`,
    )
  }

  const selectObj: Record<string, any> = {
    id: table.id,
  }
  if (populateEmbedding) {
    selectObj.embedding = table.embedding
  }
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

  const rows = await drizzle.select(selectObj).from(table).where(inArray(table.id, ids))
  return mapRowsToRecords(rows, collectionConfig, populateEmbedding)
}

function mapRowsToRecords(
  rows: Record<string, unknown>[],
  collectionConfig: SanitizedCollectionConfig,
  populateEmbedding: boolean,
): Array<EmbeddingRecord> {
  const numberFields = new Set<string>()
  for (const field of collectionConfig.fields) {
    if (typeof field === 'object' && 'name' in field && field.type === 'number') {
      numberFields.add(field.name)
    }
  }

  return rows.map((row) => {
    const rawDocId = row.docId ?? row.doc_id
    const rawChunkIndex = row.chunkIndex ?? row.chunk_index

    const record = {
      ...row,
      id: String(row.id),
      docId: String(rawDocId),
      chunkIndex:
        typeof rawChunkIndex === 'number' ? rawChunkIndex : parseInt(String(rawChunkIndex), 10),
      ...(populateEmbedding ? { embedding: parseEmbedding(row.embedding) } : {}),
    } as EmbeddingRecord

    for (const fieldName of numberFields) {
      const value = record[fieldName]
      if (value != null && typeof value !== 'number') {
        const parsed = parseFloat(String(value))
        if (!Number.isNaN(parsed)) {
          record[fieldName] = parsed
        }
      }
    }

    return record
  })
}

function parseEmbedding(value: unknown): number[] {
  if (Array.isArray(value)) return value as number[]
  if (typeof value === 'string') {
    return value
      .replace(/^\[/, '')
      .replace(/\]$/, '')
      .split(',')
      .filter((s) => s.length > 0)
      .map((s) => Number(s))
  }
  return []
}
