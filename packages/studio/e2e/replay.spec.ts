import { expect, test } from '@playwright/test'

// PRD §10: the replay build loads, a catch appears, the drawer opens, and Providers flags Baseten.
// PRD §13: the catch, the Baseten outlier, and the Bedrock collapse all show within 30 seconds.
test.describe.configure({ timeout: 30_000 })

test('the replay demo shows a catch, its anatomy, the Baseten outlier, and Bedrock ignoring effort', async ({
  page,
}) => {
  await page.goto('/')

  await expect(page.getByRole('note')).toHaveText(
    'Replay reconstructed from data published in vercel/ai#20932 and #21207. No live traffic.',
  )
  await expect(page.getByText('Replay · vercel/ai#20932, #21207')).toBeVisible()

  // A catch arrives live and plays its animation.
  await expect(page.locator('tr.feed-row.catching')).toHaveCount(1, { timeout: 15_000 })

  // Hovering holds the rows still, so the click lands on the row it aimed at.
  const caught = page.locator('tr.feed-row', { hasText: 'Caught → recovered on' }).first()
  await caught.hover()
  await caught.click()
  const dialog = page.getByRole('dialog', { name: 'Call Anatomy' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('Matched billed-but-empty')).toBeVisible()
  await expect(dialog.getByText('spliced into the same stream')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  await page.getByRole('tab', { name: 'Providers' }).click()
  const glm = page.getByRole('table', { name: 'Provider health for zai/glm-5.3-flash' })
  await expect(glm.getByRole('row', { name: /^baseten/ })).toContainText('Outlier')
  await expect(glm.getByRole('row', { name: /^baseten/ })).toContainText('p <')

  await page.getByRole('button', { name: /^openai\/gpt-5\.6-sol/ }).click()
  await expect(page.getByRole('row', { name: /^bedrock/ }).last()).toContainText(
    'effort appears ignored',
  )
  await expect(page.getByRole('img', { name: /^Reasoning tokens per run/ })).toBeVisible()
})

test('the replay demo has no console errors', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await expect(page.locator('tr.feed-row').first()).toBeVisible()
  await page.getByRole('tab', { name: 'Providers' }).click()
  await expect(page.getByRole('heading', { name: 'zai/glm-5.3-flash' })).toBeVisible()
  expect(errors).toEqual([])
})

for (const width of [1280, 1024, 800, 375]) {
  test(`the Feed fits a ${width}px window without scrolling sideways`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await page.goto('/')
    await expect(
      page.locator('tr.feed-row', { hasText: 'Caught → recovered on' }).first(),
    ).toBeVisible()
    const overflow = await page
      .locator('.feed-scroll')
      .evaluate((el) => el.scrollWidth - el.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
  })
}

for (const width of [1280, 800]) {
  test(`at ${width}px the controls stay in the top bar, with no Options button`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 })
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Restart Replay' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'How It Works' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Open Options' })).toBeHidden()
  })
}

test('Providers fits a 375px phone without scrolling sideways', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 })
  await page.goto('/')
  await page.getByRole('tab', { name: 'Providers' }).click()
  for (const [button, heading] of [
    [/^zai\/glm-5\.3-flash/, 'zai/glm-5.3-flash'],
    [/^openai\/gpt-5\.6-sol/, 'openai/gpt-5.6-sol'],
  ] as const) {
    await page.getByRole('button', { name: button }).click()
    await expect(page.getByRole('heading', { name: heading })).toBeVisible()
    const overflow = await page
      .locator('.providers-section')
      .evaluateAll((els) => Math.max(...els.map((el) => el.scrollWidth - el.clientWidth)))
    expect(overflow).toBeLessThanOrEqual(0)
  }
})

