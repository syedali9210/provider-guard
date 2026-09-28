import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Locator, type Page, test } from '@playwright/test'

// Pitch media, made from the replay build:
// - docs/og.png: the demo's link-preview image (committed; the replay build serves it)
// - docs/demo.mp4: about a minute, catch → Call anatomy → Providers → the code (not committed;
//   needs ffmpeg on PATH)
// Run with: PITCH=1 pnpm --filter @provider-guard/studio e2e -g pitch
test.skip(!process.env.PITCH, 'set PITCH=1 to regenerate docs/og.png and docs/demo.mp4')

const root = join(import.meta.dirname, '..', '..', '..')
const docs = join(root, 'docs')
const core = JSON.parse(readFileSync(join(root, 'packages', 'core', 'package.json'), 'utf8'))
const links = {
  demo: 'provider-guard-demo.vercel.app',
  repo: core.repository.url.replace(/^git\+https:\/\//, '').replace(/\.git$/, ''),
}

type Card = 'title' | 'problem' | 'end'
declare global {
  interface Window {
    pg: { card(card: Card | null): Promise<void>; caption(text: string | null): Promise<void> }
  }
}

/** Adds full-screen cards, captions, and a visible cursor. Runs in the page. */
function installKit({ demo, repo }: { demo: string; repo: string }) {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const style = document.createElement('style')
  style.textContent = `
    .pg-cover { position: fixed; inset: 0; z-index: 2147483000; display: grid; place-items: center;
      background: var(--ds-background-100); transition: opacity 400ms ease; }
    .pg-card { display: grid; gap: 28px; width: min(1100px, 100% - 96px); color: var(--ds-gray-1000);
      font-family: var(--font-geist-sans); transition: opacity 250ms ease; }
    .pg-mark { font: 600 22px/1 var(--font-mono); letter-spacing: -0.02em; }
    .pg-big { margin: 0; font: 600 52px/1.1 var(--font-geist-sans); letter-spacing: -0.045em; }
    .pg-dim, .pg-sub, .pg-foot, .pg-links dt, .pg-c { color: var(--ds-gray-900); }
    .pg-sub { max-width: 880px; margin: 0; font: 400 24px/1.45 var(--font-geist-sans); }
    .pg-row { display: flex; align-items: center; gap: 24px; justify-self: start; zoom: 1.5;
      padding: 14px 18px; border-radius: 10px; background: var(--ds-background-200);
      box-shadow: 0 0 0 1px var(--ds-gray-alpha-400); }
    .pg-foot { display: flex; justify-content: space-between; font: 500 20px/1 var(--font-mono); }
    .pg-code { margin: 0; padding: 22px 28px; border-radius: 12px; background: var(--ds-background-200);
      box-shadow: 0 0 0 1px var(--ds-gray-alpha-400); font: 400 22px/1.7 var(--font-mono); white-space: pre; }
    .pg-k { color: var(--ds-purple-900); } .pg-s { color: var(--ds-green-900); } .pg-f { color: var(--ds-blue-900); }
    .pg-links { display: grid; grid-template-columns: max-content 1fr; gap: 12px 24px; margin: 0;
      font: 500 22px/1.2 var(--font-mono); }
    .pg-links dd { margin: 0; }
    .pg-caption { position: fixed; left: 50%; bottom: 28px; z-index: 2147483001; transform: translateX(-50%);
      width: max-content; max-width: 960px; padding: 12px 20px; border-radius: 12px; text-align: center;
      background: var(--ds-background-200); color: var(--ds-gray-1000); transition: opacity 250ms ease;
      box-shadow: 0 0 0 1px var(--ds-gray-alpha-400), 0 12px 32px rgb(0 0 0 / 0.4);
      font: 500 20px/1.4 var(--font-geist-sans); }
    .pg-cursor { position: fixed; z-index: 2147483002; width: 24px; height: 24px; margin: -3px 0 0 -4px;
      pointer-events: none; display: none; }
    .pg-ring { position: fixed; z-index: 2147483001; width: 36px; height: 36px; margin: -18px 0 0 -18px;
      border: 2px solid var(--ds-blue-700); border-radius: 50%; pointer-events: none;
      animation: pg-ring 450ms ease-out forwards; }
    @keyframes pg-ring { from { transform: scale(0.3); opacity: 1; } to { transform: scale(1.4); opacity: 0; } }`
  document.head.append(style)

  // The chips and result of a real caught row, as the Feed draws them.
  const rows = [...document.querySelectorAll('tr.feed-row')]
  const caught = rows.find((r) => r.textContent?.includes('recovered on zai'))
  const row = `<div class="pg-row">${caught?.querySelector('.provider-path')?.outerHTML}${caught?.querySelector('.result')?.outerHTML}</div>`
  const mark = '<div class="pg-mark">provider-guard</div>'
  const cards: Record<Card, string> = {
    title: `${mark}
      <h1 class="pg-big"><span class="pg-dim">The gateway catches errors.</span><br>provider-guard catches successes that aren't.</h1>
      ${row}
      <div class="pg-foot"><span>npm install provider-guard</span><span>${demo}</span></div>`,
    problem: `${mark}
      <h1 class="pg-big">A 200 that bills tokens<br>and delivers nothing.</h1>
      <p class="pg-sub">AI Gateway falls back only when a call fails, so these are never retried. In vercel/ai#20932, Baseten did this in 22 of 51 reasoned calls with tools.</p>`,
    end: `${mark}
      <pre class="pg-code"><span class="pg-c">$</span> npm install provider-guard</pre>
      <pre class="pg-code"><span class="pg-k">import</span> { guard } <span class="pg-k">from</span> <span class="pg-s">'provider-guard'</span>
<span class="pg-k">const</span> guarded = <span class="pg-f">wrapLanguageModel</span>({ model, middleware: <span class="pg-f">guard</span>() })
<span class="pg-k">const</span> result = <span class="pg-f">streamText</span>({ model: guarded, prompt })</pre>
      <dl class="pg-links"><dt>Live demo</dt><dd>${demo}</dd><dt>Source</dt><dd>${repo}</dd></dl>`,
  }

  const cover = document.createElement('div')
  cover.className = 'pg-cover'
  const card = document.createElement('div')
  card.className = 'pg-card'
  cover.append(card)
  const caption = document.createElement('div')
  caption.className = 'pg-caption'
  caption.style.opacity = '0'
  const cursor = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  cursor.setAttribute('class', 'pg-cursor')
  cursor.setAttribute('viewBox', '0 0 24 24')
  cursor.innerHTML =
    '<path d="M4 2.5 19 12l-6.6 1.4L9 20z" fill="#fff" stroke="#000" stroke-width="1.5" stroke-linejoin="round"/>'
  document.body.append(cover, caption, cursor)

  addEventListener(
    'mousemove',
    (e) => {
      cursor.style.display = 'block'
      cursor.style.left = `${e.clientX}px`
      cursor.style.top = `${e.clientY}px`
    },
    true,
  )
  addEventListener(
    'mousedown',
    (e) => {
      const ring = document.createElement('div')
      ring.className = 'pg-ring'
      ring.style.left = `${e.clientX}px`
      ring.style.top = `${e.clientY}px`
      document.body.append(ring)
      setTimeout(() => ring.remove(), 500)
    },
    true,
  )

  window.pg = {
    async card(name) {
      if (name === null) {
        cover.style.opacity = '0'
        await wait(400)
        cover.style.visibility = 'hidden'
        return
      }
      if (card.innerHTML && cover.style.visibility !== 'hidden') {
        card.style.opacity = '0'
        await wait(250)
      }
      card.innerHTML = cards[name]
      cursor.style.display = 'none'
      cover.style.visibility = 'visible'
      cover.style.opacity = '1'
      card.style.opacity = '1'
      await wait(400)
    },
    async caption(text) {
      caption.style.opacity = '0'
      await wait(250)
      if (text === null) return
      caption.textContent = text
      caption.style.opacity = '1'
    },
  }
}

async function openStudio(page: Page) {
  await page.goto('/')
  await expect(page.locator('tr.feed-row', { hasText: 'recovered on zai' }).first()).toBeVisible()
  await page.evaluate(async () => {
    await document.fonts.ready
  })
  await page.evaluate(installKit, links)
}

test.describe('pitch', () => {
  test.use({ colorScheme: 'dark' })

  test.describe('link preview', () => {
    test.use({ viewport: { width: 1200, height: 630 } })

    test('og image', async ({ page }) => {
      await openStudio(page)
      await page.evaluate(() => window.pg.card('title'))
      await page.screenshot({ path: join(docs, 'og.png') })
    })
  })

  test.describe('video', () => {
    test.use({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 })

    test('demo video', async ({ page }) => {
      test.setTimeout(240_000)
      await openStudio(page)
      const show = (card: Card | null) => page.evaluate((c) => window.pg.card(c), card)
      const caption = (text: string | null) => page.evaluate((t) => window.pg.caption(t), text)
      const pointer = createPointer(page)

      await show('title')
      const stop = await record(page)
      await page.waitForTimeout(4000)
      await show('problem')
      await page.waitForTimeout(6500)

      // Restart under the cover, so the next live catch arrives just after the reveal.
      await page.getByRole('button', { name: 'Restart Replay' }).dispatchEvent('click')
      await show(null)
      await caption(
        'A replay of real calls from vercel/ai#20932 and #21207, in provider-guard Studio.',
      )
      await expect(page.locator('tr.feed-row.catching')).toHaveCount(1, { timeout: 15_000 })
      const caught = page.locator('tr.feed-row', { hasText: 'Caught → recovered on' }).first()
      await page.waitForTimeout(1200)
      await caption(
        'Caught: Baseten billed text tokens but sent no text. provider-guard retried it on another provider, in the same stream.',
      )
      await page.waitForTimeout(5000)

      // With the pointer over the list, the Feed holds its rows still.
      await pointer.glide(640, 330)
      await pointer.clickOn(caught.locator('.chip-flagged'))
      await expect(page.getByRole('dialog', { name: 'Call Anatomy' })).toBeVisible()
      await caption(
        'Call anatomy: both attempts on one timeline, and the checks that caught it. Metadata only, never content.',
      )
      await page.waitForTimeout(7000)

      await page.keyboard.press('Escape')
      await pointer.clickOn(page.getByRole('tab', { name: 'Providers' }))
      await expect(
        page.getByRole('table', { name: 'Provider health for zai/glm-5.3-flash' }),
      ).toBeVisible()
      await caption(
        "Providers: Baseten's empty rate is an outlier, by a one-sided Fisher exact test.",
      )
      await page.waitForTimeout(6000)

      await pointer.clickOn(page.getByRole('button', { name: /^openai\/gpt-5\.6-sol/ }))
      await caption(
        'Bedrock spends about the same reasoning at low and xhigh: effort appears ignored.',
      )
      await expect(page.getByRole('row', { name: /^bedrock/ }).last()).toContainText(
        'effort appears ignored',
      )
      await page
        .locator('.dotplot')
        .evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }))
      await page.waitForTimeout(6000)

      await caption(null)
      await show('end')
      await page.waitForTimeout(8000)
      await stop(join(docs, 'demo.mp4'))
    })
  })
})

