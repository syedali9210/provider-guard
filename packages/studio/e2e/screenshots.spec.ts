import { join } from 'node:path'
import { expect, test } from '@playwright/test'

// README screenshots. Run with: SCREENSHOTS=1 pnpm --filter @provider-guard/studio e2e -g screenshots
test.skip(!process.env.SCREENSHOTS, 'set SCREENSHOTS=1 to regenerate docs/ screenshots')

const docs = join(import.meta.dirname, '..', '..', '..', 'docs')

// Reduced motion: every row is captured in its final state, never mid-animation.
test.use({ viewport: { width: 1280, height: 760 }, colorScheme: 'light', reducedMotion: 'reduce' })

test('screenshots', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('tr.feed-row', { hasText: 'Caught' }).first()).toBeVisible()
  const caught = page.locator('tr.feed-row', { hasText: 'Caught → recovered on' }).first()
  await caught.hover()
  await caught.click()
  await expect(page.getByText('Matched billed-but-empty')).toBeVisible()
  await page.mouse.move(640, 740)
  await page.screenshot({ path: join(docs, 'studio-catch.png') })

  await page.keyboard.press('Escape')
  await page.getByRole('tab', { name: 'Providers' }).click()
  const table = page.getByRole('table', { name: 'Provider health for zai/glm-5.3-flash' })
  await expect(table.locator('.badge', { hasText: 'Outlier' })).toBeVisible()
  await page.screenshot({ path: join(docs, 'studio-providers.png') })

  await page.getByRole('button', { name: /^openai\/gpt-5\.6-sol/ }).click()
  await expect(page.getByRole('row', { name: /^bedrock/ }).last()).toContainText(
    'effort appears ignored',
  )
  await page.screenshot({ path: join(docs, 'studio-reasoning.png') })
})
