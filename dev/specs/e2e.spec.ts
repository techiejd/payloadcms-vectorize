import { expect, test } from '@playwright/test'
import type { Payload, SanitizedConfig } from 'payload'
import config from '@payload-config'
import { getPayload } from 'payload'
import { getInitialMarkdownContent } from './constants.js'
import { waitForVectorizationJobs } from './utils.js'
import { testEmbeddingVersion } from 'helpers/embed.js'
import { devUser } from 'helpers/credentials.js'

// Helper function to log in to the admin panel
const loginToAdmin = async (page: any) => {
  console.log('[loginToAdmin] Starting login process...')
  await page.goto('/admin/login')
  console.log('[loginToAdmin] Navigated to login page')

  await page.waitForLoadState('domcontentloaded')
  console.log('[loginToAdmin] Page loaded')

  // Fill in the login form
  console.log('[loginToAdmin] Filling in email...')
  await page.fill('input[name="email"]', devUser.email)
  console.log('[loginToAdmin] Filling in password...')
  await page.fill('input[name="password"]', devUser.password)

  // Click the login button
  console.log('[loginToAdmin] Clicking submit button...')
  await page.click('button[type="submit"]')

  // Wait for redirect to admin dashboard
  console.log('[loginToAdmin] Waiting for redirect...')
  await page.waitForURL(/\/admin(?!\/login)/, { timeout: 15000 })
  console.log('[loginToAdmin] Login complete!')
}

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
  // Force tests to run sequentially
  test.describe.configure({ mode: 'serial', timeout: 120000 })

  const title = 'e2e test post title'
  let payload: Payload
  let _config: SanitizedConfig
  let post: any

  test.beforeAll(async () => {
    console.log('[beforeAll] Setting up Payload instance...')
    // Setup: Create a post and wait for realtime embedding
    _config = await config
    payload = await getPayload({ config: _config, key: `e2e-test-${Date.now()}` })
    console.log('[beforeAll] Payload instance created')
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
    console.log('[test] Starting bulk embedding test...')
    test.setTimeout(120000)

    // Login to admin first
    console.log('[test] Logging in...')
    await loginToAdmin(page)

    // Verify bulkDefault pool is EMPTY (no realTimeIngestionFn configured)
    console.log('[test] Checking bulkDefault pool is empty...')
    const emptyResponse = await request.post('/api/vector-search', {
      data: {
        query: title,
        knowledgePool: 'bulkDefault',
      },
    })
    await expectEmptyVectorSearchResponse(emptyResponse)

    // Navigate to the bulkDefault embeddings collection page in admin
    console.log('[test] Navigating to bulkDefault collection page...')
    await page.goto('/admin/collections/bulkDefault', { waitUntil: 'networkidle' })
    console.log('[test] Page loaded')

    // Wait for the page to fully load and render
    console.log('[test] Waiting for page to fully load...')
    await page.waitForLoadState('domcontentloaded')
    await page.waitForLoadState('networkidle')
    console.log('[test] Page fully loaded')

    // Wait for the collapsible header to appear - use getByText for more flexible matching
    // Note: If this fails, ensure `pnpm run generate:importmap` has been run
    console.log('[test] Looking for "Bulk Embed All" text...')
    const bulkEmbedAllText = page.getByText('Bulk Embed All', { exact: false })
    await expect(bulkEmbedAllText).toBeVisible({ timeout: 15000 })
    console.log('[test] Found "Bulk Embed All" text!')

    // Click the button that contains the h3 with "Bulk Embed All" text
    // The button wraps the h3, so we click the button that contains the h3
    const expandButton = page.locator('button:has(h3:has-text("Bulk Embed All"))')
    // If that doesn't work, try clicking the parent of the text
    if ((await expandButton.count()) === 0) {
      const parentButton = bulkEmbedAllText.locator('..').locator('button').first()
      await parentButton.click()
    } else {
      await expandButton.click()
    }

    // Wait for the expanded content to appear (the Embed All button should become visible)
    await page.waitForTimeout(500) // Small delay for animation

    // Now find and click the Embed All button (should be visible after expansion)
    // Use a more specific selector to avoid clicking the expand button again
    const embedAllButton = page.locator('button.btn--style-primary:has-text("Embed all")')
    await expect(embedAllButton).toBeVisible({ timeout: 5000 })
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
      console.log('[test] Polling for status...')
      // Refresh the page to see updated status
      await page.reload()
      await page.waitForLoadState('domcontentloaded')

      // Get the status value - React Select displays value in .rs__single-value
      const statusValue = await statusField
        .locator('.rs__single-value')
        .textContent()
        .catch(() => null)
      console.log('[test] Status value:', statusValue)
      if (statusValue) {
        finalStatus = statusValue
        console.log('[test] Status value:', statusValue)
        if (statusValue === 'succeeded') {
          break
        }
      }

      attempts++
      await page.waitForTimeout(3000)
    }

    expect(finalStatus).toBe('succeeded')

    // Now verify vector-search returns results for bulkDefault pool
    const filledResponse = await request.post('/api/vector-search', {
      data: {
        query: title,
        knowledgePool: 'bulkDefault',
      },
    })
    await expectVectorSearchResponse(filledResponse, post, title)
  })

  test('clicking expand section on default collection shows not enabled message', async ({
    page,
  }) => {
    console.log('[test] Starting default collection test...')

    // Login to admin first
    console.log('[test] Logging in...')
    await loginToAdmin(page)

    // Navigate to the default embeddings collection page in admin
    console.log('[test] Navigating to default collection page...')
    await page.goto('/admin/collections/default', { waitUntil: 'networkidle' })
    console.log('[test] Page loaded')

    // Wait for the page to fully load and render
    console.log('[test] Waiting for page to fully load...')
    await page.waitForLoadState('domcontentloaded')
    await page.waitForLoadState('networkidle')
    console.log('[test] Page fully loaded')

    // Wait for the collapsible header to appear - use getByText for more flexible matching
    // Note: If this fails, ensure `pnpm run generate:importmap` has been run
    console.log('[test] Looking for "Bulk Embed All" text...')
    const bulkEmbedAllText = page.getByText('Bulk Embed All', { exact: false })
    await expect(bulkEmbedAllText).toBeVisible({ timeout: 15000 })
    console.log('[test] Found "Bulk Embed All" text!')

    // Click the button that contains the h3 with "Bulk Embed All" text
    const expandButton = page.locator('button:has(h3:has-text("Bulk Embed All"))')
    // If that doesn't work, try clicking the parent of the text
    if ((await expandButton.count()) === 0) {
      const parentButton = bulkEmbedAllText.locator('..').locator('button').first()
      await parentButton.click()
    } else {
      await expandButton.click()
    }

    // Wait for the expanded content to appear
    await page.waitForTimeout(500) // Small delay for animation

    // Verify the "Bulk embedding not configured" message appears
    const notConfiguredMessage = page.locator('text=/Bulk embedding not configured/i')
    await expect(notConfiguredMessage).toBeVisible({ timeout: 5000 })

    // Verify the message about configuring bulkEmbeddingsFns appears
    const configMessage = page.locator('text=/bulkEmbeddingsFns/i')
    await expect(configMessage).toBeVisible({ timeout: 5000 })
  })
})
