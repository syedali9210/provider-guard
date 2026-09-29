import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { ROW_HEIGHT, VIRTUALIZE_ABOVE } from '../src/Feed'
import { allRecords, caught, caughtRetry, healthy, makeSource, renderStudio } from './helpers'
import { media } from './setup'

const rows = () => screen.getAllByRole('row').filter((r) => r.hasAttribute('data-call-id'))

describe('Feed', () => {
  test('shows one row per call, newest first, with the result in words', () => {
    renderStudio(makeSource(allRecords))
    // 154 + 12 attempts, 22 of them retries shown inside their caught call.
    expect(rows()).toHaveLength(144)
    expect(screen.getByText('144 calls · 22 caught · 22 recovered')).toBeInTheDocument()
    const row = document.querySelector(`[data-call-id="${caught.id}"]`) as HTMLElement
    expect(
      within(row).getByText(`Caught → recovered on ${caughtRetry.provider}`),
    ).toBeInTheDocument()
    expect(within(row).getByText('baseten')).toBeInTheDocument()
    expect(within(row).getByText('4 / 2')).toBeInTheDocument()
  })

  test('arrow keys move focus between rows, Enter opens Call anatomy, Esc closes it', async () => {
    const user = userEvent.setup()
    renderStudio(makeSource(allRecords))
    const [first, second] = rows() as [HTMLElement, HTMLElement]

    await user.click(first)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(first).toHaveFocus())

    await user.keyboard('{ArrowDown}')
    expect(second).toHaveFocus()
    expect(second).toHaveAttribute('tabindex', '0')
    expect(first).toHaveAttribute('tabindex', '-1')

    await user.keyboard('{Enter}')
    const dialog = screen.getByRole('dialog', { name: 'Call Anatomy' })
    expect(dialog).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(second).toHaveFocus())

    await user.keyboard('{End}')
    expect(rows().at(-1)).toHaveFocus()
    await user.keyboard('{Home}')
    expect(first).toHaveFocus()
  })

  test('Tab stays inside the open sheet', async () => {
    const user = userEvent.setup()
    renderStudio(makeSource([caught, caughtRetry]))
    await user.click(rows()[0] as HTMLElement)
    const dialog = screen.getByRole('dialog')
    for (let i = 0; i < 6; i++) {
      await user.tab()
      expect(dialog).toContainElement(document.activeElement as HTMLElement)
    }
  })

  test('a caught call that arrives while the screen is open plays the catch animation', () => {
    renderStudio(makeSource([caught, caughtRetry], { fresh: new Set([caught.id]) }))
    expect(rows()[0]).toHaveClass('catching')
  })

  test('with prefers-reduced-motion, the final state shows at once without animating', () => {
    media.reducedMotion = true
    renderStudio(makeSource([caught, caughtRetry], { fresh: new Set([caught.id]) }))
    const row = rows()[0] as HTMLElement
    expect(row).not.toHaveClass('catching')
    // The final state is fully rendered: flag, line to the retry provider, and the check.
    expect(row.querySelector('.chip-flag')).not.toBeNull()
    expect(row.querySelector('.catch-line')).not.toBeNull()
    expect(within(row).getByText(caughtRetry.provider as string)).toBeInTheDocument()
  })

  test('new incidents are announced in a polite live region', () => {
    const { rerenderWith } = renderStudio(makeSource([]))
    rerenderWith(makeSource([caught, caughtRetry], { fresh: new Set([caught.id]) }))
    const region = document.querySelector('[aria-live="polite"]')
    expect(region).toHaveTextContent(
      `Caught billed-but-empty on baseten for zai/glm-5.3-flash. Recovered on ${caughtRetry.provider}.`,
    )
  })

  test('rows hold still while the pointer is over them; new calls wait behind a button', () => {
    const base = [healthy(1), healthy(2)]
    const { rerenderWith } = renderStudio(makeSource(base))
    const scroller = document.querySelector('.feed-scroll') as HTMLElement

    fireEvent.pointerEnter(scroller)
    rerenderWith(makeSource([...base, healthy(0, { ts: '2026-09-28T11:00:00.000Z' })]))
    expect(rows()).toHaveLength(2)
    const show = screen.getByRole('button', { name: 'Show 1 New Call' })

    fireEvent.click(show)
    expect(rows()).toHaveLength(3)
    fireEvent.pointerLeave(scroller)
    expect(screen.queryByRole('button', { name: /New Call/ })).not.toBeInTheDocument()
  })

  test('rows also hold while the page is scrolled down, since touch screens have no hover', () => {
    const base = [healthy(1), healthy(2)]
    const { rerenderWith } = renderStudio(makeSource(base))
    const scrollTo = (y: number) => {
      Object.defineProperty(window, 'scrollY', { value: y, configurable: true })
      fireEvent.scroll(window)
    }
    try {
      scrollTo(600)
      rerenderWith(makeSource([...base, healthy(0, { ts: '2026-09-28T11:00:00.000Z' })]))
      expect(rows()).toHaveLength(2)
      expect(screen.getByRole('button', { name: 'Show 1 New Call' })).toBeInTheDocument()

      scrollTo(0)
      expect(rows()).toHaveLength(3)
    } finally {
      scrollTo(0)
    }
  })

  test(`virtualizes above ${VIRTUALIZE_ABOVE} rows`, () => {
    const many = Array.from({ length: 1500 }, (_, i) => healthy(i))
    renderStudio(makeSource(many))
    expect(screen.getByText('1,500 calls · 0 caught · 0 recovered')).toBeInTheDocument()
    expect(rows().length).toBeLessThan(100)
    const spacer = document.querySelector('.spacer-row') as HTMLElement
    expect(spacer.style.height).toBe(`${(1500 - rows().length) * ROW_HEIGHT}px`)
  })

  test('keyboard focus reaches rows that were not rendered yet in a virtualized list', async () => {
    const user = userEvent.setup()
    const many = Array.from({ length: 1500 }, (_, i) => healthy(i))
    renderStudio(makeSource(many))
    await user.click(rows()[0] as HTMLElement)
    await user.keyboard('{Escape}')
    // Focus is back on the row immediately after Esc (no frame delay), so End is not lost.
    expect(rows()[0]).toHaveFocus()
    await user.keyboard('{End}')
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('data-call-id')).toBe(many.at(-1)?.id),
    )
  })

  test('loading, empty, filtered-out, and error states', async () => {
    const { rerenderWith } = renderStudio(makeSource([], { status: 'loading' }))
    expect(screen.getByLabelText('Loading calls')).toHaveAttribute('aria-busy', 'true')

    rerenderWith(makeSource([]))
    expect(screen.getByRole('heading', { name: 'No Calls Recorded Yet' })).toBeInTheDocument()
    expect(screen.getByText(/Calls appear here as they happen\./)).toBeInTheDocument()

    const reload = makeSource([]).reload
    rerenderWith(
      makeSource([], {
        status: 'error',
        reload,
        error: {
          message:
            'Could not read .provider-guard/calls.jsonl (EACCES). Check that it is a readable file.',
          path: '.provider-guard/calls.jsonl',
        },
      }),
    )
    expect(
      screen.getByRole('heading', { name: 'Could Not Read the Records File' }),
    ).toBeInTheDocument()
    expect(screen.getByText('.provider-guard/calls.jsonl')).toBeInTheDocument()
    await act(async () => screen.getByRole('button', { name: 'Try Again' }).click())
    expect(reload).toHaveBeenCalledOnce()
  })

  test('a time range with no calls offers to show all of them', async () => {
    const user = userEvent.setup()
    const { onRangeChange } = renderStudio(makeSource(allRecords), '15m')
    expect(screen.getByRole('heading', { name: 'No Calls in This Time Range' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show All Calls' }))
    expect(onRangeChange).toHaveBeenCalledWith('all')
  })
})

describe('top bar', () => {
  test('shows the data source, time range, theme switcher, and the two tabs', async () => {
    const user = userEvent.setup()
    renderStudio(makeSource(allRecords))
    expect(screen.getByText('Live · .provider-guard/calls.jsonl')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Time range' })).toHaveValue('all')

    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['Feed', 'Providers'])
    tabs[0]?.focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Providers' })).toHaveAttribute('aria-selected', 'true')
    expect(window.location.search).toBe('?tab=providers')
  })

  test('the theme switcher applies and remembers the theme', async () => {
    const user = userEvent.setup()
    renderStudio(makeSource([]))
    await user.click(screen.getByRole('radio', { name: 'dark' }))
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(localStorage.getItem('provider-guard-theme')).toBe('dark')
    await user.click(screen.getByRole('radio', { name: 'light' }))
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  test('replay mode shows the banner, speed, and restart', async () => {
    const user = userEvent.setup()
    const setSpeed = vi.fn()
    const restart = vi.fn()
    renderStudio(
      makeSource(allRecords, {
        mode: 'replay',
        label: 'Replay · vercel/ai#20932, #21207',
        replay: {
          datasets: ['vercel-ai-20932', 'vercel-ai-21207'],
          speed: 1,
          setSpeed,
          restart,
          finished: false,
        },
      }),
    )
    expect(screen.getByRole('note')).toHaveTextContent(
      'Replay reconstructed from data published in vercel/ai#20932 and #21207. No live traffic.',
    )
    expect(screen.getByText('Replay · vercel/ai#20932, #21207')).toBeInTheDocument()
    await user.click(screen.getByRole('radio', { name: '4x' }))
    expect(setSpeed).toHaveBeenCalledWith(4)
    await user.click(screen.getByRole('button', { name: 'Restart Replay' }))
    expect(restart).toHaveBeenCalledOnce()
  })

  test('on phones the controls open from Options, and Restart Replay closes it', async () => {
    const user = userEvent.setup()
    const setSpeed = vi.fn()
    const restart = vi.fn()
    renderStudio(
      makeSource([caught, caughtRetry], {
        mode: 'replay',
        label: 'Replay · vercel/ai#20932, #21207',
        replay: {
          datasets: ['vercel-ai-20932', 'vercel-ai-21207'],
          speed: 1,
          setSpeed,
          restart,
          finished: false,
        },
      }),
    )
    await user.click(screen.getByRole('button', { name: 'Open Options' }))
    const options = screen.getByRole('dialog', { name: 'Options' })
    expect(within(options).getByRole('button', { name: 'Close' })).toHaveFocus()
    expect(within(options).getByRole('combobox', { name: 'Time range' })).toBeInTheDocument()
    expect(within(options).getByRole('group', { name: 'Select a display theme:' })).toBeVisible()
    await user.click(within(options).getByRole('radio', { name: '4x' }))
    expect(setSpeed).toHaveBeenCalledWith(4)

    await user.click(within(options).getByRole('button', { name: 'Restart Replay' }))
    expect(restart).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog', { name: 'Options' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open Options' })).toHaveFocus()
  })

  test('How It Works opens from Options, and Options has no replay controls in live mode', async () => {
    const user = userEvent.setup()
    const replayMode = makeSource([caught, caughtRetry], {
      mode: 'replay',
      label: 'Replay · vercel/ai#20932, #21207',
      replay: {
        datasets: ['vercel-ai-20932'],
        speed: 1,
        setSpeed: vi.fn(),
        restart: vi.fn(),
        finished: false,
      },
    })
    const { unmount } = renderStudio(replayMode)
    await user.click(screen.getByRole('button', { name: 'Open Options' }))
    const options = screen.getByRole('dialog', { name: 'Options' })
    await user.click(within(options).getByRole('button', { name: 'How It Works' }))
    expect(screen.queryByRole('dialog', { name: 'Options' })).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'How It Works' })).toBeInTheDocument()
    unmount()

    renderStudio(makeSource([caught, caughtRetry]))
    await user.click(screen.getByRole('button', { name: 'Open Options' }))
    const live = screen.getByRole('dialog', { name: 'Options' })
    expect(within(live).queryByRole('button', { name: 'Restart Replay' })).not.toBeInTheDocument()
    expect(within(live).queryByRole('button', { name: 'How It Works' })).not.toBeInTheDocument()
    expect(within(live).getByRole('combobox', { name: 'Time range' })).toBeInTheDocument()
  })

  test('a caught result keeps its full words for screen readers, with a short form for phones', () => {
    renderStudio(makeSource([caught, caughtRetry]))
    const result = rows()[0]?.querySelector('.result') as HTMLElement
    expect(within(result).getByText(/^Caught → recovered on /)).toBeInTheDocument()
    const short = within(result).getByText(/^Recovered on /)
    expect(short).toHaveAttribute('aria-hidden', 'true')
  })

  test('the footer says it is not affiliated with Vercel', () => {
    renderStudio(makeSource([]))
    expect(screen.getByText('Not affiliated with Vercel.')).toBeInTheDocument()
  })
})
