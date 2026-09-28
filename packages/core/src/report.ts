// Provider health per model. Pure functions: shared by the CLI and Studio.
import type { CallRecord } from './records'
import { fisherExactGreater, median } from './stats'
import type { ReasoningLevel } from './types'

export const EMPTY_FLAG = 'billed-but-empty'

/** PRD §5.4 outlier rule for the empty rate. */
export const OUTLIER_RULE = { minCalls: 10, minEmptyRate: 0.1, maxP: 0.01 } as const
/** PRD §5.4 reasoning rule: flat (< 25% change) while another provider moves at least 2x. */
export const EFFORT_RULE = { maxFlatChange: 0.25, minRatio: 2 } as const

const LEVELS: ReasoningLevel[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']

export type ProviderStats = {
  provider: string
  attempts: number
  empty: number
  emptyRate: number
  reasoned: number
  reasonedRate: number
  medianReasoningTokens: number | null
  /** One-sided Fisher exact p against every other provider of the model; null when it is alone. */
  p: number | null
  outlier: boolean
}

export type ReasoningRow = {
  provider: string
  runs: Partial<Record<ReasoningLevel, number[]>>
  medians: Partial<Record<ReasoningLevel, number>>
  effortIgnored: boolean
}

export type ReasoningPanel = { levels: ReasoningLevel[]; rows: ReasoningRow[] }

export type ModelReport = {
  model: string
  attempts: number
  caught: number
  providers: ProviderStats[]
  reasoning: ReasoningPanel | null
}

export const isEmptyAttempt = (r: CallRecord) => r.flags.includes(EMPTY_FLAG)
export const isReasoned = (r: CallRecord) =>
  r.delivered.reasoningChars > 0 || (r.tokens.reasoning ?? 0) > 0
export const providerOf = (r: CallRecord) => r.provider ?? 'unknown'

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    const group = groups.get(k)
    if (group) group.push(item)
    else groups.set(k, [item])
  }
  return groups
}

export function buildReport(records: CallRecord[]): ModelReport[] {
  const models = [...groupBy(records, (r) => r.model)].map(([model, calls]): ModelReport => {
    const totalEmpty = calls.filter(isEmptyAttempt).length
    const providers = [...groupBy(calls, providerOf)].map(([provider, rows]): ProviderStats => {
      const attempts = rows.length
      const empty = rows.filter(isEmptyAttempt).length
      const others = calls.length - attempts
      const othersEmpty = totalEmpty - empty
      // Rounded to 12 significant digits so float noise (0.99999999999998) never reaches output.
      const p =
        others > 0
          ? Number(
              fisherExactGreater(
                empty,
                attempts - empty,
                othersEmpty,
                others - othersEmpty,
              ).toPrecision(12),
            )
          : null
      const emptyRate = empty / attempts
      const reasoned = rows.filter(isReasoned).length
      return {
        provider,
        attempts,
        empty,
        emptyRate,
        reasoned,
        reasonedRate: reasoned / attempts,
        medianReasoningTokens: median(rows.flatMap((r) => r.tokens.reasoning ?? [])),
        p,
        outlier:
          attempts >= OUTLIER_RULE.minCalls &&
          emptyRate >= OUTLIER_RULE.minEmptyRate &&
          p !== null &&
          p < OUTLIER_RULE.maxP,
      }
    })
    // Stable sort: ties keep first-seen order.
    providers.sort((a, b) => b.attempts - a.attempts)
    return {
      model,
      attempts: calls.length,
      caught: calls.filter((r) => r.flags.length > 0).length,
      providers,
      reasoning: reasoningPanel(calls, providers),
    }
  })
  return models.sort((a, b) => b.caught - a.caught || b.attempts - a.attempts)
}

function reasoningPanel(calls: CallRecord[], providers: ProviderStats[]): ReasoningPanel | null {
  const leveled = calls.filter(
    (r) =>
      r.reasoningRequested !== null &&
      r.reasoningRequested !== 'provider-default' &&
      r.tokens.reasoning !== null,
  )
  const levels = LEVELS.filter((level) => leveled.some((r) => r.reasoningRequested === level))
  if (levels.length < 2) return null
  const lowest = levels[0] as ReasoningLevel
  const highest = levels[levels.length - 1] as ReasoningLevel

  const byProvider = groupBy(leveled, providerOf)
  const rows = providers
    .filter((p) => byProvider.has(p.provider))
    .map(({ provider }): ReasoningRow => {
      const runs: ReasoningRow['runs'] = {}
      const medians: ReasoningRow['medians'] = {}
      for (const level of levels) {
        const values = (byProvider.get(provider) ?? [])
          .filter((r) => r.reasoningRequested === level)
          .map((r) => r.tokens.reasoning as number)
        const m = median(values)
        if (m === null) continue
        runs[level] = values
        medians[level] = m
      }
      return { provider, runs, medians, effortIgnored: false }
    })

  // Change and ratio between the medians at the lowest and highest requested levels.
  const spread = (row: ReasoningRow) => {
    const lo = row.medians[lowest]
    const hi = row.medians[highest]
    if (lo === undefined || hi === undefined) return undefined
    const min = Math.min(lo, hi)
    const max = Math.max(lo, hi)
    if (min === 0)
      return max === 0 ? { change: 0, ratio: 1 } : { change: Infinity, ratio: Infinity }
    return { change: (max - min) / min, ratio: max / min }
  }
  for (const row of rows) {
    const own = spread(row)
    if (!own || own.change >= EFFORT_RULE.maxFlatChange) continue
    row.effortIgnored = rows.some(
      (other) => other !== row && (spread(other)?.ratio ?? 0) >= EFFORT_RULE.minRatio,
    )
  }
  return { levels, rows }
}

