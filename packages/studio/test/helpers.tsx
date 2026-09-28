import type { CallRecord } from '@core/records'
import { render } from '@testing-library/react'
import { vi } from 'vitest'
import replay20932 from '../replay/vercel-ai-20932.json'
import replay21207 from '../replay/vercel-ai-21207.json'
import { Studio } from '../src/App'
import type { Range, Source } from '../src/data'

export const records20932 = replay20932.records as CallRecord[]
export const records21207 = replay21207.records as CallRecord[]
export const allRecords = [...records20932, ...records21207]

/** The first caught attempt in #20932 and its retry. */
export const caught = records20932.find((r) => r.flags.length > 0) as CallRecord
export const caughtRetry = records20932.find((r) => r.retryOf === caught.id) as CallRecord

export function makeSource(records: CallRecord[], overrides: Partial<Source> = {}): Source {
  return {
    mode: 'live',
    label: 'Live · .provider-guard/calls.jsonl',
    status: 'ready',
    error: null,
    records,
    fresh: new Set(),
    reload: vi.fn(),
    replay: null,
    ...overrides,
  }
}

export function renderStudio(source: Source, range: Range = 'all') {
  const onRangeChange = vi.fn()
  const utils = render(<Studio source={source} range={range} onRangeChange={onRangeChange} />)
  return {
    ...utils,
    onRangeChange,
    rerenderWith: (next: Source) =>
      utils.rerender(<Studio source={next} range={range} onRangeChange={onRangeChange} />),
  }
}

let seq = 0
/** A small healthy record, for volume tests. */
export function healthy(i: number, fields: Partial<CallRecord> = {}): CallRecord {
  return {
    v: 1,
    id: `pg_test_${seq++}_${i}`,
    retryOf: null,
    ts: new Date(Date.UTC(2026, 8, 28, 10, 0, 0) - i * 1000).toISOString(),
    model: 'zai/glm-5.3-flash',
    provider: 'zai',
    mode: 'stream',
    finish: 'stop',
    tokens: { in: 100, out: 12, text: 10, reasoning: 2 },
    delivered: { textChars: 40, reasoningChars: 4, toolCalls: 0 },
    reasoningRequested: null,
    flags: [],
    retry: null,
    parts: [{ t: 'finish', ms: 100 }],
    generationId: null,
    durationMs: 100,
    ...fields,
  }
}
