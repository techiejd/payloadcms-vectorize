import type { PayloadHandler } from 'payload'
import type { EmbedQueryFn, VectorSearchResult } from 'payloadcms-vectorize'

export const vectorSearch = (embedFn: EmbedQueryFn) => {
  const _vectorSearch: PayloadHandler = async (req) => {
    console.log('vectorSearch endpoint hit')
    if (!req || !req.json) {
      return Response.json({ error: 'Request is required' }, { status: 400 })
    }
    try {
      const { query } = await req.json()
      if (!query || typeof query !== 'string') {
        return Response.json({ error: 'Query is required and must be a string' }, { status: 400 })
      }

      const payload = req.payload

      // Generate embedding for the query
      const queryEmbedding = await (async () => {
        const qE = await embedFn(query)
        return Array.isArray(qE) ? qE : Array.from(qE)
      })()

      // Perform cosine similarity search using raw SQL
      const results = await performCosineSearch(payload, queryEmbedding, 10)

      return Response.json({ results })
    } catch (error) {
      console.error('Search error:', error)
      return Response.json({ error: 'Internal server error' }, { status: 500 })
    }
  }
  return _vectorSearch
}

async function performCosineSearch(
  payload: any,
  queryEmbedding: number[],
  limit: number = 10,
): Promise<Array<VectorSearchResult>> {
  const isPostgres = payload.db?.pool?.query || payload.db?.drizzle?.execute

  if (!isPostgres) {
    throw new Error('Only works with Postgres')
  }

  const runSQL = async (sql: string, params?: any[]) => {
    if (payload.db.pool?.query) {
      return payload.db.pool.query(sql, params)
    }
    if (payload.db.drizzle?.execute) {
      return payload.db.drizzle.execute(sql)
    }
    throw new Error('Failed to execute SQL')
  }

  // Convert embedding array to PostgreSQL vector format
  const vectorString = `[${queryEmbedding.join(',')}]`

  // SQL query for cosine similarity search
  const sql = `
    SELECT 
      "doc_id",
      "chunk_text",
      "field_path",
      "source_collection",
      "chunk_index",
      "embedding_version",
      1 - (embedding <=> $1::vector) as similarity
    FROM "embeddings"
    ORDER BY embedding <=> $1::vector
    LIMIT $2
  `

  try {
    // Debug: First check what embeddings exist
    const debugResult = await runSQL(`
      SELECT "doc_id", "field_path", "chunk_index", "chunk_text" 
      FROM "embeddings" 
      ORDER BY "doc_id", "field_path", "chunk_index"
    `)
    console.log('All embeddings in database:', debugResult.rows || debugResult)

    const result = await runSQL(sql, [vectorString, limit])

    // Handle different result formats from different database adapters
    const rows = result.rows || result || []

    // Debug: Log what we found
    console.log(`Found ${rows.length} embeddings in database`)
    console.log('Sample rows:', rows)

    return rows.map((row: any) => ({
      id: String(row.doc_id), // Convert to string for consistency
      docId: row.doc_id,
      similarity: parseFloat(row.similarity),
      chunkText: row.chunk_text,
      fieldPath: row.field_path,
      sourceCollection: row.source_collection,
      chunkIndex: parseInt(row.chunk_index, 10), // Convert to number
      embeddingVersion: row.embedding_version,
    }))
  } catch (error) {
    console.error('Cosine search error:', error)
    throw new Error(`Cosine search failed: ${error}`)
  }
}
