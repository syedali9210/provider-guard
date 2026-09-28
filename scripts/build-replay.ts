// Builds the public replay datasets (PRD §8) into packages/studio/replay/.
// Deterministic: a seeded PRNG, so reruns produce identical files.
// Counts, the empty attempt's token shape, and every reasoning token value come from the cited
// issues. Timing, input sizes, and answer lengths are synthetic, and records are reconstructed to
// match the published aggregates exactly.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CallRecord } from '../packages/core/src/records'

const OUT = join(import.meta.dirname, '..', 'packages', 'studio', 'replay')

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function dataset(seed: number) {
  const rand = mulberry32(seed)
  const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1))
  const shuffle = <T>(xs: T[]): T[] => {
    for (let i = xs.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      ;[xs[i], xs[j]] = [xs[j] as T, xs[i] as T]
    }
    return xs
  }
  const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  const id = (ts: number) => {
    let time = ''
    for (let i = 0, t = ts; i < 10; i++, t = Math.floor(t / 32)) time = CROCKFORD[t % 32] + time
    let random = ''
    for (let i = 0; i < 16; i++) random += CROCKFORD[int(0, 31)]
    return `pg_${time}${random}`
  }
  const record = (ts: number, fields: Partial<CallRecord>): CallRecord => ({
    v: 1,
    id: id(ts),
    retryOf: null,
    ts: new Date(ts).toISOString(),
    model: '',
    provider: null,
    mode: 'stream',
    finish: 'stop',
    tokens: { in: null, out: null, text: null, reasoning: null },
    delivered: { textChars: 0, reasoningChars: 0, toolCalls: 0 },
    reasoningRequested: null,
    flags: [],
    retry: null,
    parts: null,
    generationId: null,
    durationMs: 0,
    ...fields,
  })
  return { int, shuffle, record }
}

/** vercel/ai#20932: zai/glm-5.3-flash with tools; Baseten bills the answer and streams nothing. */
function build20932(): CallRecord[] {
  const { int, shuffle, record } = dataset(20932)
  const MODEL = 'zai/glm-5.3-flash'
  const input = () => int(1400, 2600)

  // Published shape: two reasoning deltas, then finish "stop", usage { total 6, text 4, reasoning 2 }.
  const empty = (ts: number, provider: string) => {
    const t1 = int(150, 260)
    const t2 = t1 + int(30, 70)
    const end = t2 + int(20, 60)
    return record(ts, {
      model: MODEL,
      provider,
      tokens: { in: input(), out: 6, text: 4, reasoning: 2 },
      delivered: { textChars: 0, reasoningChars: 4, toolCalls: 0 },
      flags: ['billed-but-empty'],
      parts: [
        { t: 'reasoning-delta', ms: t1 },
        { t: 'reasoning-delta', ms: t2 },
        { t: 'finish', ms: end },
      ],
      durationMs: end,
    })
  }
  // A successful attempt: the same shape plus one text part before finish.
  const ok = (ts: number, provider: string, model = MODEL, reasoned = true) => {
    const text = int(40, 420)
    const reasoning = reasoned ? (model === MODEL ? 2 : int(40, 400)) : 0
    const t1 = int(150, 280)
    const t2 = t1 + int(30, 70)
    const t3 = t2 + int(250, 900)
    const end = t3 + int(20, 60)
    const parts = reasoned
      ? [
          { t: 'reasoning-delta', ms: t1 },
          { t: 'reasoning-delta', ms: t2 },
          { t: 'text-delta', ms: t3 },
          { t: 'finish', ms: end },
        ]
      : [
          { t: 'text-delta', ms: t3 },
          { t: 'finish', ms: end },
        ]
    return record(ts, {
      model,
      provider,
      tokens: { in: input(), out: text + reasoning, text, reasoning },
      delivered: {
        textChars: text * int(3, 5),
        reasoningChars: reasoning === 2 ? 4 : reasoning * 4,
        toolCalls: 0,
      },
      parts,
      durationMs: end,
    })
  }

  // First attempts: Baseten 22 empty + 29 ok, zai 12, fireworks 3. The 22 retries (18 on zai,
  // 4 on fireworks) bring the totals to the published 51 / 30 / 7.
  type Call = 'baseten-empty' | 'baseten-ok' | 'zai' | 'fireworks' | 'glm47-baseten' | 'glm47-zai'
  const calls: Call[] = shuffle([
    ...Array<Call>(22).fill('baseten-empty'),
    ...Array<Call>(29).fill('baseten-ok'),
    ...Array<Call>(12).fill('zai'),
    ...Array<Call>(3).fill('fireworks'),
    // Report-only: zai/glm-4.7 never reasons on Baseten (0/40) but does on zai (20/26).
    ...Array<Call>(40).fill('glm47-baseten'),
    ...Array<Call>(26).fill('glm47-zai'),
  ])
  const retryProviders = shuffle([...Array(18).fill('zai'), ...Array(4).fill('fireworks')])
  const glm47Reasoned = shuffle([...Array(20).fill(true), ...Array(6).fill(false)])

  const records: CallRecord[] = []
  let ts = Date.parse('2026-09-17T09:00:00.000Z')
  for (const call of calls) {
    ts += int(2_000, 20_000)
    if (call === 'baseten-empty') {
      const caught = empty(ts, 'baseten')
      const provider = retryProviders.pop() as string
      const retry = ok(ts + caught.durationMs + int(5, 25), provider)
      retry.retryOf = caught.id
      caught.retry = { attempted: true, provider, outcome: 'recovered', skipReason: null }
      records.push(caught, retry)
    } else if (call === 'baseten-ok') records.push(ok(ts, 'baseten'))
    else if (call === 'zai' || call === 'fireworks') records.push(ok(ts, call))
    else if (call === 'glm47-baseten') records.push(ok(ts, 'baseten', 'zai/glm-4.7', false))
    else records.push(ok(ts, 'zai', 'zai/glm-4.7', glm47Reasoned.pop() as boolean))
  }
  return records
}

