import { expect } from '@playwright/test'
import { test } from '@tanstack/router-e2e-utils'
import type { Page } from '@playwright/test'

async function awaitPageLoaded(page: Page) {
  // wait for page to be loaded by waiting for the ClientOnly component to be rendered

  await expect(page.getByTestId('router-isLoading')).toContainText('false')
  await expect(page.getByTestId('router-status')).toContainText('idle')
}
async function checkData(page: Page, id: string) {
  const expectedData = await page
    .getByTestId(`${id}-car-expected`)
    .textContent()
  expect(expectedData).not.toBeNull()
  await expect(page.getByTestId(`${id}-car-actual`)).toContainText(
    expectedData!,
  )

  await expect(page.getByTestId(`${id}-foo`)).toContainText(
    '{"value":"server"}',
  )
}

async function checkNestedData(page: Page) {
  const expectedShout = await page
    .getByTestId(`shout-expected-state`)
    .textContent()
  expect(expectedShout).not.toBeNull()
  await expect(page.getByTestId(`shout-actual-state`)).toContainText(
    expectedShout!,
  )

  const expectedWhisper = await page
    .getByTestId(`whisper-expected-state`)
    .textContent()
  expect(expectedWhisper).not.toBeNull()
  await expect(page.getByTestId(`whisper-actual-state`)).toContainText(
    expectedWhisper!,
  )
}
test.use({
  whitelistErrors: [
    'Failed to load resource: the server responded with a status of 499',
  ],
})
test.describe('SSR serialization adapters', () => {
  test(`data-only`, async ({ page }) => {
    await page.goto('/ssr/data-only')
    await awaitPageLoaded(page)

    await Promise.all(
      ['context', 'loader'].map(async (id) => checkData(page, id)),
    )

    const expectedHonkData = await page
      .getByTestId('honk-expected-state')
      .textContent()
    expect(expectedHonkData).not.toBeNull()
    await expect(page.getByTestId('honk-actual-state')).toContainText(
      expectedHonkData!,
    )
  })

  test('stream', async ({ page }) => {
    await page.goto('/ssr/stream')
    await awaitPageLoaded(page)
    await checkData(page, 'stream')
  })

  test('stream settles before client JavaScript starts', async ({ page }) => {
    const pageErrors: Array<string> = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    let releaseClient!: () => void
    const clientReady = new Promise<void>((resolve) => {
      releaseClient = resolve
    })
    let heldScripts = 0
    const scriptAssets = '**/assets/*.js'
    await page.route(scriptAssets, async (route) => {
      heldScripts++
      await clientReady
      await route.continue()
    })

    try {
      const response = await page.goto('/ssr/stream', {
        waitUntil: 'commit',
      })
      expect(response).not.toBeNull()
      // Finish the real deferred SSR response before allowing the app module
      // to initialize its serialization adapters. No fixture timer changes.
      await response!.finished()
      expect(heldScripts).toBeGreaterThan(0)
      releaseClient()
      await page.waitForLoadState('load')

      expect(pageErrors).toEqual([])
      await awaitPageLoaded(page)
      await checkData(page, 'stream')
    } finally {
      releaseClient()
      await page.unroute(scriptAssets)
    }
  })

  test('nested', async ({ page }) => {
    await page.goto('/ssr/nested')
    await awaitPageLoaded(page)

    await checkNestedData(page)
  })
})

test.describe('server functions serialization adapters', () => {
  test('custom error', async ({ page }) => {
    await page.goto('/server-function/custom-error')
    await awaitPageLoaded(page)

    await expect(
      page.getByTestId('server-function-valid-response'),
    ).toContainText('null')
    await expect(
      page.getByTestId('server-function-invalid-response'),
    ).toContainText('null')

    await page.getByTestId('server-function-valid-input').click()
    await expect(
      page.getByTestId('server-function-valid-response'),
    ).toContainText('Hello, world!')

    await page.getByTestId('server-function-invalid-input').click()
    await expect(
      page.getByTestId('server-function-invalid-response'),
    ).toContainText('{"message":"Invalid input","foo":"bar","bar":"123"}')
  })
  test('nested', async ({ page }) => {
    await page.goto('/server-function/nested')
    await awaitPageLoaded(page)

    await expect(page.getByTestId('waiting-for-response')).toContainText(
      'waiting for response...',
    )

    await page.getByTestId('server-function-trigger').click()
    await checkNestedData(page)
  })
})
