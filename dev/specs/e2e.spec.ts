import { expect, test } from '@playwright/test'
import type { Payload, SanitizedConfig } from 'payload'
import config from '@payload-config'
import { getPayload } from 'payload'
import { getInitialMarkdownContent } from './constants.js'
import { waitForVectorizationJobs } from './utils.js'
import { testEmbeddingVersion } from 'helpers/embed.js'

const expectVectorSearchResponse = async (response: any, post: any, title: string) => {
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
}

const expectEmptyVectorSearchResponse = async (response: any) => {
  expect(response.ok()).toBe(true)
  const json = await response.json()
  expect(json).toHaveProperty('results')
  expect(json.results.length).toBe(0)
}

test.describe('Vector embedding e2e tests', () => {
  const title = 'e2e test post title'
  let payload: Payload
  let _config: SanitizedConfig
  let post: any

  test.beforeAll(async () => {
    // Setup: Create a post and wait for realtime embedding
    _config = await config
    payload = await getPayload({ config: _config, key: `e2e-test-${Date.now()}` })
  })

  test('querying the endpoint should return the title with testEmbeddingVersion', async ({
    request,
  }) => {
    const emptyResponse = await request.post('/api/vector-search', {
      data: {
        query: title,
        knowledgePool: 'default',
      },
    })
    await expectEmptyVectorSearchResponse(emptyResponse)

    post = await payload.create({
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
    await expectVectorSearchResponse(response, post, title)
  })

  test('clicking Embed All button triggers bulk embedding for bulkDefault pool', async ({
    page,
    request,
  }) => {
    test.setTimeout(120000)

    // Verify bulkDefault pool is EMPTY (no realTimeIngestionFn configured)
    const emptyResponse = await request.post('/api/vector-search', {
      data: {
        query: title,
        knowledgePool: 'bulkDefault',
      },
    })
    await expectEmptyVectorSearchResponse(emptyResponse)

    // Navigate to the bulkDefault embeddings collection page in admin
    await page.goto('/admin/collections/bulkDefault')

    // Wait for the page to load and find the Embed All button
    const embedAllButton = page.locator('button:has-text("Embed all")')
    await expect(embedAllButton).toBeVisible({ timeout: 10000 })

    // Click the Embed All button
    await embedAllButton.click()

    // Wait for success message with run link
    const successMessage = page.locator('text=/Queued bulk embed run/')
    await expect(successMessage).toBeVisible({ timeout: 30000 })

    // Click on the run link to navigate to the run page
    const runLink = page.locator('[data-testid="bulk-run-link"]')
    await expect(runLink).toBeVisible({ timeout: 5000 })
    await runLink.click()

    // We're now on the run detail page - verify we can see the status field
    // The status should progress through: queued -> running -> polling -> completed
    // Wait for the page to load
    await page.waitForURL(/\/admin\/collections\/vector-bulk-embeddings-runs\/\d+/)

    // Check initial status - should be queued or running
    const statusField = page.locator('[id="field-status"]')
    await expect(statusField).toBeVisible({ timeout: 10000 })

    // Wait for status to become 'completed' by polling the page
    // The mock statusSequence is ['queued', 'running', 'running', 'succeeded']
    // which means 4 polls before completion
    let attempts = 0
    const maxAttempts = 30 // 30 * 3s = 90s max
    let finalStatus = ''

    while (attempts < maxAttempts) {
      // Refresh the page to see updated status
      await page.reload()
      await page.waitForLoadState('domcontentloaded')

      // Get the status value - it's in a select or text field
      const statusValue = await statusField.inputValue().catch(() => null)
      if (statusValue) {
        finalStatus = statusValue
        if (statusValue === 'completed') {
          break
        }
      }

      attempts++
      await page.waitForTimeout(3000)
    }

    expect(finalStatus).toBe('completed')

    // Now verify vector-search returns results for bulkDefault pool
    const filledResponse = await request.post('/api/vector-search', {
      data: {
        query: title,
        knowledgePool: 'bulkDefault',
      },
    })
    await expectVectorSearchResponse(filledResponse, post, title)
  })
})
