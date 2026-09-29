import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { allRecords, caught, caughtRetry, makeSource, renderStudio } from './helpers'
import { media } from './setup'

// One caught call and its retry: all the intro needs, and quick to query.
const replaySource = () =>
  makeSource([caught, caughtRetry], {
    mode: 'replay',
    label: 'Replay · vercel/ai#20932, #21207',
    replay: {
      datasets: ['vercel-ai-20932', 'vercel-ai-21207'],
      speed: 1,
      setSpeed: vi.fn(),
      restart: vi.fn(),
      finished: false,
    },
  })

const intro = () => screen.queryByRole('dialog', { name: 'How It Works' })
const rows = () => screen.getAllByRole('row').filter((r) => r.hasAttribute('data-call-id'))

const STEPS = [
  'One Model, Many Providers',
  'Errors Fall Back',
  "Empty Successes Don't",
  'provider-guard Catches Them',
  'Reading This Screen',
]

describe('How it works', () => {
  test('opens on a first visit to the public demo, and not again once closed', async () => {
    const user = userEvent.setup()
    const first = renderStudio(replaySource(), 'all', { autoIntro: true })
    const dialog = screen.getByRole('dialog', { name: 'How It Works' })
    expect(within(dialog).getByRole('heading', { name: STEPS[0] })).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(intro()).not.toBeInTheDocument()
    // Focus lands on the button that reopens it, so it is easy to find again.
    expect(screen.getByRole('button', { name: 'How It Works' })).toHaveFocus()
    first.unmount()

    renderStudio(replaySource(), 'all', { autoIntro: true })
    expect(intro()).not.toBeInTheDocument()
  })

  test('walks through five steps, from the gap in fallback to reading the screen', async () => {
    const user = userEvent.setup()
    renderStudio(replaySource())
    expect(intro()).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'How It Works' }))
    const dialog = screen.getByRole('dialog', { name: 'How It Works' })
    expect(within(dialog).getByRole('button', { name: 'Back' })).toBeDisabled()

    for (const [i, title] of STEPS.entries()) {
      expect(within(dialog).getByRole('heading', { name: title })).toBeInTheDocument()
      expect(within(dialog).getByText(`${i + 1} of ${STEPS.length}`)).toBeInTheDocument()
      if (i < STEPS.length - 1) {
        await user.click(within(dialog).getByRole('button', { name: 'Next' }))
      }
    }
    // The last step explains a real caught call from the replay, drawn as the Feed draws it.
    expect(within(dialog).getByText(/Caught → recovered on/)).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Back' }))
    expect(within(dialog).getByRole('heading', { name: STEPS[3] })).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Next' }))
    await user.click(within(dialog).getByRole('button', { name: 'Done' }))
    expect(intro()).not.toBeInTheDocument()
    expect(localStorage.getItem('provider-guard-intro-seen')).toBe('1')
  })

  test('links the issue behind each gap', async () => {
    const user = userEvent.setup()
    renderStudio(replaySource())
    await user.click(screen.getByRole('button', { name: 'How It Works' }))
    const dialog = screen.getByRole('dialog', { name: 'How It Works' })
    const next = () => user.click(within(dialog).getByRole('button', { name: 'Next' }))
    await next()
    await next()
    expect(within(dialog).getByRole('link', { name: 'vercel/ai#20932' })).toHaveAttribute(
      'href',
      'https://github.com/vercel/ai/issues/20932',
    )
    await next()
    expect(within(dialog).getByRole('link', { name: 'vercel/ai#20934' })).toHaveAttribute(
      'href',
      'https://github.com/vercel/ai/issues/20934',
    )
    expect(within(dialog).getByRole('link', { name: 'vercel/ai#21207' })).toHaveAttribute(
      'href',
      'https://github.com/vercel/ai/issues/21207',
    )
  })

  test('each diagram plays to its final frame, and can play again', async () => {
    // shouldAdvanceTime: Testing Library awaits a real setTimeout(0), which Vitest fakes would stall.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      renderStudio(replaySource())
      await user.click(screen.getByRole('button', { name: 'How It Works' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      await user.click(screen.getByRole('button', { name: 'Next' }))
      // Play Again redraws the diagram from its first frame, so query it fresh each time.
      const diagram = () => screen.getByRole('img', { name: /passes the empty answer to your app/ })
      expect(within(diagram()).queryByText('empty answer')).not.toBeInTheDocument()
      act(() => vi.advanceTimersByTime(10_000))
      expect(within(diagram()).getByText('empty answer')).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: 'Play Again' }))
      expect(within(diagram()).queryByText('empty answer')).not.toBeInTheDocument()
      act(() => vi.advanceTimersByTime(10_000))
      expect(within(diagram()).getByText('empty answer')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  test('with reduced motion, each diagram shows its final frame at once', async () => {
    media.reducedMotion = true
    const user = userEvent.setup()
    renderStudio(replaySource())
    await user.click(screen.getByRole('button', { name: 'How It Works' }))
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText('empty answer')).toBeInTheDocument()
  })

  test('opening a call closes it, so one panel shows at a time', async () => {
    const user = userEvent.setup()
    renderStudio(replaySource())
    await user.click(screen.getByRole('button', { name: 'How It Works' }))
    await user.click(rows()[0] as HTMLElement)
    expect(intro()).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Call Anatomy' })).toBeInTheDocument()
  })

  test('live mode has no How It Works, since it shows your own calls', () => {
    renderStudio(makeSource(allRecords), 'all', { autoIntro: true })
    expect(screen.queryByRole('button', { name: 'How It Works' })).not.toBeInTheDocument()
    expect(intro()).not.toBeInTheDocument()
  })
})