/** Moves the mouse in visible, eased steps, so the cursor glides instead of jumping. */
function createPointer(page: Page) {
  let at = { x: 1100, y: 620 }
  const glide = async (x: number, y: number, ms = 700) => {
    const from = at
    const steps = Math.round(ms / 16)
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      const e = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2
      await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e)
      await page.waitForTimeout(16)
    }
    at = { x, y }
  }
  const clickOn = async (target: Locator) => {
    const box = await target.boundingBox()
    if (!box) throw new Error('click target is not visible')
    await glide(box.x + box.width / 2, box.y + box.height / 2)
    await page.waitForTimeout(150)
    await page.mouse.down()
    await page.mouse.up()
  }
  return { glide, clickOn }
}

/** Records CDP screencast frames at device resolution; `stop` encodes 1080p H.264 with ffmpeg. */
async function record(page: Page) {
  const dir = mkdtempSync(join(tmpdir(), 'pg-video-'))
  const frames: { file: string; t: number }[] = []
  const cdp = await page.context().newCDPSession(page)
  // Frames arrive only when the page repaints; each is timed on arrival, on one clock.
  const now = () => performance.now() / 1000
  cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
    const file = join(dir, `${String(frames.length).padStart(5, '0')}.jpg`).replaceAll('\\', '/')
    writeFileSync(file, data, 'base64')
    frames.push({ file, t: now() })
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
  })
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 90,
    maxWidth: 2560,
    maxHeight: 1440,
  })

  return async (out: string) => {
    await cdp.send('Page.stopScreencast')
    const end = now()
    const last = frames.at(-1)
    if (!last) throw new Error('no frames were recorded')
    // Each frame lasts until the next one; the concat demuxer needs the last file listed twice.
    const list = frames.map(
      (f, i) => `file '${f.file}'\nduration ${((frames[i + 1]?.t ?? end) - f.t).toFixed(4)}`,
    )
    list.push(`file '${last.file}'`)
    writeFileSync(join(dir, 'list.txt'), list.join('\n'))
    const ffmpeg = spawnSync(
      'ffmpeg',
      [
        ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(dir, 'list.txt')],
        ['-vf', 'scale=1920:1080:flags=lanczos,fps=30,format=yuv420p'],
        ['-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-movflags', '+faststart', out],
      ].flat(),
      { encoding: 'utf8' },
    )
    rmSync(dir, { recursive: true, force: true })
    if (ffmpeg.status !== 0) throw new Error(`ffmpeg failed: ${ffmpeg.error ?? ffmpeg.stderr}`)
  }
}
