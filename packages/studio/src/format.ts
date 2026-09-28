import type { CallRecord, SkipReason } from '@core/records'
import type { Call } from './data'

/** Geist relative time: "12s ago", "5m ago", "3h ago"; past 7 days, "Mar 14, 2026". */
export function relativeTime(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(ts).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export const formatMs = (ms: number) =>
  ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`

/** Geist tables render unknown values as an em dash. */
export const num = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : Math.round(n).toLocaleString('en-US')

/** Wall time from the first attempt's start to the end of the last attempt. */
export function callDuration(call: Call): number {
  if (!call.second) return call.first.durationMs
  return Date.parse(call.second.ts) - call.ts + call.second.durationMs
}

export const retryProvider = (call: Call) =>
  call.first.retry?.provider ?? call.second?.provider ?? null

const SKIP_TEXT: Record<SkipReason, string> = {
  'no-alternative-provider': 'No other provider serves this model',
  'provider-list-unavailable': "Not retried: the model's provider list could not be loaded",
  'unknown-provider': 'Not retried: the gateway did not report which provider served the call',
  'not-gateway': 'Not retried: the model is not served through AI Gateway',
  'tool-call-emitted': 'Not retried: a tool call was already emitted',
  aborted: 'Not retried: the request was aborted',
  'retry-disabled': 'Not retried: retry.max is 0',
  'report-only': 'Reported only: the detector did not ask for a retry',
}

export const skipText = (record: CallRecord) =>
  record.retry?.skipReason ? SKIP_TEXT[record.retry.skipReason] : undefined

/** The words for each result, the same on every surface: caught, retried, recovered. */
export function resultText(call: Call): string {
  switch (call.result) {
    case 'delivered':
      return 'Delivered'
    case 'recovered':
      return `Caught → recovered on ${retryProvider(call) ?? 'another provider'}`
    case 'still-empty':
      return 'Caught · retry still empty'
    case 'failed':
      return 'Caught · retry failed'
    case 'no-other-provider':
      return 'Caught · no other provider'
    case 'not-retried':
      return 'Caught · not retried'
  }
}

/** What the aria-live region says when an incident arrives. */
export function announce(call: Call): string {
  const caught = `Caught ${call.first.flags.join(', ')} on ${call.first.provider ?? 'an unknown provider'} for ${call.first.model}.`
  const outcome: Record<Call['result'], string> = {
    delivered: '',
    recovered: `Recovered on ${retryProvider(call) ?? 'another provider'}.`,
    'still-empty': 'The retry was also empty.',
    failed: 'The retry failed.',
    'no-other-provider': 'No other provider serves this model.',
    'not-retried': `${skipText(call.first) ?? 'Not retried'}.`,
  }
  return `${caught} ${outcome[call.result]}`.trim()
}
