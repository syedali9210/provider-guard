import { describe, expect, test } from 'vitest'
import type { CallRecord } from '../src/records'
import { buildReport, formatP, parseDuration, parseRecords } from '../src/report'

let seq = 0
function rec(fields: Partial<CallRecord> & { empty?: boolean } = {}): CallRecord {
  const { empty, ...rest } = fields
  return {
    v: 1,
    id: `pg_${seq++}`,
    retryOf: null,
    ts: '2026-09-28T10:00:00.000Z',
    model: 'acme/model',
    provider: 'a',
    mode: 'stream',
    finish: 'stop',
    tokens: { in: 10, out: 5, text: 5, reasoning: 0 },
    delivered: { textChars: empty ? 0 : 12, reasoningChars: 0, toolCalls: 0 },
    reasoningRequested: null,
    flags: empty ? ['billed-but-empty'] : [],
    retry: null,
    parts: null,
    generationId: null,
    durationMs: 100,
    ...rest,
  }
}
const many = (count: number, fields: Parameters<typeof rec>[0] = {}) =>
  Array.from({ length: count }, () => rec(fields))

const statsFor = (records: CallRecord[], provider: string) =>
  buildReport(records)[0]?.providers.find((p) => p.provider === provider)

describe('outlier rule', () => {
  test('flags a provider with at least 10 calls, 10% empty, and p < 0.01', () => {
    const records = [
      ...many(8, { provider: 'a', empty: true }),
      ...many(12, { provider: 'a' }),
      ...many(30, { provider: 'b' }),
    ]
    expect(statsFor(records, 'a')).toMatchObject({ attempts: 20, empty: 8, outlier: true })
    expect(statsFor(records, 'a')?.p).toBeCloseTo(125970 / 536878650, 12)
    expect(statsFor(records, 'b')).toMatchObject({ outlier: false })
  })

  test('needs at least 10 calls', () => {
    const records = [...many(9, { provider: 'a', empty: true }), ...many(30, { provider: 'b' })]
    const a = statsFor(records, 'a')
    expect(a?.p).toBeLessThan(0.01)
    expect(a?.outlier).toBe(false)
  })

  test('needs an empty rate of at least 10%', () => {
    const records = [
      ...many(90, { provider: 'a', empty: true }),
      ...many(910, { provider: 'a' }),
      ...many(1000, { provider: 'b' }),
    ]
    const a = statsFor(records, 'a')
    expect(a?.p).toBeLessThan(1e-10)
    expect(a?.outlier).toBe(false)
  })

  test('needs p < 0.01', () => {
    const records = [
      ...many(2, { provider: 'a', empty: true }),
      ...many(8, { provider: 'a' }),
      ...many(1, { provider: 'b', empty: true }),
      ...many(19, { provider: 'b' }),
    ]
    const a = statsFor(records, 'a')
    expect(a?.emptyRate).toBe(0.2)
    expect(a?.p).toBeGreaterThan(0.01)
    expect(a?.outlier).toBe(false)
  })

  test('a provider alone has no p-value and is never an outlier', () => {
    const a = statsFor(many(20, { provider: 'a', empty: true }), 'a')
    expect(a).toMatchObject({ p: null, outlier: false, emptyRate: 1 })
  })
})

describe('report aggregation', () => {
  test('counts caught attempts, reasoned share, and median reasoning tokens', () => {
    const reasoned = {
      delivered: { textChars: 5, reasoningChars: 8, toolCalls: 0 },
      tokens: { in: 1, out: 1, text: 1, reasoning: 30 },
    }
    const [model] = buildReport([
      rec({ provider: 'a', ...reasoned }),
      rec({ provider: 'a', tokens: { in: 1, out: 1, text: 1, reasoning: 10 } }),
      rec({ provider: 'a', flags: ['custom'] }),
      rec({ provider: null, empty: true }),
    ])
    expect(model).toMatchObject({ model: 'acme/model', attempts: 4, caught: 2 })
    expect(model?.providers.map((p) => p.provider)).toEqual(['a', 'unknown'])
    expect(model?.providers[0]).toMatchObject({
      reasoned: 2,
      reasonedRate: 2 / 3,
      medianReasoningTokens: 10,
    })
  })

  test('models are ordered by caught, then attempts', () => {
    const report = buildReport([
      ...many(3, { model: 'x/busy' }),
      rec({ model: 'y/caught', empty: true }),
    ])
    expect(report.map((m) => m.model)).toEqual(['y/caught', 'x/busy'])
  })
})

