import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Call, Source } from './data'
import {
  announce,
  callDuration,
  formatMs,
  num,
  relativeTime,
  resultText,
  retryProvider,
  skipText,
} from './format'
import {
  Button,
  EmptyState,
  IconCheck,
  IconFlag,
  IconInfo,
  IconList,
  IconWarning,
  IconX,
  Skeleton,
  Tooltip,
  useReducedMotion,
} from './ui'

export const ROW_HEIGHT = 44
export const VIRTUALIZE_ABOVE = 1000
const OVERSCAN = 12
const HEADER_HEIGHT = 40

export function ProviderChip({
  provider,
  flagged = false,
  className = '',
}: {
  provider: string | null
  flagged?: boolean
  className?: string
}) {
  return (
    <span className={`chip${flagged ? ' chip-flagged' : ''} ${className}`}>
      {flagged && <IconFlag size={12} className="chip-flag" />}
      <span className="text-label-12-mono">{provider ?? '—'}</span>
    </span>
  )
}

/** Served provider (flagged when caught) and, when a retry ran, a line to the retry provider. */
export function ProviderPath({ call }: { call: Call }) {
  const caught = call.first.flags.length > 0
  const to = retryProvider(call)
  const retried = caught && to !== null && call.first.retry?.attempted === true
  return (
    <span className="provider-path">
      <ProviderChip provider={call.first.provider} flagged={caught} className="chip-served" />
      {retried && (
        <>
          <svg className="catch-line" width="28" height="10" viewBox="0 0 28 10" aria-hidden="true">
            <path d="M1 5h24" pathLength={1} />
            <path d="m21.5 1.5 3.5 3.5-3.5 3.5" />
          </svg>
          <ProviderChip provider={to} className="chip-retry" />
        </>
      )}
    </span>
  )
}

const TONE: Record<Call['result'], string> = {
  delivered: 'result-quiet',
  recovered: 'result-recovered',
  'still-empty': 'result-error',
  failed: 'result-error',
  'no-other-provider': 'result-warning',
  'not-retried': 'result-muted',
}

export function ResultLabel({ call }: { call: Call }) {
  const text = resultText(call)
  if (call.result === 'delivered') {
    return (
      <span className="result result-quiet">
        <IconCheck />
        {text}
      </span>
    )
  }
  if (call.result === 'recovered') {
    return (
      <span className="result result-recovered">
        <IconCheck className="result-check" />
        {text}
      </span>
    )
  }
  const reason = skipText(call.first)
  const icon =
    call.result === 'failed' ? (
      <IconX />
    ) : call.result === 'no-other-provider' ? (
      <IconWarning />
    ) : (
      <IconFlag />
    )
  return (
    <span className={`result ${TONE[call.result]}`}>
      {icon}
      {text}
      {reason && call.result === 'not-retried' && (
        <Tooltip text={reason}>
          <button type="button" className="info-button" aria-label="Why it was not retried">
            <IconInfo size={14} />
          </button>
        </Tooltip>
      )}
    </span>
  )
}

function FeedSkeleton() {
  return (
    <div className="feed-loading" aria-busy="true" aria-label="Loading calls">
      {Array.from({ length: 8 }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
        <div key={i} className="feed-skeleton-row">
          <Skeleton width={56} />
          <Skeleton width={140} />
          <Skeleton width={120} height={20} />
          <Skeleton width={180} />
          <Skeleton width={48} />
        </div>
      ))}
    </div>
  )
}