/** vercel/ai#21207: openai/gpt-5.6-sol on Bedrock silently drops reasoning effort. */
function build21207(): CallRecord[] {
  const { int, shuffle, record } = dataset(21207)
  // Exact per-run reasoning tokens, 3 runs per cell.
  const runs = {
    openai: { low: [1552, 1750, 1902], xhigh: [5696, 6711, 7128] },
    bedrock: { low: [2588, 2704, 3303], xhigh: [2588, 3060, 3106] },
  } as const
  const cells = shuffle(
    Object.entries(runs).flatMap(([provider, levels]) =>
      Object.entries(levels).flatMap(([level, tokens]) =>
        tokens.map((reasoning) => ({ provider, level: level as 'low' | 'xhigh', reasoning })),
      ),
    ),
  )
  let ts = Date.parse('2026-09-20T14:00:00.000Z')
  return cells.map(({ provider, level, reasoning }) => {
    ts += int(4_000, 30_000)
    const text = int(200, 700)
    return record(ts, {
      model: 'openai/gpt-5.6-sol',
      provider,
      mode: 'generate',
      tokens: { in: int(3000, 6000), out: text + reasoning, text, reasoning },
      delivered: { textChars: text * int(3, 5), reasoningChars: 0, toolCalls: 0 },
      reasoningRequested: level,
      durationMs: Math.round((reasoning + text) * (provider === 'bedrock' ? 9 : 7) + int(300, 900)),
    })
  })
}

const datasets = [
  {
    id: 'vercel-ai-20932',
    title: 'zai/glm-5.3-flash: billed but empty on Baseten',
    issue: 'https://github.com/vercel/ai/issues/20932',
    records: build20932(),
  },
  {
    id: 'vercel-ai-21207',
    title: 'openai/gpt-5.6-sol: reasoning effort dropped on Bedrock',
    issue: 'https://github.com/vercel/ai/issues/21207',
    records: build21207(),
  },
]

mkdirSync(OUT, { recursive: true })
for (const { id, title, issue, records } of datasets) {
  const note =
    'Reconstructed from data published in the linked issue. Counts, token shapes, and reasoning token values match the issue; timing, input sizes, and answer lengths are synthetic. No live traffic.'
  const file = join(OUT, `${id}.json`)
  writeFileSync(file, `${JSON.stringify({ id, title, issue, note, records }, null, 1)}\n`)
  console.log(`${id}: ${records.length} records -> ${file}`)
}
