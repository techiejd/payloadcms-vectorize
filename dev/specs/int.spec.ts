import type { Payload, SanitizedConfig } from 'payload'

import { beforeAll, describe, expect, test } from 'vitest'
import { makeDummyEmbedDocs, makeDummyEmbedQuery, testEmbeddingVersion } from 'helpers/embed.js'
import { chunkRichText, chunkText } from 'helpers/chunkers.js'
import { createHeadlessEditor } from '@payloadcms/richtext-lexical/lexical/headless'
import {
  $getRoot,
  $createParagraphNode,
  $createTextNode,
  type SerializedEditorState,
} from '@payloadcms/richtext-lexical/lexical'
import { $createHeadingNode } from '@payloadcms/richtext-lexical/lexical/rich-text'
import { editorConfigFactory, getEnabledNodes, lexicalEditor } from '@payloadcms/richtext-lexical'
import { DIMS, getInitialMarkdownContent } from './constants.js'
import { createTestDb, waitForVectorizationJobs } from './utils.js'
import { getPayload } from 'payload'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { buildConfig } from 'payload'
import { createMockAdapter } from 'helpers/mockAdapter.js'
const embeddingsCollection = 'default'
import payloadcmsVectorize from 'payloadcms-vectorize'

describe('Plugin integration tests', () => {
  let payload: Payload
  let config: SanitizedConfig
  let postId: string
  let markdownContent: SerializedEditorState
  const dbName = `int_test_${Date.now()}`
  const adapter = createMockAdapter()
  beforeAll(async () => {
    await createTestDb({ dbName })

    config = await buildConfig({
      secret: process.env.PAYLOAD_SECRET || 'test-secret',
      editor: lexicalEditor(),
      collections: [
        {
          slug: 'posts',
          fields: [
            { name: 'title', type: 'text' },
            { name: 'content', type: 'richText' },
          ],
        },
      ],
      db: postgresAdapter({
        pool: {
          connectionString: `postgresql://postgres:password@localhost:5433/${dbName}`,
        },
      }),
      plugins: [
        payloadcmsVectorize({
          dbAdapter: adapter,
          knowledgePools: {
            default: {
              collections: {
                posts: {
                  toKnowledgePool: async (doc, pl) => {
                    const chunks: Array<{ chunk: string }> = []
                    if (doc.title) {
                      const titleChunks = chunkText(doc.title)
                      chunks.push(...titleChunks.map((chunk) => ({ chunk })))
                    }
                    if (doc.content) {
                      const contentChunks = await chunkRichText(doc.content, pl.config)
                      chunks.push(...contentChunks.map((chunk) => ({ chunk })))
                    }
                    return chunks
                  },
                },
              },
              embeddingConfig: {
                version: testEmbeddingVersion,
                queryFn: makeDummyEmbedQuery(DIMS),
                realTimeIngestionFn: makeDummyEmbedDocs(DIMS),
              },
            },
          },
        }),
      ],
      jobs: {
        tasks: [],
        autoRun: [
          {
            cron: '*/5 * * * * *',
            limit: 10,
          },
        ],
      },
    })

    payload = await getPayload({
      config,
      key: `int-test-${Date.now()}`,
      cron: true,
    })

    markdownContent = await getInitialMarkdownContent(config)
  })

  test('creates embeddings on create', async () => {
    const title = 'Hello world'
    const post = await payload.create({
      collection: 'posts',
      data: {
        title,
        content: markdownContent as unknown as any,
      },
    })

    // Wait for vectorization jobs to complete
    await waitForVectorizationJobs(payload)

    // Get the actual content chunks to create proper expectations
    const contentChunks = await chunkRichText(markdownContent, payload.config)

    const expectedTitleDoc = {
      sourceCollection: 'posts',
      docId: String(post.id),
      chunkIndex: 0,
      chunkText: title,
      embeddingVersion: testEmbeddingVersion,
    }

    // Create expected docs for each content chunk
    const expectedContentDocs = contentChunks.map((chunkText, index) => ({
      sourceCollection: 'posts',
      docId: String(post.id),
      chunkIndex: index + 1, // +1 because title chunk is at index 0
      chunkText,
      embeddingVersion: testEmbeddingVersion,
    }))

    const { totalDocs } = await payload.count({
      collection: embeddingsCollection,
      where: {
        and: [{ sourceCollection: { equals: 'posts' } }, { docId: { equals: String(post.id) } }],
      },
    })
    const embeddings = await payload.find({
      collection: embeddingsCollection,
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

    // Wait for vectorization jobs to complete
    await waitForVectorizationJobs(payload)

    // Get the updated content chunks
    const updatedContentChunks = await chunkRichText(updatedContent, payload.config)

    const updatedEmbeddings = await payload.find({
      collection: embeddingsCollection,
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
  })

  test('deletes embeddings on delete', async () => {
    await payload.delete({
      where: {
        id: { equals: postId },
      },
      collection: 'posts',
    })

    const deletedEmbeddings = await payload.find({
      collection: embeddingsCollection,
      where: {
        and: [{ sourceCollection: { equals: 'posts' } }, { docId: { equals: postId } }],
      },
    })
    expect(deletedEmbeddings.docs.length).toBe(0)
  })
})