export function Feed({
  calls,
  source,
  now,
  hasEarlierCalls,
  onOpen,
  onShowAll,
}: {
  calls: Call[]
  source: Pick<Source, 'status' | 'error' | 'fresh' | 'reload'>
  now: number
  /** True when calls exist outside the selected time range. */
  hasEarlierCalls: boolean
  onOpen: (call: Call) => void
  onShowAll: () => void
}) {
  const reducedMotion = useReducedMotion()
  const scrollRef = useRef<HTMLDivElement>(null)
  const rows = useRef(new Map<string, HTMLTableRowElement>())
  const [activeId, setActiveId] = useState<string | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(800)
  const pendingFocus = useRef<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const announced = useRef(new Set<string>())
  // While the pointer is over the list or a row has focus, hold the rows in place so nothing
  // moves under the user; new calls wait behind a "Show N New Calls" button.
  const [held, setHeld] = useState<Call[] | null>(null)
  const pointerInside = useRef(false)
  const focusInside = useRef(false)
  const release = () => {
    if (!pointerInside.current && !focusInside.current) setHeld(null)
  }

  // Announce each incident once, when it arrives.
  useEffect(() => {
    for (const call of calls) {
      if (source.fresh.has(call.id) && !announced.current.has(call.id)) {
        announced.current.add(call.id)
        setAnnouncement(announce(call))
      }
    }
  }, [calls, source.fresh])

  const showTable = calls.length > 0 && source.status !== 'error'
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!showTable || !el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setViewport(el.clientHeight))
    observer.observe(el)
    return () => observer.disconnect()
  }, [showTable])

  useEffect(() => {
    const id = pendingFocus.current
    if (id === null) return
    const row = rows.current.get(id)
    if (row) {
      row.focus()
      pendingFocus.current = null
    }
  })

  if (source.status === 'loading' && calls.length === 0) return <FeedSkeleton />
  if (source.status === 'error' && source.error) {
    return (
      <EmptyState
        tone="error"
        icon={<IconWarning />}
        title={source.error.path ? 'Could Not Read the Records File' : 'Studio Is Not Reachable'}
        action={<Button onClick={source.reload}>Try Again</Button>}
      >
        <p>{source.error.message}</p>
        {source.error.path && <code className="text-label-13-mono">{source.error.path}</code>}
      </EmptyState>
    )
  }
  if (calls.length === 0) {
    return hasEarlierCalls ? (
      <EmptyState
        icon={<IconList />}
        title="No Calls in This Time Range"
        action={<Button onClick={onShowAll}>Show All Calls</Button>}
      >
        <p>Choose a longer time range to see earlier calls.</p>
      </EmptyState>
    ) : (
      <EmptyState icon={<IconList />} title="No Calls Recorded Yet">
        <p>
          Wrap your model with <code>guard()</code> and make a request. Calls appear here as they
          happen.
        </p>
      </EmptyState>
    )
  }

  const shown = held ?? calls
  const heldIds = held ? new Set(held.map((c) => c.id)) : null
  const waiting = heldIds ? calls.filter((c) => !heldIds.has(c.id)).length : 0
  const virtual = shown.length > VIRTUALIZE_ABOVE
  const first = virtual ? Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN) : 0
  const last = virtual
    ? Math.min(shown.length, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + OVERSCAN)
    : shown.length
  const activeIndex = Math.max(
    0,
    shown.findIndex((c) => c.id === activeId),
  )
  const caught = shown.filter((c) => c.result !== 'delivered').length
  const recovered = shown.filter((c) => c.result === 'recovered').length

  function focusRow(index: number) {
    const clamped = Math.min(shown.length - 1, Math.max(0, index))
    const call = shown[clamped] as Call
    setActiveId(call.id)
    pendingFocus.current = call.id
    const el = scrollRef.current
    if (virtual && el) {
      // The row may not be rendered yet: scroll it into the window first.
      const top = clamped * ROW_HEIGHT
      let next = el.scrollTop
      if (top < next) next = top
      else if (top + ROW_HEIGHT > next + el.clientHeight - HEADER_HEIGHT) {
        next = top + ROW_HEIGHT - el.clientHeight + HEADER_HEIGHT
      }
      el.scrollTop = next
      setScrollTop(next) // the computed value, not a read-back: layout may not have run yet
    }
  }

  function onKeyDown(e: KeyboardEvent, index: number, call: Call) {
    const page = Math.max(1, Math.floor(viewport / ROW_HEIGHT) - 1)
    const moves: Record<string, number> = {
      ArrowDown: index + 1,
      ArrowUp: index - 1,
      Home: 0,
      End: shown.length - 1,
      PageDown: index + page,
      PageUp: index - page,
    }
    const target = moves[e.key]
    if (target !== undefined) {
      e.preventDefault()
      focusRow(target)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      setActiveId(call.id)
      onOpen(call)
    }
  }

  return (
    <section className="feed" aria-label="Calls">
      <div className="feed-summary">
        <p className="text-label-13">
          {shown.length.toLocaleString('en-US')} calls · {caught.toLocaleString('en-US')} caught ·{' '}
          {recovered.toLocaleString('en-US')} recovered
        </p>
        {waiting > 0 && (
          <Button size="tiny" onClick={() => setHeld(calls)}>
            Show {waiting.toLocaleString('en-US')} New {waiting === 1 ? 'Call' : 'Calls'}
          </Button>
        )}
      </div>
      <div className="sr-only" aria-live="polite">
        {announcement}
      </div>
      <div
        ref={scrollRef}
        className="feed-scroll"
        onScroll={virtual ? (e) => setScrollTop(e.currentTarget.scrollTop) : undefined}
        onPointerEnter={() => {
          pointerInside.current = true
          setHeld((h) => h ?? calls)
        }}
        onPointerLeave={() => {
          pointerInside.current = false
          release()
        }}
        onFocus={() => {
          focusInside.current = true
          setHeld((h) => h ?? calls)
        }}
        onBlur={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
          focusInside.current = false
          release()
        }}
      >
        <table className="table feed-table">
          <thead>
            <tr>
              <th scope="col" className="col-time">
                Time
              </th>
              <th scope="col" className="col-model">
                Model
              </th>
              <th scope="col" className="col-provider">
                Provider
              </th>
              <th scope="col" className="col-result">
                Result
              </th>
              <th scope="col" className="col-tokens" title="Text / reasoning tokens billed">
                Tokens
              </th>
              <th scope="col" className="col-duration">
                Duration
              </th>
            </tr>
          </thead>
          <tbody>
            {first > 0 && (
              <tr
                aria-hidden="true"
                style={{ height: first * ROW_HEIGHT }}
                className="spacer-row"
              />
            )}
            {shown.slice(first, last).map((call, offset) => {
              const index = first + offset
              const catching = source.fresh.has(call.id) && !reducedMotion
              const iso = new Date(call.ts).toISOString()
              return (
                <tr
                  key={call.id}
                  ref={(el) => {
                    if (el) rows.current.set(call.id, el)
                    else rows.current.delete(call.id)
                  }}
                  data-call-id={call.id}
                  tabIndex={index === activeIndex ? 0 : -1}
                  aria-haspopup="dialog"
                  className={`feed-row${catching ? ' catching' : ''}`}
                  onClick={() => {
                    setActiveId(call.id)
                    onOpen(call)
                  }}
                  onKeyDown={(e) => onKeyDown(e, index, call)}
                >
                  <td className="col-time text-label-13">
                    <time dateTime={iso} title={iso}>
                      {relativeTime(call.ts, now)}
                    </time>
                  </td>
                  <td className="col-model text-label-13-mono">{call.first.model}</td>
                  <td className="col-provider">
                    <ProviderPath call={call} />
                  </td>
                  <td className="col-result text-label-14">
                    <ResultLabel call={call} />
                  </td>
                  <td
                    className="col-tokens text-label-13-mono"
                    title={`${num(call.first.tokens.text)} text and ${num(call.first.tokens.reasoning)} reasoning tokens billed`}
                  >
                    {num(call.first.tokens.text)} / {num(call.first.tokens.reasoning)}
                  </td>
                  <td className="col-duration text-label-13-mono">
                    {formatMs(callDuration(call))}
                  </td>
                </tr>
              )
            })}
            {last < shown.length && (
              <tr
                aria-hidden="true"
                style={{ height: (shown.length - last) * ROW_HEIGHT }}
                className="spacer-row"
              />
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}
