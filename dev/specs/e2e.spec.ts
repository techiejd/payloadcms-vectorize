import { expect, test } from '@playwright/test'
import type { Payload, SanitizedConfig } from 'payload'
import config from '@payload-config'
import { getPayload } from 'payload'
import { getInitialMarkdownContent } from './constants.js'
import { waitForVectorizationJobs, waitForBulkJobs } from './utils.js'
import { testEmbeddingVersion } from 'helpers/embed.js'
import { devUser } from 'helpers/credentials.js'
import { BULK_EMBEDDINGS_RUNS_SLUG } from '../../src/collections/bulkEmbeddingsRuns.js'
import { BULK_EMBEDDINGS_BATCHES_SLUG } from '../../src/collections/bulkEmbeddingsBatches.js'

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

    // Get the run ID from the current URL
    const runUrl = page.url()
    const runIdMatch = runUrl.match(/\/(\d+)$/)
    const bulkRunId = runIdMatch ? runIdMatch[1] : null
    expect(bulkRunId).not.toBeNull()
    console.log('[test] Bulk run ID:', bulkRunId)

    // Find the succeeded batch that was created
    const succeededBatches = await (payload as any).find({
      collection: BULK_EMBEDDINGS_BATCHES_SLUG,
      where: {
        and: [{ run: { equals: bulkRunId } }, { status: { equals: 'succeeded' } }],
      },
    })
    expect(succeededBatches.totalDocs).toBeGreaterThan(0)
    const succeededBatch = succeededBatches.docs[0]
    console.log('[test] Found succeeded batch:', succeededBatch.id)

    // Test: Retry endpoint returns 400 for succeeded batch
    const succeededRetryResponse = await request.post('/api/vector-retry-failed-batch', {
      data: { batchId: String(succeededBatch.id) },
    })
    expect(succeededRetryResponse.status()).toBe(400)
    const succeededRetryJson = await succeededRetryResponse.json()
    expect(succeededRetryJson.error).toContain('not in failed or retried status')
    console.log('[test] Retry endpoint correctly rejected succeeded batch')

    // Navigate to the succeeded batch page and verify retry button is disabled
    console.log('[test] Navigating to succeeded batch page...')
    await page.goto(`/admin/collections/${BULK_EMBEDDINGS_BATCHES_SLUG}/${succeededBatch.id}`, {
      waitUntil: 'networkidle',
    })
    await page.waitForLoadState('domcontentloaded')

    // Look for the retry button - it should be present but disabled
    const retryButton = page.locator('[data-testid="retry-failed-batch-button"]')
    await expect(retryButton).toBeVisible({ timeout: 15000 })

    // Verify the button is disabled (opacity check)
    const buttonStyle = await retryButton.getAttribute('style')
    console.log('[test] Button style:', buttonStyle)
    expect(buttonStyle).toContain('opacity:0.5')

    // Verify the "Retry Not Available" message is shown
    const notAvailableMessage = page.locator('text=/Retry Not Available/i')
    await expect(notAvailableMessage).toBeVisible({ timeout: 5000 })

    console.log('[test] Retry button correctly disabled for succeeded batch!')
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

  test('retry failed batch endpoint returns 404 for non-existent batch', async ({ request }) => {
    console.log('[test] Testing non-existent batch retry...')

    const nonExistentResponse = await request.post('/api/vector-retry-failed-batch', {
      data: { batchId: '999999' },
    })
    expect(nonExistentResponse.status()).toBe(404)

    console.log('[test] Non-existent batch test completed!')
  })

  test('retry failed batch endpoint works correctly', async ({ request }) => {
    console.log('[test] Starting retry failed batch endpoint test...')

    // Create a test post first (needed for bulk embedding to have something to embed)
    const post = await payload.create({
      collection: 'posts',
      data: {
        title: 'Failed batch test post',
      },
    })
    console.log('[test] Created test post:', post.id)

    // Use the bulk embed endpoint to create a run for failingBulkDefault pool
    const bulkEmbedResponse = await request.post('/api/vector-bulk-embed', {
      data: {
        knowledgePool: 'failingBulkDefault',
      },
    })
    expect(bulkEmbedResponse.ok()).toBe(true)
    const bulkEmbedJson = await bulkEmbedResponse.json()
    const runId = bulkEmbedJson.runId
    console.log('[test] Created bulk run via endpoint:', runId)

    // Wait for the bulk jobs to process and fail (failingBulkDefault has a mock that fails)
    await waitForBulkJobs(payload, 30000)
    console.log('[test] Bulk jobs completed')

    // Wait for the batch to actually fail (poll-or-complete job needs to finish)
    const runIdNum = parseInt(runId, 10)
    let batches: any
    let attempts = 0
    const maxAttempts = 30 // Wait up to 30 seconds

    while (attempts < maxAttempts) {
      batches = await (payload as any).find({
        collection: BULK_EMBEDDINGS_BATCHES_SLUG,
        where: {
          and: [{ run: { equals: runIdNum } }, { status: { equals: 'failed' } }],
        },
      })

      if (batches.totalDocs > 0) {
        break
      }

      // Check current batch status
      const allBatches = await (payload as any).find({
        collection: BULK_EMBEDDINGS_BATCHES_SLUG,
        where: { run: { equals: runIdNum } },
      })
      if (allBatches.totalDocs > 0) {
        const currentStatus = allBatches.docs[0].status
        if (currentStatus === 'failed') {
          batches = allBatches
          break
        }
      }

      // Wait a bit before retrying
      await new Promise((resolve) => setTimeout(resolve, 1000))
      attempts++
    }

    if (!batches || batches.totalDocs === 0) {
      // Final check for debugging
      const allBatchesFinal = await (payload as any).find({
        collection: BULK_EMBEDDINGS_BATCHES_SLUG,
        where: { run: { equals: runIdNum } },
      })
      const runFinal = await (payload as any).findByID({
        collection: BULK_EMBEDDINGS_RUNS_SLUG,
        id: runId,
      })
      console.log('[test] Failed to find failed batch after', attempts, 'attempts')
      console.log('[test] Run status:', runFinal.status)
      console.log('[test] Batches found:', allBatchesFinal.totalDocs)
      if (allBatchesFinal.totalDocs > 0) {
        console.log(
          '[test] Batch statuses:',
          allBatchesFinal.docs.map((b: any) => b.status),
        )
      }
    }

    expect(batches?.totalDocs).toBeGreaterThan(0)
    const batch = batches.docs[0]
    console.log('[test] Found failed batch:', batch.id)

    // Retry the failed batch (should succeed)
    const retryResponse = await request.post('/api/vector-retry-failed-batch', {
      data: { batchId: String(batch.id) },
    })
    expect(retryResponse.status()).toBe(202)
    const retryJson = await retryResponse.json()
    expect(retryJson.message).toBe('Failed batch has been resubmitted and re-queued for processing')
    expect(retryJson.batchId).toBe(String(batch.id))
    expect(retryJson.newBatchId).toBeDefined()
    expect(retryJson.status).toBe('queued')

    // Verify the old batch status was updated to 'retried'
    const updatedBatch = await (payload as any).findByID({
      collection: BULK_EMBEDDINGS_BATCHES_SLUG,
      id: String(batch.id),
    })
    expect(updatedBatch.status).toBe('retried')
    expect(updatedBatch.retriedBatch).toBeDefined()

    // Verify the new batch exists and is queued
    const newBatch = await (payload as any).findByID({
      collection: BULK_EMBEDDINGS_BATCHES_SLUG,
      id: retryJson.newBatchId,
    })
    expect(newBatch.status).toBe('queued')
    expect(newBatch.providerBatchId).toBeDefined()
    expect(newBatch.providerBatchId).not.toBe(batch.providerBatchId)

    // Verify the run status was reset to running
    const updatedRun = await (payload as any).findByID({
      collection: BULK_EMBEDDINGS_RUNS_SLUG,
      id: runId,
    })
    expect((updatedRun as any).status).toBe('running')

    console.log('[test] Retry failed batch endpoint test completed successfully!')
  })

  test('retry failed batch button works for failed batches', async ({ page, request }) => {
    console.log('[test] Starting retry button click test...')
    test.setTimeout(120000)

    // Login first
    await loginToAdmin(page)

    // Create a test post first (needed for bulk embedding to have something to embed)
    const post = await payload.create({
      collection: 'posts',
      data: {
        title: 'Failed batch UI test post',
      },
    })
    console.log('[test] Created test post:', post.id)

    // Use the bulk embed endpoint to create a run for failingBulkDefault pool
    const bulkEmbedResponse = await request.post('/api/vector-bulk-embed', {
      data: {
        knowledgePool: 'failingBulkDefault',
      },
    })
    expect(bulkEmbedResponse.ok()).toBe(true)
    const bulkEmbedJson = await bulkEmbedResponse.json()
    const runId = bulkEmbedJson.runId
    console.log('[test] Created bulk run via endpoint:', runId)

    // Wait for the bulk jobs to process and fail (failingBulkDefault has a mock that fails)
    await waitForBulkJobs(payload, 30000)
    console.log('[test] Bulk jobs completed')

    // Wait for the batch to actually fail (poll-or-complete job needs to finish)
    const runIdNum = parseInt(runId, 10)
    let batches: any
    let attempts = 0
    const maxAttempts = 30 // Wait up to 30 seconds

    while (attempts < maxAttempts) {
      batches = await (payload as any).find({
        collection: BULK_EMBEDDINGS_BATCHES_SLUG,
        where: {
          and: [{ run: { equals: runIdNum } }, { status: { equals: 'failed' } }],
        },
      })

      if (batches.totalDocs > 0) {
        break
      }

      // Check current batch status
      const allBatches = await (payload as any).find({
        collection: BULK_EMBEDDINGS_BATCHES_SLUG,
        where: { run: { equals: runIdNum } },
      })
      if (allBatches.totalDocs > 0) {
        const currentStatus = allBatches.docs[0].status
        if (currentStatus === 'failed') {
          batches = allBatches
          break
        }
      }

      // Wait a bit before retrying
      await new Promise((resolve) => setTimeout(resolve, 1000))
      attempts++
    }

    expect(batches?.totalDocs).toBeGreaterThan(0)
    const failedBatch = batches.docs[0]
    console.log('[test] Found failed batch:', failedBatch.id)

    // Navigate to the run edit page (where FailedBatchesList component should be visible)
    console.log('[test] Navigating to run page...')
    await page.goto(`/admin/collections/${BULK_EMBEDDINGS_RUNS_SLUG}/${runId}`, {
      waitUntil: 'networkidle',
    })
    await page.waitForLoadState('domcontentloaded')

    // Wait for the FailedBatchesList component to appear
    const failedBatchesList = page.locator('[data-testid^="failed-batch-link-"]').first()
    await expect(failedBatchesList).toBeVisible({ timeout: 10000 })
    console.log('[test] Failed batches list is visible')

    // Click on the failed batch link to navigate to the batch page
    console.log('[test] Clicking failed batch link...')
    await failedBatchesList.click()

    // Wait for navigation to batch page
    await page.waitForURL(/\/admin\/collections\/vector-bulk-embeddings-batches\/\d+/, {
      timeout: 10000,
    })
    await page.waitForLoadState('domcontentloaded')
    console.log('[test] Navigated to batch page')

    // Look for the retry button
    const retryButton = page.locator('[data-testid="retry-failed-batch-button"]')
    await expect(retryButton).toBeVisible({ timeout: 15000 })

    // Verify the "Retry Failed Batch" message is shown (not "Retry Not Available")
    const retryMessage = page.locator('text=/Retry Failed Batch/i')
    await expect(retryMessage).toBeVisible({ timeout: 5000 })

    // Verify the button is NOT disabled
    const buttonStyle = await retryButton.getAttribute('style')
    expect(buttonStyle).not.toContain('opacity: 0.5')

    // Click the retry button
    console.log('[test] Clicking retry button...')
    await retryButton.click()

    // Wait for success message
    const successMessage = page.locator('text=/Batch resubmitted successfully/i')
    await expect(successMessage).toBeVisible({ timeout: 10000 })

    console.log('[test] Retry button click test completed!')

    // Wait a bit for the page reload
    await page.waitForTimeout(2000)

    // Verify we're still on the batch page after reload
    await page.waitForURL(/\/admin\/collections\/vector-bulk-embeddings-batches\/\d+/)

    console.log('[test] Retry failed batch button test completed successfully!')
  })

  test('missing batchId returns 400 error', async ({ request }) => {
    console.log('[test] Testing missing batchId...')

    const response = await request.post('/api/vector-retry-failed-batch', {
      data: {},
    })

    expect(response.status()).toBe(400)
    const json = await response.json()
    expect(json.error).toContain('batchId is required')

    console.log('[test] Missing batchId test completed!')
  })
})
