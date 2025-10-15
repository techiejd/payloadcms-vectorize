import { getPayload } from 'payload'
import { beforeAll, describe, expect, test } from 'vitest'
import { chunkText, chunkRichText } from 'helpers/chunkers.js'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { buildDummyConfig, getInitialMarkdownContent, integration } from './constants.js'
import { create } from './testDb.js'

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
    beforeAll(async () => {
      create({ dbName: 'chunkers_test' })
    })
    const cfg = await buildDummyConfig({
      db: postgresAdapter({
        extensions: ['vector'],
        afterSchemaInit: [integration.afterSchemaInitHook],
        pool: {
          connectionString: 'postgresql://postgres:password@localhost:5433/chunkers_test',
        },
      }),
    })
    const markdownContent = await getInitialMarkdownContent(cfg)
    const thisPayload = await getPayload({ config: cfg })
    const chunks = await chunkRichText(markdownContent, thisPayload)

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
