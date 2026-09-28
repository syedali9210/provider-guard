import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CallAnatomy } from './Anatomy'
import { type Call, RANGES, type Range, type Source, toCalls, useSource } from './data'
import { Feed } from './Feed'
import { Providers } from './Providers'
import {
  Badge,
  Button,
  EmptyState,
  IconInfo,
  IconList,
  IconRestart,
  IconWarning,
  Select,
  Sheet,
  Switch,
  Tabs,
  type ThemePreference,
  ThemeSwitcher,
  useNow,
} from './ui'

type Tab = 'feed' | 'providers'
const THEME_KEY = 'provider-guard-theme'

const RANGE_OPTIONS: Array<{ value: Range; label: string }> = [
  { value: '15m', label: 'Last 15 minutes' },
  { value: '1h', label: 'Last hour' },
  { value: '24h', label: 'Last 24 hours' },
  { value: 'all', label: 'All time' },
]

function readTheme(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_KEY)
    return stored === 'light' || stored === 'dark' ? stored : 'system'
  } catch {
    return 'system'
  }
}

export function useTheme(): [ThemePreference, (t: ThemePreference) => void] {
  const [preference, setPreference] = useState<ThemePreference>(readTheme)
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = preference === 'dark' || (preference === 'system' && media?.matches === true)
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    }
    apply()
    try {
      localStorage.setItem(THEME_KEY, preference)
    } catch {}
    if (preference !== 'system' || !media) return
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [preference])
  return [preference, setPreference]
}

/** Keeps the selected tab in the URL, so a refresh or shared link restores it. */
function useTab(): [Tab, (t: Tab) => void] {
  const [tab, setTab] = useState<Tab>(() =>
    new URLSearchParams(window.location.search).get('tab') === 'providers' ? 'providers' : 'feed',
  )
  const select = useCallback((next: Tab) => {
    setTab(next)
    const url = new URL(window.location.href)
    if (next === 'feed') url.searchParams.delete('tab')
    else url.searchParams.set('tab', next)
    window.history.replaceState(null, '', url)
  }, [])
  return [tab, select]
}

export function App() {
  const [range, setRange] = useState<Range>('all')
  const source = useSource(range)
  return <Studio source={source} range={range} onRangeChange={setRange} />
}

export function Studio({
  source,
  range,
  onRangeChange,
}: {
  source: Source
  range: Range
  onRangeChange: (range: Range) => void
}) {
  const [tab, setTab] = useTab()
  const [theme, setTheme] = useTheme()
  const [openId, setOpenId] = useState<string | null>(null)
  const [model, setModel] = useState<string | null>(null)
  const now = useNow(5_000)
  const lastTrigger = useRef<string | null>(null)

  const allCalls = useMemo(() => toCalls(source.records), [source.records])
  const calls = useMemo(
    () =>
      RANGES[range] === Infinity ? allCalls : allCalls.filter((c) => c.ts >= now - RANGES[range]),
    [allCalls, range, now],
  )
  const records = useMemo(
    () => calls.flatMap((c) => (c.second ? [c.first, c.second] : [c.first])),
    [calls],
  )
  const open = openId === null ? null : (allCalls.find((c) => c.id === openId) ?? null)

  const openCall = useCallback((call: Call) => {
    lastTrigger.current = call.id
    setOpenId(call.id)
  }, [])
  const closeCall = useCallback(() => {
    setOpenId(null)
    // Return focus to the row that opened the sheet, so keyboard users keep their place.
    const id = lastTrigger.current
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-call-id="${id}"]`)?.focus()
    })
  }, [])

  const replay = source.replay
  return (
    <div className="app">
      {replay && (
        <div className="banner text-label-13" role="note">
          <IconInfo size={14} />
          <span>
            Replay reconstructed from data published in{' '}
            {replay.datasets.map((d, i) => {
              const issue = d.replace('vercel-ai-', '')
              return (
                <span key={d}>
                  {i > 0 && (i === replay.datasets.length - 1 ? ' and ' : ', ')}
                  <a
                    href={`https://github.com/vercel/ai/issues/${issue}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {i === 0 ? `vercel/ai#${issue}` : `#${issue}`}
                  </a>
                </span>
              )
            })}
            . No live traffic.
          </span>
        </div>
      )}
      <header className="topbar">
        <div className="topbar-row">
          <span className="brand text-label-16">provider-guard</span>
          <Badge variant={source.mode === 'live' ? 'green' : 'blue'} title={source.label}>
            {source.label}
          </Badge>
          <div className="topbar-spacer" />
          {replay && (
            <div className="replay-controls">
              <Switch
                label="Replay speed"
                value={String(replay.speed) as '1' | '4'}
                options={[
                  { value: '1', label: '1x' },
                  { value: '4', label: '4x' },
                ]}
                onChange={(v) => replay.setSpeed(v === '4' ? 4 : 1)}
              />
              <Button prefix={<IconRestart />} onClick={replay.restart}>
                Restart Replay
              </Button>
            </div>
          )}
          <Select
            label="Time range"
            value={range}
            options={RANGE_OPTIONS}
            onChange={onRangeChange}
          />
          <ThemeSwitcher value={theme} onChange={setTheme} />
        </div>
        <Tabs
          label="Sections"
          tabs={[
            { value: 'feed', title: 'Feed' },
            { value: 'providers', title: 'Providers' },
          ]}
          selected={tab}
          onSelect={setTab}
        />
      </header>

      <main id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`} className="main">
        {tab === 'feed' ? (
          <Feed
            calls={calls}
            source={source}
            now={now}
            hasEarlierCalls={allCalls.length > calls.length}
            onOpen={openCall}
            onShowAll={() => onRangeChange('all')}
          />
        ) : source.status === 'error' && source.error ? (
          <EmptyState
            tone="error"
            icon={<IconWarning />}
            title="Could Not Load Calls"
            action={<Button onClick={source.reload}>Try Again</Button>}
          >
            <p>{source.error.message}</p>
          </EmptyState>
        ) : records.length === 0 ? (
          <EmptyState icon={<IconList />} title="No Provider Data Yet">
            <p>Provider health appears after the first recorded call.</p>
          </EmptyState>
        ) : (
          <Providers records={records} selected={model} onSelect={setModel} />
        )}
      </main>

      <footer className="footer text-label-12">Not affiliated with Vercel.</footer>

      {/* Keyed by call: each opened call starts at the top with focus on Close. */}
      <Sheet key={open?.id} open={open !== null} onClose={closeCall} labelledBy="anatomy-title">
        {open && <CallAnatomy call={open} now={now} onClose={closeCall} />}
      </Sheet>
    </div>
  )
}
