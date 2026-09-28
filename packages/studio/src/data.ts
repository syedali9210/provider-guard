import type { CallRecord } from '@core/records'
import { isCallRecord } from '@core/report'
import { useCallback, useEffect, useRef, useState } from 'react'
import url20932 from '../replay/vercel-ai-20932.json?url'
import url21207 from '../replay/vercel-ai-21207.json?url'

/** The catch animation length (PRD §6.4). */
export const CATCH_MS = 450

export type Result =
  | 'delivered'
  | 'recovered'
  | 'still-empty'
  | 'failed'
  | 'no-other-provider'
  | 'not-retried'

/** One row of the Feed: the attempt a user's call started with, plus its retry if there was one. */
export type Call = {
  id: string
  first: CallRecord
  second: CallRecord | null
  ts: number
  result: Result
}

export function resultOf(first: CallRecord): Result {
  if (first.flags.length === 0) return 'delivered'
  const retry = first.retry
  if (!retry) return 'not-retried'
  if (retry.outcome === 'recovered') return 'recovered'
  if (retry.outcome === 'still-empty') return 'still-empty'
  if (retry.outcome === 'failed') return 'failed'
  return retry.skipReason === 'no-alternative-provider' ? 'no-other-provider' : 'not-retried'
}

/** Groups attempts into calls, newest first. A retry whose original is missing stands alone. */
export function toCalls(records: CallRecord[]): Call[] {
  const ids = new Set(records.map((r) => r.id))
  const retries = new Map<string, CallRecord>()
  for (const r of records) if (r.retryOf && ids.has(r.retryOf)) retries.set(r.retryOf, r)
  const calls: Call[] = []
  for (const r of records) {
    if (r.retryOf && ids.has(r.retryOf)) continue
    calls.push({
      id: r.id,
      first: r,
      second: retries.get(r.id) ?? null,
      ts: Date.parse(r.ts),
      result: resultOf(r),
    })
  }
  return calls.sort((a, b) => b.ts - a.ts)
}

export const RANGES = { '15m': 15 * 60_000, '1h': 3_600_000, '24h': 86_400_000, all: Infinity }
export type Range = keyof typeof RANGES

export type Speed = 1 | 4

export type Source = {
  mode: 'live' | 'replay'
  /** Data-source badge text. */
  label: string
  status: 'loading' | 'ready' | 'error'
  error: { message: string; path?: string } | null
  records: CallRecord[]
  /** Caught attempts that arrived while the screen was open and are still animating. */
  fresh: ReadonlySet<string>
  reload: () => void
  replay: {
    datasets: string[]
    speed: Speed
    setSpeed: (speed: Speed) => void
    restart: () => void
    finished: boolean
  } | null
}

type Config = { mode: 'live'; file: string } | { mode: 'replay'; dataset: string }

const replayBuild = import.meta.env.VITE_MODE === 'replay' || import.meta.env.MODE === 'replay'

export function useSource(range: Range): Source {
  const [config, setConfig] = useState<Config | null>(
    replayBuild ? { mode: 'replay', dataset: 'all' } : null,
  )
  const [configError, setConfigError] = useState<string | null>(null)

  useEffect(() => {
    if (config) return
    fetch('/api/config')
      .then((res) => res.json())
      .then((c: { mode: string; file: string | null; dataset: string | null }) =>
        setConfig(
          c.mode === 'replay'
            ? { mode: 'replay', dataset: c.dataset ?? 'all' }
            : { mode: 'live', file: c.file ?? '' },
        ),
      )
      .catch(() =>
        setConfigError(
          'Could not reach the Studio server. Check that provider-guard studio is still running, then reload.',
        ),
      )
  }, [config])

  const live = useLive(config?.mode === 'live' ? config.file : null, range)
  const replay = useReplay(config?.mode === 'replay' ? config.dataset : null)
  if (configError) return { ...live, status: 'error', error: { message: configError } }
  return config?.mode === 'replay' ? replay : live
}