describe('reasoning panel', () => {
  const runs = (provider: string, level: 'low' | 'xhigh' | 'provider-default', values: number[]) =>
    values.map((reasoning) =>
      rec({
        model: 'openai/gpt-5.6-sol',
        provider,
        reasoningRequested: level,
        tokens: { in: 1, out: reasoning, text: 1, reasoning },
      }),
    )
  // vercel/ai#21207, exact per-run values.
  const issue21207 = [
    ...runs('openai', 'low', [1552, 1750, 1902]),
    ...runs('openai', 'xhigh', [5696, 6711, 7128]),
    ...runs('bedrock', 'low', [2588, 2704, 3303]),
    ...runs('bedrock', 'xhigh', [2588, 3060, 3106]),
  ]

  test('flags a provider whose medians barely move while another moves at least 2x', () => {
    const panel = buildReport(issue21207)[0]?.reasoning
    expect(panel?.levels).toEqual(['low', 'xhigh'])
    expect(panel?.rows).toEqual([
      {
        provider: 'openai',
        runs: { low: [1552, 1750, 1902], xhigh: [5696, 6711, 7128] },
        medians: { low: 1750, xhigh: 6711 },
        effortIgnored: false,
      },
      {
        provider: 'bedrock',
        runs: { low: [2588, 2704, 3303], xhigh: [2588, 3060, 3106] },
        medians: { low: 2704, xhigh: 3060 },
        effortIgnored: true,
      },
    ])
  })

  test('is absent with fewer than two requested levels, ignoring provider-default', () => {
    const records = [...runs('openai', 'low', [1, 2]), ...runs('openai', 'provider-default', [9])]
    expect(buildReport(records)[0]?.reasoning).toBeNull()
  })

  test('does not flag anyone when no provider responds to effort', () => {
    const records = [
      ...runs('openai', 'low', [100]),
      ...runs('openai', 'xhigh', [110]),
      ...runs('bedrock', 'low', [100]),
      ...runs('bedrock', 'xhigh', [105]),
    ]
    expect(buildReport(records)[0]?.reasoning?.rows.every((r) => !r.effortIgnored)).toBe(true)
  })

  test('treats zero reasoning at both levels as flat, and 0 → n as responsive', () => {
    const records = [
      ...runs('openai', 'low', [0]),
      ...runs('openai', 'xhigh', [500]),
      ...runs('bedrock', 'low', [0]),
      ...runs('bedrock', 'xhigh', [0]),
    ]
    const rows = buildReport(records)[0]?.reasoning?.rows
    expect(rows?.find((r) => r.provider === 'bedrock')?.effortIgnored).toBe(true)
    expect(rows?.find((r) => r.provider === 'openai')?.effortIgnored).toBe(false)
  })

  test('a provider missing one of the two levels is shown but never flagged', () => {
    const records = [
      ...runs('openai', 'low', [100]),
      ...runs('openai', 'xhigh', [900]),
      ...runs('bedrock', 'low', [100]),
    ]
    const bedrock = buildReport(records)[0]?.reasoning?.rows.find((r) => r.provider === 'bedrock')
    expect(bedrock).toMatchObject({ medians: { low: 100 }, effortIgnored: false })
  })
})

test('parseRecords skips blank lines, bad JSON, and non-records, and accepts CRLF', () => {
  const good = JSON.stringify(rec())
  const text = `${good}\r\n\n{not json}\n{"v":2,"id":"x"}\n[1,2]\n${good}`
  const { records, skipped } = parseRecords(text)
  expect(records).toHaveLength(2)
  expect(skipped).toBe(3)
})

test('parseDuration', () => {
  expect(parseDuration('15m')).toBe(900_000)
  expect(parseDuration('1h')).toBe(3_600_000)
  expect(parseDuration('7d')).toBe(604_800_000)
  expect(parseDuration('2w')).toBe(1_209_600_000)
  expect(parseDuration('30s')).toBe(30_000)
  for (const bad of ['', '1', 'h', '1.5h', '-1h', '1y']) expect(parseDuration(bad)).toBeUndefined()
})

test('formatP', () => {
  expect(formatP(5e-7)).toBe('p < 0.0001')
  expect(formatP(0.0062)).toBe('p = 0.0062')
})
