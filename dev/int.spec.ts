import type { Payload } from 'payload'

import config from '@payload-config'
import { getPayload } from 'payload'
import { beforeAll, describe, expect, test } from 'vitest'
import { makeEmbed, embeddingVersion } from 'helpers/embed.js'
import { chunkText, chunkRichText } from 'helpers/chunkers.js'
import { createHeadlessEditor } from '@payloadcms/richtext-lexical/lexical/headless'
import {
  $getRoot,
  $createParagraphNode,
  $createTextNode,
  type SerializedEditorState,
} from '@payloadcms/richtext-lexical/lexical'
import { $createHeadingNode } from '@payloadcms/richtext-lexical/lexical/rich-text'
import { PostgresPayload } from '../src/types.js'
import { editorConfigFactory, getEnabledNodes } from '@payloadcms/richtext-lexical'

let payload: Payload
let postId: string
let markdownContent: SerializedEditorState // how payloadcms exports the rich text
const embedFn = makeEmbed(8)

beforeAll(async () => {
  payload = await getPayload({ config })
})

describe('Chunkers', () => {
  test('textChunker', () => {
    const text =
      '0: This is a test post for vectorization. 1: This is a test post for vectorization. 2: This is a test post for vectorization. 3: This is a test post for vectorization. 4: This is a test post for vectorization. 5: This is a test post for vectorization. 6: This is a test post for vectorization. 7: This is a test post for vectorization. 8: This is a test post for vectorization. 9: This is a test post for vectorization. 10: This is a test post for vectorization. 11: This is a test post for vectorization. 12: This is a test post for vectorization. 13: This is a test post for vectorization. 14: This is a test post for vectorization. 15: This is a test post for vectorization. 16: This is a test post for vectorization. 17: This is a test post for vectorization. 18: This is a test post for vectorization. 19: This is a test post for vectorization. 20: This is a test post for vectorization. 21: This is a test post for vectorization. 22: This is a test post for vectorization. 23: This is a test post for vectorization.'
    const chunks = chunkText(text)
    expect(chunks).toEqual([
      '0: This is a test post for vectorization. 1: This is a test post for vectorization. 2: This is a test post for vectorization. 3: This is a test post for vectorization. 4: This is a test post for vectorization. 5: This is a test post for vectorization. 6: This is a test post for vectorization. 7: This is a test post for vectorization. 8: This is a test post for vectorization. 9: This is a test post for vectorization. 10: This is a test post for vectorization. 11: This is a test post for vectorization. 12: This is a test post for vectorization. 13: This is a test post for vectorization. 14: This is a test post for vectorization. 15: This is a test post for vectorization. 16: This is a test post for vectorization. 17: This is a test post for vectorization. 18: This is a test post for vectorization. 19: This is a test post for vectorization. 20: This is a test post for vectorization. 21: This is a test post for vectorization. 22: This is a test post for vectorization. ',
      '23: This is a test post for vectorization.',
    ])
  })

  test('richTextChunker splits by H2', async () => {
    const editorConfig = await editorConfigFactory.default({ config: payload.config })
    const enabledNodes = getEnabledNodes({ editorConfig })

    // Still create editor to resemble runtime environment, but seed with serialized
    const editor = createHeadlessEditor({
      nodes: enabledNodes,
    })
    markdownContent = await new Promise((resolve) => {
      const unregister = editor.registerUpdateListener(({ editorState }) => {
        unregister()
        resolve(editorState.toJSON())
      })
      editor.update(() => {
        const root = $getRoot()
        root.append($createHeadingNode('h1').append($createTextNode('Title')))
        root.append($createParagraphNode().append($createTextNode('Quote')))
        root.append($createParagraphNode().append($createTextNode('Paragraph 0')))
        root.append($createHeadingNode('h2').append($createTextNode('Header 1')))
        root.append($createParagraphNode().append($createTextNode('Paragraph 1')))
        root.append($createParagraphNode().append($createTextNode('Paragraph 2')))
        root.append($createParagraphNode().append($createTextNode('Paragraph 3')))
        root.append($createHeadingNode('h2').append($createTextNode('Header 2')))
        root.append($createParagraphNode().append($createTextNode('Paragraph 4')))
        root.append($createParagraphNode().append($createTextNode('Paragraph 5')))
        root.append($createParagraphNode().append($createTextNode('Paragraph 6')))
      })
    })
    const chunks = await chunkRichText(markdownContent, payload)

    expect(chunks.length).toBe(3)

    // Intro chunk
    expect(chunks[0]).toContain('Title')
    expect(chunks[0]).toContain('Quote')
    expect(chunks[0]).toContain('Paragraph 0')

    // First H2 section
    expect(chunks[1]).toContain('## Header 1')
    expect(chunks[1]).toContain('Paragraph 1')
    expect(chunks[1]).toContain('Paragraph 2')
    expect(chunks[1]).toContain('Paragraph 3')

    // Second H2 section
    expect(chunks[2]).toContain('## Header 2')
    expect(chunks[2]).toContain('Paragraph 4')
    expect(chunks[2]).toContain('Paragraph 5')
    expect(chunks[2]).toContain('Paragraph 6')
  })
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
    const post = await payload.create({
      collection: 'posts',
      data: {
        title,
        content: markdownContent as unknown as any,
      },
    })

    // Get the actual content chunks to create proper expectations
    const contentChunks = await chunkRichText(markdownContent, payload)

    const expectedTitleDoc = {
      sourceCollection: 'posts',
      docId: String(post.id),
      fieldPath: 'title',
      chunkIndex: 0,
      chunkText: title,
      embeddingVersion,
    }

    // Create expected docs for each content chunk
    const expectedContentDocs = contentChunks.map((chunkText, index) => ({
      sourceCollection: 'posts',
      docId: String(post.id),
      fieldPath: 'content',
      chunkIndex: index,
      chunkText,
      embeddingVersion,
    }))

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

    // Expect title + all content chunks
    expect(totalDocs).toBe(1 + contentChunks.length)
    expect(embeddings.docs).toEqual(
      expect.arrayContaining([expect.objectContaining(expectedTitleDoc)]),
    )
    expect(embeddings.docs).toEqual(
      expect.arrayContaining(expectedContentDocs.map((doc) => expect.objectContaining(doc))),
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

    // Create updated content by modifying the existing markdownContent
    const editorConfig = await editorConfigFactory.default({ config: payload.config })
    const enabledNodes = getEnabledNodes({ editorConfig })
    const editor = createHeadlessEditor({ nodes: enabledNodes })

    const updatedContent = await new Promise<SerializedEditorState>((resolve) => {
      const unregister = editor.registerUpdateListener(({ editorState }) => {
        unregister()
        resolve(editorState.toJSON())
      })
      editor.update(() => {
        const root = $getRoot()
        // Keep the original structure but modify some text
        root.append($createHeadingNode('h1').append($createTextNode('Updated Title')))
        root.append($createParagraphNode().append($createTextNode('Updated Quote')))
        root.append($createParagraphNode().append($createTextNode('Updated Paragraph 0')))
        root.append($createHeadingNode('h2').append($createTextNode('Updated Header 1')))
        root.append($createParagraphNode().append($createTextNode('Updated Paragraph 1')))
        root.append($createParagraphNode().append($createTextNode('Updated Paragraph 2')))
        root.append($createParagraphNode().append($createTextNode('Updated Paragraph 3')))
        root.append($createHeadingNode('h2').append($createTextNode('Updated Header 2')))
        root.append($createParagraphNode().append($createTextNode('Updated Paragraph 4')))
        root.append($createParagraphNode().append($createTextNode('Updated Paragraph 5')))
        root.append($createParagraphNode().append($createTextNode('Updated Paragraph 6')))
      })
    })

    await payload.update({
      where: {
        id: { equals: postId },
      },
      collection: 'posts',
      data: {
        title: updatedTitle,
        content: updatedContent as unknown as any,
      },
    })

    // Get the updated content chunks
    const updatedContentChunks = await chunkRichText(updatedContent, payload)

    const updatedEmbeddings = await payload.find({
      collection: 'embeddings',
      where: {
        and: [{ sourceCollection: { equals: 'posts' } }, { docId: { equals: postId } }],
      },
    })

    // Expect title + all updated content chunks
    expect(updatedEmbeddings.docs.length).toBe(1 + updatedContentChunks.length)
    expect(updatedEmbeddings.docs).toEqual(
      expect.arrayContaining([expect.objectContaining({ chunkText: updatedTitle })]),
    )

    // Check that all updated content chunks are present
    for (const chunkText of updatedContentChunks) {
      expect(updatedEmbeddings.docs).toEqual(
        expect.arrayContaining([expect.objectContaining({ chunkText })]),
      )
    }

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
