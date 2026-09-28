import type { CallRecord } from '@core/records'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test } from 'vitest'
import { datasetsFor, planReplay, replayLabel, resultOf, toCalls } from '../src/data'
import {
  allRecords,
  caught,
  caughtRetry,
  healthy,
  makeSource,
  records20932,
  records21207,
  renderStudio,
} from './helpers'

async function openProviders() {
  const user = userEvent.setup()
  await user.click(screen.getByRole('tab', { name: 'Providers' }))
  return user
}

describe('Providers', () => {
  test('flags Baseten as the outlier for zai/glm-5.3-flash, with its Fisher p-value', async () => {
    renderStudio(makeSource(allRecords))
    await openProviders()

    const table = screen.getByRole('table', { name: 'Provider health for zai/glm-5.3-flash' })
    const baseten = within(table).getByRole('row', { name: /^baseten/ })
    expect(within(baseten).getByText('Outlier')).toBeInTheDocument()
    expect(within(baseten).getByText('p < 0.0001')).toBeInTheDocument()
    expect(within(baseten).getByText('22 (43.1%)')).toBeInTheDocument()
    expect(within(baseten).getByText('51')).toBeInTheDocument()
    const zai = within(table).getByRole('row', { name: /^zai/ })
    expect(within(zai).queryByText('Outlier')).not.toBeInTheDocument()
  })

  test('the p-value explains the test in a tooltip on keyboard focus', async () => {
    renderStudio(makeSource(allRecords))
    const user = await openProviders()
    const p = screen.getByText('p < 0.0001')
    p.focus()
    await waitFor(() => expect(screen.getByRole('tooltip')).toBeVisible())
    expect(screen.getByRole('tooltip')).toHaveTextContent('One-sided Fisher exact test')
    await user.keyboard('{Escape}')
    // Closed tooltips are hidden, so they leave the accessibility tree.
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  test('the model list shows call and catch counts and switches models', async () => {
    renderStudio(makeSource(allRecords))
    const user = await openProviders()
    const list = screen.getByRole('navigation', { name: 'Models' })
    const items = within(list).getAllByRole('button')
    expect(items.map((i) => i.textContent)).toEqual([
      'zai/glm-5.3-flash88 calls · 22 caughtoutlier',
      'zai/glm-4.766 calls · 0 caught',
      'openai/gpt-5.6-sol12 calls · 0 caught',
    ])
    expect(items[0]).toHaveAttribute('aria-current', 'true')

    await user.click(items[1] as HTMLElement)
    const table = screen.getByRole('table', { name: 'Provider health for zai/glm-4.7' })
    const baseten = within(table).getByRole('row', { name: /^baseten/ })
    // Report-only: Baseten never reasons for this model.
    expect(within(baseten).getByText('0%')).toBeInTheDocument()
  })

  test('the reasoning panel shows Bedrock ignoring effort (vercel/ai#21207)', async () => {
    renderStudio(makeSource(allRecords))
    const user = await openProviders()
    await user.click(screen.getByRole('button', { name: /^openai\/gpt-5\.6-sol/ }))

    expect(screen.getByRole('heading', { name: 'Reasoning by Effort Level' })).toBeInTheDocument()
    const plot = screen.getByRole('img', { name: /^Reasoning tokens per run\./ })
    expect(plot).toHaveAccessibleName(
      expect.stringContaining(
        'bedrock: low median 2,704, xhigh median 3,060, effort appears ignored',
      ),
    )
    expect(plot.querySelectorAll('.run-dot')).toHaveLength(12)

    const medians = screen.getAllByRole('table').at(-1) as HTMLElement
    const bedrock = within(medians).getByRole('row', { name: /^bedrock/ })
    expect(within(bedrock).getByText('effort appears ignored')).toBeInTheDocument()
    const openai = within(medians).getByRole('row', { name: /^openai/ })
    expect(within(openai).getByText('1,750')).toBeInTheDocument()
    expect(within(openai).getByText('6,711')).toBeInTheDocument()
    expect(within(openai).queryByText('effort appears ignored')).not.toBeInTheDocument()
  })

  test('has an empty state before the first call', async () => {
    renderStudio(makeSource([]))
    await openProviders()
    expect(screen.getByRole('heading', { name: 'No Provider Data Yet' })).toBeInTheDocument()
  })
})

describe('Call anatomy', () => {
  async function openCaught() {
    const user = userEvent.setup()
    renderStudio(makeSource([caught, caughtRetry]))
    await user.click(
      screen.getAllByRole('row').find((r) => r.dataset.callId === caught.id) as HTMLElement,
    )
    return { user, dialog: screen.getByRole('dialog', { name: 'Call Anatomy' }) }
  }

  test('shows the model, the attempts in order, and copyable ids', async () => {
    // userEvent.setup() installs a clipboard stub; read the copied text back from it.
    const { user, dialog } = await openCaught()

    expect(within(dialog).getByText('zai/glm-5.3-flash')).toBeInTheDocument()
    const attempts = within(dialog).getByRole('list', { name: 'Attempts in order' })
    expect(
      within(attempts)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['baseten', `→${caughtRetry.provider}`])
    await user.click(within(dialog).getByRole('button', { name: 'Copy record id' }))
    expect(await navigator.clipboard.readText()).toBe(caught.id)
    expect(within(dialog).getByRole('button', { name: 'Copy generation id' })).toBeDisabled()
  })

  test('plots each attempt on a shared time axis, the retry marked as spliced in', async () => {
    const { dialog } = await openCaught()
    const timeline = within(dialog).getByRole('img', { name: /^Attempt 1 · baseten/ })
    expect(timeline).toHaveAccessibleName(
      expect.stringContaining(`Attempt 2 · ${caughtRetry.provider}: 4 stream parts`),
    )
    expect(timeline).toHaveAccessibleName(expect.stringContaining('spliced into the same stream'))
    expect(timeline.querySelectorAll('.mark-reasoning')).toHaveLength(4)
    expect(timeline.querySelectorAll('.mark-text')).toHaveLength(1)
    expect(timeline.querySelectorAll('.mark-finish')).toHaveLength(2)
    expect(
      within(dialog).getByText('spliced into the same stream', { exact: false }),
    ).toBeInTheDocument()
  })

  test('renders the evidence as the actual checks', async () => {
    const { dialog } = await openCaught()
    const checks = within(dialog)
      .getAllByRole('listitem')
      .filter((li) => li.closest('.checks'))
    expect(checks.map((li) => li.textContent)).toEqual([
      'Finish reasonstopmatches',
      'Text tokens billed4matches',
      'Text delivered0 charsmatches',
      'Tool calls0matches',
    ])
    expect(within(dialog).getByText('Matched billed-but-empty')).toBeInTheDocument()
  })

  test('totals sum both attempts and say both were billed', async () => {
    const { dialog } = await openCaught()
    const totals = within(dialog).getByRole('heading', { name: 'Totals' })
      .parentElement as HTMLElement
    const sumIn = (caught.tokens.in ?? 0) + (caughtRetry.tokens.in ?? 0)
    expect(within(totals).getByText(sumIn.toLocaleString('en-US'))).toBeInTheDocument()
    expect(within(totals).getByText(/Both were billed/)).toBeInTheDocument()
  })

  test('a non-streamed call explains why it has no parts', async () => {
    const user = userEvent.setup()
    const generated = records21207[0] as CallRecord
    renderStudio(makeSource([generated]))
    await user.click(
      screen.getAllByRole('row').find((r) => r.dataset.callId === generated.id) as HTMLElement,
    )
    expect(
      screen.getByText('Generated without streaming, so there are no stream parts to plot.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Why It Was Caught' })).not.toBeInTheDocument()
  })
})

describe('data', () => {
  test('toCalls folds retries into the call they retried and orders newest first', () => {
    const calls = toCalls(records20932)
    expect(calls).toHaveLength(132)
    const call = calls.find((c) => c.id === caught.id)
    expect(call?.second?.id).toBe(caughtRetry.id)
    expect(calls.map((c) => c.ts)).toEqual([...calls.map((c) => c.ts)].sort((a, b) => b - a))
  })

  test('a retry whose original is missing stands alone', () => {
    const calls = toCalls([caughtRetry])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.first.id).toBe(caughtRetry.id)
  })

  test('resultOf maps every retry outcome', () => {
    const base = healthy(1, { flags: ['billed-but-empty'] })
    const retry = (outcome: string, skipReason: string | null = null) =>
      ({
        ...base,
        retry: { attempted: outcome !== 'skipped', provider: 'zai', outcome, skipReason },
      }) as CallRecord
    expect(resultOf(healthy(1))).toBe('delivered')
    expect(resultOf(base)).toBe('not-retried')
    expect(resultOf(retry('recovered'))).toBe('recovered')
    expect(resultOf(retry('still-empty'))).toBe('still-empty')
    expect(resultOf(retry('failed'))).toBe('failed')
    expect(resultOf(retry('skipped', 'no-alternative-provider'))).toBe('no-other-provider')
    expect(resultOf(retry('skipped', 'aborted'))).toBe('not-retried')
  })

  test('the replay plan shows reasoning runs at once and starts playback just before a catch', () => {
    const { history, live } = planReplay({
      'vercel-ai-20932': records20932,
      'vercel-ai-21207': records21207,
    })
    const historyIds = new Set(history.flat().map((r) => r.id))
    expect(records21207.every((r) => historyIds.has(r.id))).toBe(true)
    expect(history.length + live.length).toBe(144)
    const firstCatch = live.findIndex((g) => (g[0] as CallRecord).flags.length > 0)
    expect(firstCatch).toBe(2)
    // Retries stay with the call they retried.
    expect(
      live
        .flat()
        .filter((r) => r.retryOf)
        .every((r) => live.some((g) => g[0]?.id === r.retryOf)),
    ).toBe(true)
  })

  test('replay labels', () => {
    expect(replayLabel(datasetsFor('all'))).toBe('Replay · vercel/ai#20932, #21207')
    expect(replayLabel(datasetsFor('vercel-ai-21207'))).toBe('Replay · vercel/ai#21207')
  })
})
