import type { Payload } from 'payload'

import config from '@payload-config'
import { getPayload } from 'payload'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

let payload: Payload

afterAll(async () => {})

beforeAll(async () => {
  payload = await getPayload({ config })
})

describe('Plugin integration tests', () => {
  test('creates embeddings on create', async () => {
    const post = await payload.create({
      collection: 'posts',
      data: {
        title: 'Hello world',
        content: 'This is a test post for vectorization.',
      },
    })

    const { totalDocs } = await payload.count({
      collection: 'embeddings',
      where: {
        and: [{ sourceCollection: { equals: 'posts' } }, { docId: { equals: String(post.id) } }],
      },
    })

    // Expect one chunk per field with default chunker
    expect(totalDocs).toBe(2)

    // Save for follow-up tests
    ;(globalThis as any).__testPostId = String(post.id)
  })

  test('replaces embeddings on update', async () => {
    const id = (globalThis as any).__testPostId
    const post = await payload.update({
      id,
      collection: 'posts',
      data: {
        title: 'Updated title',
        content: 'Updated content for vectorization behavior.',
      },
    })

    const { totalDocs } = await payload.count({
      collection: 'embeddings',
      where: {
        and: [{ sourceCollection: { equals: 'posts' } }, { docId: { equals: String(post.id) } }],
      },
    })

    expect(totalDocs).toBe(2)
  })

  test('removes embeddings on delete', async () => {
    const id = (globalThis as any).__testPostId
    await payload.delete({ collection: 'posts', id })

    const { totalDocs } = await payload.count({
      collection: 'embeddings',
      where: {
        and: [{ sourceCollection: { equals: 'posts' } }, { docId: { equals: String(id) } }],
      },
    })

    expect(totalDocs).toBe(0)
  })
})
