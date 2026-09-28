import { streamText, wrapLanguageModel } from 'ai'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { _clearProviderCache } from '../src/exclude'
import {
  type CallRecord,
  type Detector,
  exclude,
  guard,
  type Incident,
  memorySink,
} from '../src/index'
import { _resetWarnings } from '../src/log'
import type { StreamPart } from '../src/types'
import {
  callStream,
  emptyParts,
  endpointsFixture,
  gatewayOf,
  manualStream,
  mockModel,
  okParts,
  openStream,
  partsWithRouting,
  types,
  within,
} from './helpers'

beforeEach(() => {
  _resetWarnings()
  _clearProviderCache()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const skipped = (skipReason: string) => ({
  attempted: false,
  provider: null,
  outcome: 'skipped',
  skipReason,
})
const failed = { attempted: true, provider: null, outcome: 'failed', skipReason: null }

/** Inserts parts just before the finish part. */
function beforeFinish(parts: StreamPart[], ...extra: StreamPart[]): StreamPart[] {
  const out = [...parts]
  out.splice(out.length - 1, 0, ...extra)
  return out
}

const ATTEMPT_1 = [
  'stream-start',
  'response-metadata',
  'reasoning-start',
  'reasoning-delta',
  'reasoning-delta',
  'reasoning-end',
]

async function readAll(reader: ReadableStreamDefaultReader<StreamPart>) {
  const parts: StreamPart[] = []
  for (;;) {
    const { done, value } = await within(reader.read())
    if (done) return parts
    parts.push(value)
  }
}

describe('guard() with streamText', () => {
  test('1. a healthy stream passes through part by part and releases finish at once', async () => {
    const src = manualStream()
    const { stream, sink } = await openStream({}, [src.stream])
    const reader = stream.getReader()

    // Each part reaches the consumer before the next one exists: nothing is buffered.
    for (const part of okParts()) {
      src.push(part)
      expect(await within(reader.read(), 200, part.type)).toEqual({ done: false, value: part })
    }
    // The finish was delivered while the source is still open, and its record is written.
    expect(sink.records).toHaveLength(1)
    src.close()
    expect(await within(reader.read())).toEqual({ done: true, value: undefined })

    expect(sink.records[0]).toMatchObject({
      provider: 'zai',
      mode: 'stream',
      flags: [],
      retry: null,
      tokens: { in: 1830, out: 6, text: 4, reasoning: 2 },
      delivered: { textChars: 5, reasoningChars: 4, toolCalls: 0 },
      generationId: 'gen_01K6A1B2C3D4E5F6G7H8J9K0CD',
    })
    expect(sink.records[0]?.parts?.map((p) => p.t)).toEqual(types(okParts()))
  })

  test('2. billed-but-empty is retried and spliced into the same stream', async () => {
    const incidents: Incident[] = []
    const sink = memorySink()
    const { model, calls } = mockModel({ stream: [emptyParts(), okParts()] })
    const wrapped = wrapLanguageModel({
      model,
      middleware: guard({ sink, onIncident: (i) => incidents.push(i) }),
    })

    const result = streamText({ model: wrapped, prompt: 'Summarize the ticket.' })

    expect(await result.text).toBe('Done.')
    // Attempt 1's reasoning was already streamed; attempt 2's duplicate reasoning is dropped.
    expect(await result.reasoningText).toBe('Ok, ')
    const usage = await result.usage
    expect(usage.inputTokens).toBe(3660)
    expect(usage.outputTokens).toBe(12)
    expect((await result.providerMetadata)?.providerGuard).toMatchObject({
      retried: true,
      attempts: [{ provider: 'baseten' }, { provider: 'zai' }],
    })
    expect(calls).toHaveLength(2)
    expect(gatewayOf(calls[1])).toEqual({ only: ['zai', 'fireworks'] })

    const [flagged, retry] = sink.records as [CallRecord, CallRecord]
    expect(sink.records).toHaveLength(2)
    expect(flagged).toMatchObject({
      mode: 'stream',
      provider: 'baseten',
      flags: ['billed-but-empty'],
      delivered: { textChars: 0, reasoningChars: 4, toolCalls: 0 },
      retry: { attempted: true, provider: 'zai', outcome: 'recovered', skipReason: null },
    })
    expect(flagged.parts?.map((p) => p.t)).toEqual([...ATTEMPT_1, 'finish'])
    // The retry's record keeps its full anatomy, including the parts that were not forwarded.
    expect(retry).toMatchObject({ retryOf: flagged.id, provider: 'zai', flags: [], retry: null })
    expect(retry.parts?.map((p) => p.t)).toEqual(types(okParts()))
    expect(incidents).toHaveLength(1)
    expect(incidents[0]).toMatchObject({ record: flagged, retryRecord: retry })
  })

  test('3. a retry that is also empty is still-empty and is not retried again', async () => {
    const second = partsWithRouting(emptyParts(), {
      finalProvider: 'zai',
      fallbacksAvailable: ['zai', 'fireworks'],
    })
    const { parts, sink, calls } = await callStream({}, [emptyParts(), second])

    expect(calls).toHaveLength(2)
    expect(parts.filter((p) => p.type === 'finish')).toHaveLength(1)
    expect(sink.records[0]?.retry).toMatchObject({ provider: 'zai', outcome: 'still-empty' })
    expect(sink.records[1]).toMatchObject({ flags: ['billed-but-empty'], retry: null })
  })

  test('4. a stream that emitted a tool call is never retried', async () => {
    const withTool = beforeFinish(
      emptyParts(),
      { type: 'tool-input-start', id: 'call_1', toolName: 'lookup' },
      { type: 'tool-input-end', id: 'call_1' },
      { type: 'tool-call', toolCallId: 'call_1', toolName: 'lookup', input: '{}' },
    )
    const alwaysFlag: Detector = () => ({ id: 'always', reason: 'test detector', retry: true })

    const { parts, sink, calls } = await callStream({ detectors: ['billedButEmpty', alwaysFlag] }, [
      withTool,
    ])

    expect(calls).toHaveLength(1)
    expect(parts).toEqual(withTool)
    expect(sink.records[0]).toMatchObject({
      flags: ['always'],
      delivered: { toolCalls: 1 },
      retry: skipped('tool-call-emitted'),
    })
  })

  test.each([
    ['missing', undefined],
    ['malformed', { finalProvider: ['baseten'] }],
  ])('5. %s routing metadata: no retry, a record, no throw', async (_label, routing) => {
    const input = partsWithRouting(emptyParts(), routing)
    const { parts, sink, calls } = await callStream({}, [input])

    expect(calls).toHaveLength(1)
    expect(parts).toEqual(input)
    expect(sink.records[0]).toMatchObject({
      provider: null,
      flags: ['billed-but-empty'],
      retry: skipped('unknown-provider'),
    })
  })

  test('5. routing on an earlier part is used when the finish part carries none', async () => {
    const input = partsWithRouting(emptyParts(), undefined)
    input[5] = {
      type: 'reasoning-end',
      id: 'reasoning-0',
      providerMetadata: {
        gateway: { routing: { finalProvider: 'baseten', fallbacksAvailable: ['baseten', 'zai'] } },
      },
    }
    const { sink, calls } = await callStream({}, [input, okParts()])

    expect(gatewayOf(calls[1])).toEqual({ only: ['zai'] })
    expect(sink.records[0]?.provider).toBe('baseten')
  })

  test('6. without fallbacksAvailable, candidates come from the exclude() provider list', async () => {
    const fetch = vi.fn(async () => Response.json(endpointsFixture()))
    await exclude('zai/glm-5.3-flash', ['baseten'], { fetch })
    const input = partsWithRouting(emptyParts(), { finalProvider: 'baseten' })

    const { sink, calls } = await callStream({}, [input, okParts()])

    const only = gatewayOf(calls[1])?.only as string[]
    expect(only).toHaveLength(18)
    expect(only).not.toContain('baseten')
    expect(sink.records[0]?.retry?.outcome).toBe('recovered')
  })

  test("7. the caller's only and order are intersected and adjusted; the rest is kept", async () => {
    const { calls } = await callStream({}, [emptyParts(), okParts()], {
      providerOptions: {
        gateway: { only: ['zai', 'baseten'], order: ['baseten', 'zai'], sort: 'ttft' },
      },
    })
    expect(gatewayOf(calls[1])).toEqual({ only: ['zai'], order: ['zai'], sort: 'ttft' })
  })

  test('8. no alternative provider: the original stream, skipped with a reason', async () => {
    const input = partsWithRouting(emptyParts(), {
      finalProvider: 'baseten',
      fallbacksAvailable: ['baseten'],
    })
    const { parts, sink, calls } = await callStream({}, [input])

    expect(calls).toHaveLength(1)
    expect(parts).toEqual(input)
    expect(sink.records[0]?.retry).toEqual(skipped('no-alternative-provider'))
  })

  test('9. an abort mid-stream propagates, starts no retry, and writes nothing', async () => {
    const controller = new AbortController()
    const src = manualStream()
    controller.signal.addEventListener('abort', () => src.error(controller.signal.reason))
    const { stream, sink, calls } = await openStream({}, [src.stream], {
      abortSignal: controller.signal,
    })
    const reader = stream.getReader()
    src.push(...emptyParts().slice(0, 3))
    for (let i = 0; i < 3; i++) await within(reader.read())

    controller.abort()

    await expect(within(reader.read())).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls).toHaveLength(1)
    expect(sink.records).toHaveLength(0)
  })

  test('9. a caught finish that arrives after an abort is not retried', async () => {
    const controller = new AbortController()
    controller.abort()
    const input = emptyParts()
    const { parts, sink, calls } = await callStream({}, [input], { abortSignal: controller.signal })

    expect(calls).toHaveLength(1)
    expect(parts).toEqual(input)
    expect(sink.records[0]?.retry).toEqual(skipped('aborted'))
  })

  test('9. cancelling the stream releases the source and starts no retry', async () => {
    const src = manualStream()
    let sourceCancelled: unknown
    const source = new ReadableStream<StreamPart>({
      start(c) {
        for (const p of emptyParts()) c.enqueue(p)
      },
      cancel(reason) {
        sourceCancelled = reason
      },
    })
    const { stream, calls } = await openStream({}, [source, src.stream])
    const reader = stream.getReader()
    for (let i = 0; i < ATTEMPT_1.length; i++) await within(reader.read())

    await within(reader.cancel('user left'))

    expect(sourceCancelled).toBe('user left')
    expect(calls).toHaveLength(1)
  })

  test('10. a retry that throws emits the original stream and records failed', async () => {
    const onIncident = vi.fn()
    const input = emptyParts()
    const boom = new Error('upstream 500')
    const { parts, sink, calls } = await callStream({ onIncident }, [input, boom])

    expect(calls).toHaveLength(2)
    expect(parts).toEqual(input)
    expect(sink.records).toHaveLength(1)
    expect(sink.records[0]?.retry).toEqual(failed)
    expect(onIncident).toHaveBeenCalledOnce()
    expect(onIncident.mock.calls[0]?.[0]).toMatchObject({ retryRecord: null, error: boom })
  })

  test('10. a retry stream that errors midway still ends with the original finish', async () => {
    const input = emptyParts()
    const sent: StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'text-0' },
      { type: 'text-delta', id: 'text-0', delta: 'Do' },
    ]
    // Pull-based, so the error lands only after the first parts were read and forwarded.
    const retry = new ReadableStream<StreamPart>({
      pull(c) {
        const next = sent.shift()
        if (next) c.enqueue(next)
        else c.error(new Error('connection reset'))
      },
    })
    const { parts, sink } = await callStream({}, [input, retry])

    expect(types(parts)).toEqual([...ATTEMPT_1, 'text-start', 'text-delta', 'finish'])
    expect(parts.at(-1)).toBe(input.at(-1))
    expect(sink.records).toHaveLength(1)
    expect(sink.records[0]?.retry).toEqual(failed)
  })

  test('10. an error part or a missing finish in the retry counts as a failed retry', async () => {
    const errorPart: StreamPart[] = [{ type: 'error', error: new Error('provider overloaded') }]
    const noFinish = okParts().slice(0, -1)
    for (const retry of [errorPart, noFinish]) {
      const { parts, sink } = await callStream({}, [emptyParts(), retry])
      expect(parts.filter((p) => p.type === 'finish')).toEqual([emptyParts().at(-1)])
      expect(parts.some((p) => p.type === 'error')).toBe(false)
      expect(sink.records[0]?.retry).toEqual(failed)
    }
  })

  test.each([
    [true, ['billed-but-empty'], 2, 0],
    [false, [], 1, 3],
  ])('11. whitespace-only text with treatWhitespaceAsEmpty=%s', async (treat, flags, n, chars) => {
    const blank = beforeFinish(
      emptyParts(),
      { type: 'text-start', id: 'text-0' },
      { type: 'text-delta', id: 'text-0', delta: '  ' },
      { type: 'text-delta', id: 'text-0', delta: '\n' },
      { type: 'text-end', id: 'text-0' },
    )
    const { sink, calls } = await callStream({ treatWhitespaceAsEmpty: treat }, [blank, okParts()])

    expect(sink.records[0]?.flags).toEqual(flags)
    expect(sink.records[0]?.delivered.textChars).toBe(chars)
    expect(calls).toHaveLength(n)
  })

  test('12. providerOptions.gateway.exclude warns once per process', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const params = { providerOptions: { gateway: { exclude: ['baseten'] } } }

    await callStream({}, [okParts()], params)
    await callStream({}, [okParts()], params)

    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]?.[0]).toContain('AI Gateway ignores `exclude`')
  })
})

