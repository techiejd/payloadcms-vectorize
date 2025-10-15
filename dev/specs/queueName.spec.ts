import type { Payload, SanitizedConfig } from 'payload'
import { getPayload } from 'payload'
import { beforeAll, describe, expect, test } from 'vitest'
import { chunkText, chunkRichText } from 'helpers/chunkers.js'
import type { SerializedEditorState } from '@payloadcms/richtext-lexical/lexical'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { buildDummyConfig, getInitialMarkdownContent, integration, plugin } from './constants.js'
import { create } from './testDb.js'

describe('Queue tests', () => {
  let config: SanitizedConfig
  let payload: Payload
  let markdownContent: SerializedEditorState
  const expectedQueueName = 'queueName'
  const dbName = 'queue_test'
  beforeAll(async () => {
    await create({ dbName })
    config = await buildDummyConfig({
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
        extensions: ['vector'],
        afterSchemaInit: [integration.afterSchemaInitHook],
        pool: {
          connectionString: 'postgresql://postgres:password@localhost:5433/queue_test',
        },
      }),
      plugins: [
        plugin({
          queueNameOrCronJob: expectedQueueName,
          collections: {
            posts: {
              fields: {
                title: { chunker: chunkText },
                content: { chunker: chunkRichText },
              },
            },
          },
          embed: async () => [0, 0, 0, 0, 0, 0, 0, 0],
          embeddingVersion: 'test',
        }),
      ],
    })
    payload = await getPayload({ config })
    markdownContent = await getInitialMarkdownContent(config)
  })
  test('vectorization jobs are queued using the queueName', async () => {
    // There is no autoRun so previous jobs are queued and never removed between tests
    const prevJobs = await payload.find({
      collection: 'payload-jobs',
      where: {
        and: [
          { taskSlug: { equals: 'payloadcms-vectorize:vectorize' } },
          { processing: { equals: false } },
          { completedAt: { equals: null } },
        ],
      },
    })
    const title = 'Hello world'
    await payload.create({
      collection: 'posts',
      data: {
        title,
        content: markdownContent as unknown as any,
      },
    })

    const pendingJobs = await payload.find({
      collection: 'payload-jobs',
      where: {
        and: [
          { taskSlug: { equals: 'payloadcms-vectorize:vectorize' } },
          { processing: { equals: false } },
          { completedAt: { equals: null } },
        ],
      },
    })
    expect(pendingJobs.docs.length).toBe(prevJobs.docs.length + 1)
    pendingJobs.docs.forEach((doc) => expect(doc.queue).toBe(expectedQueueName))
  })
})