test.describe('a first visit', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test('How It Works explains the gap beside the replay, then stays closed', async ({ page }) => {
    await page.goto('/')
    const intro = page.getByRole('dialog', { name: 'How It Works' })
    await expect(intro.getByRole('heading', { name: 'One Model, Many Providers' })).toBeVisible()
    // The replay plays beside it, so the first catch shows while the story is told.
    await expect(page.locator('tr.feed-row.catching')).toHaveCount(1, { timeout: 15_000 })

    for (let i = 0; i < 4; i++) await intro.getByRole('button', { name: 'Next' }).click()
    await expect(intro.getByText(/Caught → recovered on/)).toBeVisible()
    await intro.getByRole('button', { name: 'Done' }).click()
    await expect(intro).toBeHidden()
    await expect(page.getByRole('button', { name: 'How It Works' })).toBeFocused()

    await page.reload()
    await expect(page.locator('tr.feed-row').first()).toBeVisible()
    await expect(intro).toBeHidden()
  })

  test('How It Works fits a 375px phone at every step', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 })
    await page.goto('/')
    const intro = page.getByRole('dialog', { name: 'How It Works' })
    for (let step = 1; step <= 5; step++) {
      await expect(intro.getByText(`${step} of 5`)).toBeVisible()
      const overflow = await intro.evaluate((el) => el.scrollWidth - el.clientWidth)
      expect(overflow).toBeLessThanOrEqual(0)
      if (step < 5) await intro.getByRole('button', { name: 'Next' }).click()
    }
  })
})

// An iPhone-sized screen (390 wide, 664 tall once the browser's own bars are drawn).
const phone = { viewport: { width: 390, height: 664 }, isMobile: true, hasTouch: true }

test.describe('on a phone', () => {
  test.use(phone)

  test('the Feed scrolls with the page under a one-row top bar that stays in view', async ({
    page,
  }) => {
    await page.goto('/')
    await expect(page.locator('tr.feed-row', { hasText: 'Caught' }).first()).toBeVisible()
    await expect(page.getByRole('button', { name: 'Open Options' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Restart Replay' })).toBeHidden()
    const layout = await page.evaluate(() => {
      const list = document.querySelector('.feed-scroll') as HTMLElement
      return {
        topbar: document.querySelector('.topbar')?.getBoundingClientRect().height ?? 0,
        pageScrolls: document.documentElement.scrollHeight > innerHeight,
        listScrolls: list.scrollHeight > list.clientHeight + 1,
      }
    })
    expect(layout.topbar).toBeLessThanOrEqual(110)
    expect(layout.pageScrolls).toBe(true)
    expect(layout.listScrolls).toBe(false)

    // A caught call fits the row height: the result drops "Caught", which the red flag says.
    const heights = await page
      .locator('tr.feed-row')
      .evaluateAll((rows) => rows.map((r) => r.getBoundingClientRect().height))
    expect(Math.max(...heights)).toBeLessThanOrEqual(44)

    await page.evaluate(() => window.scrollTo(0, 1500))
    await expect(page.getByRole('tab', { name: 'Providers' })).toBeInViewport()
  })

  test('Options is a bottom drawer with the controls; a tap outside closes it', async ({
    page,
  }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Open Options' }).click()
    const options = page.getByRole('dialog', { name: 'Options' })
    await expect(options.getByRole('button', { name: 'Restart Replay' })).toBeVisible()
    await expect(options.getByRole('combobox', { name: 'Time range' })).toBeVisible()
    const box = await options.boundingBox()
    expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(664)
    // The page behind does not scroll while a drawer is open.
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).toBe(
      'hidden',
    )
    await page.mouse.click(195, 20)
    await expect(options).toBeHidden()
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).not.toBe(
      'hidden',
    )
  })

  test('a drawer closes when its handle is swiped down', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Open Options' }).click()
    const options = page.getByRole('dialog', { name: 'Options' })
    const handle = await options.locator('.sheet-handle').boundingBox()
    if (!handle) throw new Error('no handle')
    const x = handle.x + handle.width / 2
    await page.mouse.move(x, handle.y + handle.height / 2)
    await page.mouse.down()
    await page.mouse.move(x, handle.y + 200, { steps: 8 })
    await page.mouse.up()
    await expect(options).toBeHidden()
  })
})

test.describe('a first visit on a phone', () => {
  test.use({ ...phone, storageState: { cookies: [], origins: [] } })

  test('How It Works fits its drawer without scrolling, at every step', async ({ page }) => {
    await page.goto('/')
    const intro = page.getByRole('dialog', { name: 'How It Works' })
    for (let step = 1; step <= 5; step++) {
      await expect(intro.getByText(`${step} of 5`)).toBeVisible()
      const extra = await intro.evaluate((el) => el.scrollHeight - el.clientHeight)
      expect(extra, `step ${step} scrolls`).toBeLessThanOrEqual(0)
      if (step < 5) await intro.getByRole('button', { name: 'Next' }).click()
    }
  })
})