describe('13. streaming splice', () => {
  test("attempt 1's reasoning reaches the consumer live, before its finish exists", async () => {
    const src = manualStream()
    const { stream } = await openStream({}, [src.stream, okParts()])
    const reader = stream.getReader()
    const parts = emptyParts()
    const finish = parts.pop() as StreamPart

    for (const part of parts) {
      src.push(part)
      expect((await within(reader.read(), 200, part.type)).value).toEqual(part)
    }
    src.push(finish)
    src.close()

    expect(types(await readAll(reader))).toEqual(['text-start', 'text-delta', 'text-end', 'finish'])
  })

  test("attempt 2's stream-start, response-metadata, and reasoning are dropped by default", async () => {
    const { parts } = await callStream({}, [emptyParts(), okParts()])
    expect(types(parts)).toEqual([...ATTEMPT_1, 'text-start', 'text-delta', 'text-end', 'finish'])
  })

  test("reasoning: 'keep' forwards attempt 2's reasoning", async () => {
    const { parts } = await callStream({ retry: { reasoning: 'keep' } }, [emptyParts(), okParts()])
    expect(types(parts)).toEqual([
      ...ATTEMPT_1,
      'reasoning-start',
      'reasoning-delta',
      'reasoning-delta',
      'reasoning-end',
      'text-start',
      'text-delta',
      'text-end',
      'finish',
    ])
  })

  test('exactly one finish is emitted, with summed usage and providerGuard metadata', async () => {
    const { parts } = await callStream({}, [emptyParts(), okParts()])
    const finishes = parts.filter((p) => p.type === 'finish')

    expect(finishes).toHaveLength(1)
    expect(finishes[0]).toMatchObject({
      finishReason: { unified: 'stop' },
      usage: {
        inputTokens: { total: 3660 },
        outputTokens: { total: 12, text: 8, reasoning: 4 },
      },
      providerMetadata: {
        gateway: { routing: { finalProvider: 'zai' } },
        providerGuard: { retried: true, attempts: [{ provider: 'baseten' }, { provider: 'zai' }] },
      },
    })
  })
})

