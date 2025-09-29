import type { Payload } from 'payload'

import config from '@payload-config'
import { getPayload } from 'payload'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { makeEmbed, embeddingVersion } from 'helpers/embed.js'
import { PostgresPayload } from '../src/types.js'

let payload: Payload
let postId: string
const embedFn = makeEmbed(8)

afterAll(async () => {})

beforeAll(async () => {
  payload = await getPayload({ config })
})

describe('Plugin integration tests', () => {
  test('adds embeddings collection with vector column', async () => {
    // Check schema for embeddings collection
    const collections = payload.collections
    expect(collections).toHaveProperty('embeddings')

    // Do sql check for vector column
    const db = (payload as PostgresPayload).db
    const sql = `
      SELECT column_name, udt_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'embeddings'
    `

    let rows: any[] = []
    if (db?.pool?.query) {
      const res = await db.pool.query(sql)
      rows = res?.rows || []
    } else if (db?.drizzle?.execute) {
      const res = await db.drizzle.execute(sql)
      rows = Array.isArray(res) ? res : res?.rows || []
    }

    const columnsByName = Object.fromEntries(rows.map((r: any) => [r.column_name, r]))

    expect(columnsByName.embedding).toBeDefined()
    // pgvector columns report udt_name = 'vector'
    expect(columnsByName.embedding.udt_name).toBe('vector')
  })

  const getSQLRow = async (
    db: {
      pool?: { query: (sql: string, params?: any[]) => Promise<any> }
      drizzle?: { execute: (sql: string) => Promise<any> }
    },
    id: string,
  ) => {
    if (db?.pool?.query) {
      const sql = `
        SELECT embedding, pg_typeof(embedding) AS t
        FROM "embeddings"
        WHERE id = $1
      `
      const res = await db.pool.query(sql, [id])
      return res.rows[0]
    } else if (db?.drizzle?.execute) {
      // drizzle.execute may not support params; inline if needed
      const res = await db.drizzle.execute(
        `SELECT embedding, pg_typeof(embedding) AS t FROM "embeddings" WHERE id = '${id}'`,
      )
      return Array.isArray(res) ? res[0] : res.rows?.[0]
    }
  }

  test('creates embeddings on create', async () => {
    const title = 'Hello world'
    const content = 'This is a test post for vectorization.'
    const post = await payload.create({
      collection: 'posts',
      data: {
        title,
        content,
      },
    })

    const expectedTitleDoc = {
      sourceCollection: 'posts',
      docId: String(post.id),
      fieldPath: 'title',
      chunkIndex: 0,
      chunkText: title,
      embeddingVersion,
    }
    const expectedContentDoc = {
      sourceCollection: 'posts',
      docId: String(post.id),
      fieldPath: 'content',
      chunkIndex: 0,
      chunkText: content,
      embeddingVersion,
    }

    const { totalDocs } = await payload.count({
      collection: 'embeddings',
      where: {
        and: [{ sourceCollection: { equals: 'posts' } }, { docId: { equals: String(post.id) } }],
      },
    })
    const embeddings = await payload.find({
      collection: 'embeddings',
      where: {
        and: [{ sourceCollection: { equals: 'posts' } }, { docId: { equals: String(post.id) } }],
      },
    })

    // Expect one chunk per field with default chunker
    expect(totalDocs).toBe(2)
    expect(embeddings.docs).toEqual(
      expect.arrayContaining([expect.objectContaining(expectedTitleDoc)]),
    )
    expect(embeddings.docs).toEqual(
      expect.arrayContaining([expect.objectContaining(expectedContentDoc)]),
    )

    for (const doc of embeddings.docs) {
      expect(doc.chunkText).toBeDefined()
      const id = String(doc.id)
      const expectedEmbedding = await embedFn(doc.chunkText as string)
      const row = await getSQLRow((payload as any).db, id)

      expect(row).toBeDefined()
      expect(row.embedding).toBeDefined()
      expect(row.t).toBe('vector')
      const received = JSON.parse(row.embedding)
      // received is from Postgres, expected is from your embed() in JS
      for (let i = 0; i < expectedEmbedding.length; i++) {
        expect(received[i]).toBeCloseTo(expectedEmbedding[i], 5) // 5 decimal places is typical for float4
      }
    }

    // Save for follow-up tests
    postId = String(post.id)
  })

  test('replaces embeddings on update', async () => {
    const updatedTitle = 'Updated title'
    const updatedContent = 'Updated content for vectorization behavior.'
    await payload.update({
      where: {
        id: { equals: postId },
      },
      collection: 'posts',
      data: {
        title: updatedTitle,
        content: updatedContent,
      },
    })

    const updatedEmbeddings = await payload.find({
      collection: 'embeddings',
      where: {
        and: [{ sourceCollection: { equals: 'posts' } }, { docId: { equals: postId } }],
      },
    })

    expect(updatedEmbeddings.docs.length).toBe(2)
    expect(updatedEmbeddings.docs).toEqual(
      expect.arrayContaining([expect.objectContaining({ chunkText: updatedTitle })]),
    )
    expect(updatedEmbeddings.docs).toEqual(
      expect.arrayContaining([expect.objectContaining({ chunkText: updatedContent })]),
    )

    for (const doc of updatedEmbeddings.docs) {
      const id = String(doc.id)
      expect(doc.chunkText).toBeDefined()
      const expectedEmbedding = await embedFn(doc.chunkText as string)

      // now check the DB vector column directly
      const row = await getSQLRow((payload as any).db, id)
      expect(row).toBeDefined()
      expect(row.t).toBe('vector')
      expect(row.embedding).toBeDefined()
      const received = JSON.parse(row.embedding)
      for (let i = 0; i < expectedEmbedding.length; i++) {
        // We have to use 5 decimal places because float4 is used in pgvector
        expect(received[i]).toBeCloseTo(expectedEmbedding[i], 5)
      }
    }
  })

  test('deletes embeddings on delete', async () => {
    await payload.delete({
      where: {
        id: { equals: postId },
      },
      collection: 'posts',
    })

    const deletedEmbeddings = await payload.find({
      collection: 'embeddings',
      where: {
        and: [{ sourceCollection: { equals: 'posts' } }, { docId: { equals: postId } }],
      },
    })
    expect(deletedEmbeddings.docs.length).toBe(0)
  })
})