/** Parses JSON lines, skipping blank lines and anything that is not a v1 call record. */
export function parseRecords(text: string): { records: CallRecord[]; skipped: number } {
  const records: CallRecord[] = []
  let skipped = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const value: unknown = JSON.parse(trimmed)
      if (isCallRecord(value)) records.push(value)
      else skipped++
    } catch {
      skipped++
    }
  }
  return { records, skipped }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export function isCallRecord(v: unknown): v is CallRecord {
  return (
    isObject(v) &&
    v.v === 1 &&
    typeof v.id === 'string' &&
    typeof v.ts === 'string' &&
    typeof v.model === 'string' &&
    Array.isArray(v.flags) &&
    isObject(v.tokens) &&
    isObject(v.delivered)
  )
}

const UNITS: Record<string, number> = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3 }

/** "15m" → 900000. Returns undefined for anything else. */
export function parseDuration(value: string): number | undefined {
  const match = /^(\d+)(s|m|h|d|w)$/.exec(value.trim())
  return match ? Number(match[1]) * (UNITS[match[2] as string] as number) : undefined
}

// ---------------------------------------------------------------------------------------------
// Text rendering

const ansi = (open: number, close: number) => (on: boolean) => (s: string) =>
  on ? `\u001b[${open}m${s}\u001b[${close}m` : s
const bold = ansi(1, 22)
const red = ansi(31, 39)
const yellow = ansi(33, 39)

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const number = (n: number) => Math.round(n).toLocaleString('en-US')
export const formatP = (p: number) => (p < 0.0001 ? 'p < 0.0001' : `p = ${p.toFixed(4)}`)

/** Pads cells into aligned columns. The last cell is never padded, so lines have no trailing space. */
function columns(rows: string[][], right: number[]): string[] {
  const widths: number[] = []
  for (const row of rows) {
    for (const [i, cell] of row.entries()) widths[i] = Math.max(widths[i] ?? 0, cell.length)
  }
  return rows.map((row) =>
    row
      .map((cell, i) => {
        if (i === row.length - 1 && !right.includes(i)) return cell
        const width = widths[i] ?? 0
        return right.includes(i) ? cell.padStart(width) : cell.padEnd(width)
      })
      .join('   ')
      .trimEnd(),
  )
}

export function renderReport(models: ModelReport[], { color = false } = {}): string {
  const bodies = models.map((m) => {
    const digits = Math.max(...m.providers.map((p) => String(p.empty).length))
    const table = columns(
      [
        ['provider', 'attempts', 'empty', 'reasoned', ''],
        ...m.providers.map((p) => [
          p.provider,
          String(p.attempts),
          `${String(p.empty).padStart(digits)} (${(p.emptyRate * 100).toFixed(1)}%)`,
          `${Math.round(p.reasonedRate * 100)}%`,
          p.outlier && p.p !== null ? `outlier  ${formatP(p.p)}` : '',
        ]),
      ],
      [1],
    ).map((line) => `  ${line}`)

    const lines = [...table]
    if (m.reasoning) {
      const { levels, rows } = m.reasoning
      const panel = columns(
        [
          ['reasoning tokens (median)', ...levels, ''],
          ...rows.map((r) => [
            r.provider,
            ...levels.map((l) => (r.medians[l] === undefined ? '—' : number(r.medians[l]))),
            r.effortIgnored ? 'effort appears ignored' : '',
          ]),
        ],
        levels.map((_, i) => i + 1),
      ).map((line) => `  ${line}`)
      lines.push('', ...panel)
    }
    return { m, lines, summary: `${plural(m.attempts, 'attempt')} · ${m.caught} caught` }
  })

  // One width for every block, so model summaries line up down the page.
  const width = Math.max(
    ...bodies.flatMap(({ m, lines, summary }) => [
      ...lines.map((l) => l.length),
      m.model.length + summary.length + 4,
    ]),
  )
  const blocks = bodies.map(({ m, lines, summary }) => {
    const gap = ' '.repeat(width - m.model.length - summary.length)
    return [`${bold(color)(m.model)}${gap}${summary}`, ...lines]
      .map((line) =>
        line
          .replace(/outlier {2}p [<=] [\d.]+$/, (s) => red(color)(s))
          .replace(/effort appears ignored$/, (s) => yellow(color)(s)),
      )
      .join('\n')
  })
  return `${blocks.join('\n\n')}\n`
}