describe('guard() stream: edges', () => {
  test('a stream without a finish part passes through and writes nothing', async () => {
    const input = okParts().slice(0, -1)
    const { parts, sink } = await callStream({}, [input])
    expect(parts).toEqual(input)
    expect(sink.records).toHaveLength(0)
  })

  test('part summaries are capped per attempt and always keep the finish', async () => {
    const deltas: StreamPart[] = Array.from({ length: 1000 }, () => ({
      type: 'text-delta',
      id: 'text-0',
      delta: 'x',
    }))
    const input = beforeFinish(okParts(), ...deltas)
    const { parts, sink } = await callStream({}, [input])

    expect(parts).toHaveLength(input.length)
    const recorded = sink.records[0]?.parts ?? []
    expect(recorded).toHaveLength(400)
    expect(recorded.at(-1)?.t).toBe('finish')
    expect(sink.records[0]?.delivered.textChars).toBe(1005)
  })

  test('raw parts are forwarded but not recorded', async () => {
    const input = beforeFinish(okParts(), { type: 'raw', rawValue: { any: 'thing' } })
    const { parts, sink } = await callStream({}, [input])
    expect(parts).toEqual(input)
    expect(sink.records[0]?.parts?.map((p) => p.t)).not.toContain('raw')
  })

  test('a model not served through AI Gateway is recorded but not retried', async () => {
    const { parts, sink, calls } = await callStream({}, [emptyParts()], {}, { provider: 'openai' })
    expect(calls).toHaveLength(1)
    expect(parts).toEqual(emptyParts())
    expect(sink.records[0]?.retry).toEqual(skipped('not-gateway'))
  })
})