function useFresh() {
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set())
  const add = useCallback((id: string) => {
    setFresh((prev) => new Set(prev).add(id))
    setTimeout(() => {
      setFresh((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }, CATCH_MS + 100)
  }, [])
  const clear = useCallback(() => setFresh(new Set()), [])
  return { fresh, add, clear }
}

const isCaught = (r: CallRecord) => r.flags.length > 0 && r.retryOf === null

function useLive(file: string | null, range: Range): Source {
  const [records, setRecords] = useState<CallRecord[]>([])
  const [status, setStatus] = useState<Source['status']>('loading')
  const [error, setError] = useState<Source['error']>(null)
  const [attempt, setAttempt] = useState(0)
  const { fresh, add } = useFresh()
  const known = useRef(new Set<string>())

  // Subscribe first, then load: anything appended in between arrives on both and is dropped by id.
  useEffect(() => {
    if (file === null || typeof EventSource === 'undefined') return
    const events = new EventSource('/api/stream')
    events.addEventListener('record', (event) => {
      let record: unknown
      try {
        record = JSON.parse((event as MessageEvent<string>).data)
      } catch {
        return
      }
      if (!isCallRecord(record) || known.current.has(record.id)) return
      known.current.add(record.id)
      setRecords((prev) => [...prev, record])
      if (isCaught(record)) add(record.id)
    })
    return () => events.close()
  }, [file, add])

  useEffect(() => {
    if (file === null) return
    let cancelled = false
    setStatus('loading')
    const since =
      RANGES[range] === Infinity
        ? ''
        : `?since=${encodeURIComponent(new Date(Date.now() - RANGES[range]).toISOString())}`
    fetch(`/api/records${since}`)
      .then(async (res) => {
        const body: unknown = await res.json()
        if (cancelled) return
        if (!res.ok) {
          const e = (body as { error?: { message?: string; path?: string } }).error
          setError({
            message: e?.message ?? `The Studio server returned ${res.status}.`,
            path: e?.path,
          })
          setStatus('error')
          return
        }
        const loaded = Array.isArray(body) ? body.filter(isCallRecord) : []
        setRecords((prev) => {
          const byId = new Map(loaded.map((r) => [r.id, r]))
          for (const r of prev) byId.set(r.id, r)
          known.current = new Set(byId.keys())
          return [...byId.values()]
        })
        setError(null)
        setStatus('ready')
      })
      .catch(() => {
        if (cancelled) return
        setError({
          message:
            'Could not reach the Studio server. Check that provider-guard studio is still running, then try again.',
        })
        setStatus('error')
      })
    return () => {
      cancelled = true
    }
  }, [file, range, attempt])

  return {
    mode: 'live',
    label: `Live · ${file ?? ''}`,
    status: file === null ? 'loading' : status,
    error,
    records,
    fresh,
    reload: () => setAttempt((n) => n + 1),
    replay: null,
  }
}

// ---------------------------------------------------------------------------------------------
// Replay

const DATASETS: Record<string, { url: string; issue: string }> = {
  'vercel-ai-20932': { url: url20932, issue: '20932' },
  'vercel-ai-21207': { url: url21207, issue: '21207' },
}
const HISTORY_SPACING_MS = 15_000
const LIVE_INTERVAL_MS = 800

export const datasetsFor = (dataset: string) =>
  dataset === 'all' ? Object.keys(DATASETS) : Object.keys(DATASETS).filter((d) => d === dataset)

export function replayLabel(datasets: string[]): string {
  const issues = datasets.map((d) => DATASETS[d]?.issue).filter(Boolean)
  return `Replay · vercel/ai#${issues.join(', #')}`
}

/** A call's records: a caught attempt followed by its retry, or a single attempt. */
type Group = CallRecord[]

function groupsOf(records: CallRecord[]): Group[] {
  const retries = new Map(records.filter((r) => r.retryOf).map((r) => [r.retryOf as string, r]))
  return records
    .filter((r) => !r.retryOf)
    .map((r) => {
      const retry = retries.get(r.id)
      return retry ? [r, retry] : [r]
    })
}

/**
 * Splits replay data into history (shown at once) and live calls (played over time). Reasoning
 * runs (#21207) are all history, so the reasoning panel is there immediately. The live part starts
 * two calls before a catch, so the first catch plays within seconds of opening.
 */
export function planReplay(datasets: Record<string, CallRecord[]>): {
  history: Group[]
  live: Group[]
} {
  // Each history group gets a position in [0, 1) within its dataset, so datasets interleave.
  const history: Array<{ group: Group; position: number }> = []
  const live: Group[] = []
  const place = (groups: Group[]) =>
    groups.forEach((group, i) => history.push({ group, position: (i + 0.5) / groups.length }))
  for (const [id, records] of Object.entries(datasets)) {
    const groups = groupsOf(records)
    if (id !== 'vercel-ai-20932') {
      place(groups)
      continue
    }
    let cut = Math.floor(groups.length * 0.55)
    const nextCatch = groups.findIndex((g, i) => i >= cut && isCaught(g[0] as CallRecord))
    if (nextCatch !== -1) cut = Math.max(0, nextCatch - 2)
    place(groups.slice(0, cut))
    live.push(...groups.slice(cut))
  }
  history.sort((a, b) => a.position - b.position)
  return { history: history.map((h) => h.group), live }
}

/** Moves a group to `at`, keeping the gap between an attempt and its retry. */
function rebase(group: Group, at: number): CallRecord[] {
  const start = Date.parse((group[0] as CallRecord).ts)
  return group.map((r) => ({ ...r, ts: new Date(at + (Date.parse(r.ts) - start)).toISOString() }))
}

function useReplay(dataset: string | null): Source {
  const [plan, setPlan] = useState<{ history: Group[]; live: Group[] } | null>(null)
  const [error, setError] = useState<Source['error']>(null)
  const [records, setRecords] = useState<CallRecord[]>([])
  const [played, setPlayed] = useState(0)
  const [speed, setSpeed] = useState<Speed>(1)
  const [run, setRun] = useState(0)
  const { fresh, add, clear } = useFresh()
  const datasets = dataset === null ? [] : datasetsFor(dataset)

  useEffect(() => {
    if (dataset === null) return
    let cancelled = false
    Promise.all(
      datasetsFor(dataset).map(async (id) => {
        const res = await fetch((DATASETS[id] as { url: string }).url)
        const body = (await res.json()) as { records: unknown[] }
        return [id, body.records.filter(isCallRecord)] as const
      }),
    )
      .then((entries) => {
        if (!cancelled) setPlan(planReplay(Object.fromEntries(entries)))
      })
      .catch(() => {
        if (!cancelled)
          setError({ message: 'Could not load the replay data. Reload the page to try again.' })
      })
    return () => {
      cancelled = true
    }
  }, [dataset])

  // Start (or restart): lay history out over the last few minutes, then play the rest.
  useEffect(() => {
    if (!plan) return
    const now = Date.now()
    const n = plan.history.length
    setRecords(plan.history.flatMap((g, i) => rebase(g, now - (n - i) * HISTORY_SPACING_MS)))
    setPlayed(0)
    clear()
  }, [plan, run, clear])

  useEffect(() => {
    if (!plan || played >= plan.live.length) return
    const timer = setTimeout(() => {
      const group = rebase(plan.live[played] as Group, Date.now())
      setRecords((prev) => [...prev, ...group])
      if (isCaught(group[0] as CallRecord)) add((group[0] as CallRecord).id)
      setPlayed((p) => p + 1)
    }, LIVE_INTERVAL_MS / speed)
    return () => clearTimeout(timer)
  }, [plan, played, speed, add])

  return {
    mode: 'replay',
    label: replayLabel(datasets),
    status: error ? 'error' : plan ? 'ready' : 'loading',
    error,
    records,
    fresh,
    reload: () => setRun((n) => n + 1),
    replay: {
      datasets,
      speed,
      setSpeed,
      restart: () => setRun((n) => n + 1),
      finished: plan !== null && played >= plan.live.length,
    },
  }
}
