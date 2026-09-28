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

for (const width of [1280, 1024, 800]) {
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
