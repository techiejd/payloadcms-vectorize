import { expect, test } from '@playwright/test'
import config from '@payload-config'
import { getPayload } from 'payload'
import { getInitialMarkdownContent } from './constants.js'
import { waitForVectorizationJobs } from './utils.js'
import { testEmbeddingVersion } from 'helpers/embed.js'

test('querying the endpoint should return the title when queried', async ({ request }) => {
  const title = 'test query post title'
  const _config = await config
  const payload = await getPayload({ config: _config })
  const post = await payload.create({
    collection: 'posts',
    data: {
      title,
      content: (await getInitialMarkdownContent(_config)) as unknown as any,
    },
  })

  await waitForVectorizationJobs(payload)

  const response = await request.post('/api/vector-search', {
    data: {
      query: title,
      knowledgePool: 'default',
    },
  })
  expect(response.ok()).toBe(true)
  const json = await response.json()
  expect(json).toHaveProperty('results')
  expect(json.results.length).toBeGreaterThan(0)
  expect(json.results).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        sourceCollection: 'posts',
        docId: String(post.id),
        chunkIndex: 0,
        chunkText: title,
        embeddingVersion: testEmbeddingVersion,
      }),
    ]),
  )
})
