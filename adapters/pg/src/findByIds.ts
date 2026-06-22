import { inArray } from '@payloadcms/db-postgres/drizzle'
import { BasePayload, SanitizedCollectionConfig } from 'payload'
import { KnowledgePoolName, EmbeddingRecord } from 'payloadcms-vectorize'
import toSnakeCase from 'to-snake-case'
import { getEmbeddingsTable } from './drizzle.js'
import { parseEmbedding } from './parseEmbedding.js'

export default async (
  payload: BasePayload,
  poolName: KnowledgePoolName,
  ids: string[],
  populateEmbedding = false,
): Promise<Record<string, EmbeddingRecord | undefined>> => {
  const result: Record<string, EmbeddingRecord | undefined> = {}
  for (const id of ids) result[id] = undefined
  if (ids.length === 0) return result

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

  // Drop ids that can't match the primary-key column type before querying, so a
  // malformed id is treated as a miss instead of making Postgres reject the cast
  // and throw for the whole batch.
  const queryableIds = ids.filter((id) => idMatchesPkType(table.id, id))
  if (queryableIds.length === 0) return result

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

  const rows = await drizzle.select(selectObj).from(table).where(inArray(table.id, queryableIds))
  for (const record of mapRowsToRecords(rows, collectionConfig, populateEmbedding)) {
    result[record.id] = record
  }
  return result
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function idMatchesPkType(idColumn: { getSQLType?: () => string }, id: string): boolean {
  const sqlType = idColumn.getSQLType?.() ?? ''
  if (sqlType === 'integer' || sqlType === 'serial' || sqlType === 'bigint' || sqlType === 'bigserial') {
    return /^\d+$/.test(id)
  }
  if (sqlType === 'uuid') {
    return UUID.test(id)
  }
  return true
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
      sourceCollection: String(row.sourceCollection ?? ''),
      docId: String(rawDocId ?? ''),
      chunkIndex:
        typeof rawChunkIndex === 'number' ? rawChunkIndex : parseInt(String(rawChunkIndex), 10),
      chunkText: String(row.chunkText ?? ''),
      embeddingVersion: String(row.embeddingVersion ?? ''),
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
