import { generateText, wrapLanguageModel } from 'ai'
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
import {
  callGenerate,
  emptyResult,
  endpointsFixture,
  gatewayOf,
  mockModel,
  okResult,
  withRouting,
  withText,
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

describe('guard() with generateText', () => {
  test('1. a healthy call passes through unchanged and writes one record', async () => {
    const ok = okResult()
    const { out, sink, calls } = await callGenerate({}, [ok])

    expect(out).toBe(ok)
    expect(calls).toHaveLength(1)
    expect(sink.records).toHaveLength(1)
    expect(sink.records[0]).toMatchObject({
      v: 1,
      retryOf: null,
      model: 'zai/glm-5.3-flash',
      provider: 'zai',
      mode: 'generate',
      finish: 'stop',
      tokens: { in: 1830, out: 6, text: 4, reasoning: 2 },
      delivered: { textChars: 5, reasoningChars: 4, toolCalls: 0 },
      reasoningRequested: null,
      flags: [],
      retry: null,
      parts: null,
      generationId: 'gen_01K6A1B2C3D4E5F6G7H8J9K0GH',
    })
    expect(sink.records[0]?.id).toMatch(/^pg_[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  test('2. billed-but-empty is retried once on another provider and recovers', async () => {
    const incidents: Incident[] = []
    const sink = memorySink()
    const { model, calls } = mockModel({ generate: [emptyResult(), okResult()] })
    const wrapped = wrapLanguageModel({
      model,
      middleware: guard({ sink, onIncident: (i) => incidents.push(i) }),
    })

    const result = await generateText({ model: wrapped, prompt: 'Summarize the ticket.' })

    expect(result.text).toBe('Done.')
    expect(calls).toHaveLength(2)
    expect(gatewayOf(calls[1])).toEqual({ only: ['zai', 'fireworks'] })
    // Both attempts were billed, so usage is the sum.
    expect(result.usage.inputTokens).toBe(3660)
    expect(result.usage.outputTokens).toBe(12)
    expect(result.usage.outputTokenDetails.textTokens).toBe(8)
    expect(result.providerMetadata?.providerGuard).toEqual({
      retried: true,
      reason: 'Finished "stop" with 4 text tokens billed but no text or tool calls delivered',
      attempts: [
        {
          provider: 'baseten',
          usage: { inputTokens: 1830, outputTokens: 6, textTokens: 4, reasoningTokens: 2 },
        },
        {
          provider: 'zai',
          usage: { inputTokens: 1830, outputTokens: 6, textTokens: 4, reasoningTokens: 2 },
        },
      ],
    })

    const [flagged, retry] = sink.records as [CallRecord, CallRecord]
    expect(sink.records).toHaveLength(2)
    expect(flagged).toMatchObject({
      provider: 'baseten',
      flags: ['billed-but-empty'],
      delivered: { textChars: 0, reasoningChars: 4, toolCalls: 0 },
      retry: { attempted: true, provider: 'zai', outcome: 'recovered', skipReason: null },
    })
    expect(retry).toMatchObject({ retryOf: flagged.id, provider: 'zai', flags: [], retry: null })
    expect(incidents).toHaveLength(1)
    expect(incidents[0]).toMatchObject({ record: flagged, retryRecord: retry })
  })

  test('3. a retry that is also empty is still-empty and is not retried again', async () => {
    const second = withRouting(emptyResult(), {
      finalProvider: 'zai',
      fallbacksAvailable: ['zai', 'fireworks'],
    })
    const sink = memorySink()
    const { model, calls } = mockModel({ generate: [emptyResult(), second] })
    const wrapped = wrapLanguageModel({ model, middleware: guard({ sink }) })

    const result = await generateText({ model: wrapped, prompt: 'hi' })

    expect(calls).toHaveLength(2)
    expect(result.text).toBe('')
    expect(result.usage.outputTokens).toBe(12)
    expect(sink.records[0]?.retry).toMatchObject({ provider: 'zai', outcome: 'still-empty' })
    expect(sink.records[1]).toMatchObject({ flags: ['billed-but-empty'], retry: null })
  })

  test('4. a call that emitted a tool call is never retried', async () => {
    const withTool = emptyResult()
    withTool.content.push({
      type: 'tool-call',
      toolCallId: 'call_1',
      toolName: 'lookup',
      input: '{}',
    })
    const alwaysFlag: Detector = () => ({ id: 'always', reason: 'test detector', retry: true })

    const { out, sink, calls } = await callGenerate({ detectors: ['billedButEmpty', alwaysFlag] }, [
      withTool,
    ])

    expect(out).toBe(withTool)
    expect(calls).toHaveLength(1)
    // billedButEmpty does not fire when a tool call was delivered; the custom detector does.
    expect(sink.records[0]).toMatchObject({
      flags: ['always'],
      delivered: { toolCalls: 1 },
      retry: skipped('tool-call-emitted'),
    })
  })

  test.each([
    ['missing', undefined],
    ['malformed', { finalProvider: 42, fallbacksAvailable: 'zai' }],
    ['not an object', 'baseten'],
  ])('5. %s routing metadata: no retry, a record, no throw', async (_label, routing) => {
    const flagged = withRouting(emptyResult(), routing)
    const { out, sink, calls } = await callGenerate({}, [flagged])

    expect(out).toBe(flagged)
    expect(calls).toHaveLength(1)
    expect(sink.records[0]).toMatchObject({
      provider: null,
      flags: ['billed-but-empty'],
      retry: skipped('unknown-provider'),
    })
  })

  test('5. provider metadata absent entirely: no retry, no throw', async () => {
    const flagged = { ...emptyResult(), providerMetadata: undefined }
    const { sink } = await callGenerate({}, [flagged])
    expect(sink.records[0]?.retry).toEqual(skipped('unknown-provider'))
    expect(sink.records[0]?.generationId).toBe('gen_01K6A1B2C3D4E5F6G7H8J9K0EF')
  })

  test('6. without fallbacksAvailable, candidates come from the exclude() provider list', async () => {
    const fetch = vi.fn(async () => Response.json(endpointsFixture()))
    await exclude('zai/glm-5.3-flash', [], { fetch })
    const flagged = withRouting(emptyResult(), { finalProvider: 'baseten' })

    const { sink, calls } = await callGenerate({}, [flagged, okResult()])

    const only = gatewayOf(calls[1])?.only as string[]
    expect(fetch).toHaveBeenCalledOnce()
    expect(only).toHaveLength(18)
    expect(only).not.toContain('baseten')
    expect(only).toEqual(expect.arrayContaining(['zai', 'fireworks', 'deepinfra']))
    expect(sink.records[0]?.retry?.outcome).toBe('recovered')
  })

  test('6. with a cold cache, guard() loads the provider list itself', async () => {
    const fetch = vi.fn(async () => Response.json(endpointsFixture()))
    vi.stubGlobal('fetch', fetch)
    const flagged = withRouting(emptyResult(), { finalProvider: 'baseten' })

    const { calls } = await callGenerate({}, [flagged, okResult()])

    expect(fetch).toHaveBeenCalledWith(
      'https://ai-gateway.vercel.sh/v1/models/zai/glm-5.3-flash/endpoints',
      expect.anything(),
    )
    expect(gatewayOf(calls[1])?.only).toHaveLength(18)
  })

  test('6. if the provider list cannot be loaded, the retry is skipped', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('down', { status: 503 })),
    )
    const flagged = withRouting(emptyResult(), { finalProvider: 'baseten' })

    const { sink, calls } = await callGenerate({}, [flagged])

    expect(calls).toHaveLength(1)
    expect(sink.records[0]?.retry).toEqual(skipped('provider-list-unavailable'))
  })

  test("7. the caller's only and order are intersected and adjusted; the rest is kept", async () => {
    const gateway = {
      only: ['baseten', 'zai'],
      order: ['BaseTen', 'zai'],
      sort: 'cost',
      models: ['zai/glm-4.7'],
      user: 'u_1',
    }
    const { calls } = await callGenerate({}, [emptyResult(), okResult()], {
      providerOptions: { gateway, openai: { store: false } },
    })

    expect(calls[1]?.providerOptions).toEqual({
      gateway: {
        only: ['zai'],
        order: ['zai'],
        sort: 'cost',
        models: ['zai/glm-4.7'],
        user: 'u_1',
      },
      openai: { store: false },
    })
    // The caller's params object is not mutated.
    expect(gateway.only).toEqual(['baseten', 'zai'])
  })

  test('7. an order that only named the served provider is dropped', async () => {
    const { calls } = await callGenerate({}, [emptyResult(), okResult()], {
      providerOptions: { gateway: { order: ['baseten'] } },
    })
    expect(gatewayOf(calls[1])).toEqual({ only: ['zai', 'fireworks'] })
  })

  test.each([
    ['caller only', { providerOptions: { gateway: { only: ['baseten'] } } }, undefined],
    ['routing', {}, { finalProvider: 'baseten', fallbacksAvailable: ['baseten'] }],
  ])('8. no alternative provider (%s): skipped with a reason', async (_l, params, routing) => {
    const flagged = routing ? withRouting(emptyResult(), routing) : emptyResult()
    const { sink, calls } = await callGenerate({}, [flagged], params)

    expect(calls).toHaveLength(1)
    expect(sink.records[0]?.retry).toEqual(skipped('no-alternative-provider'))
  })

  test('9. an aborted call is not retried', async () => {
    const controller = new AbortController()
    controller.abort()
    const { sink, calls } = await callGenerate({}, [emptyResult()], {
      abortSignal: controller.signal,
    })

    expect(calls).toHaveLength(1)
    expect(sink.records[0]?.retry).toEqual(skipped('aborted'))
  })

  test('9. an abort that rejects the call propagates and writes nothing', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError')
    const sink = memorySink()
    await expect(callGenerate({ sink }, [abort])).rejects.toThrow('aborted')
    expect(sink.records).toHaveLength(0)
  })

  test('10. a retry that throws returns the original result and records failed', async () => {
    const onIncident = vi.fn()
    const first = emptyResult()
    const boom = new Error('upstream 500')

    const { out, sink, calls } = await callGenerate({ onIncident }, [first, boom])

    expect(out).toBe(first)
    expect(calls).toHaveLength(2)
    expect(sink.records).toHaveLength(1)
    expect(sink.records[0]?.retry).toEqual({
      attempted: true,
      provider: null,
      outcome: 'failed',
      skipReason: null,
    })
    expect(onIncident).toHaveBeenCalledOnce()
    expect(onIncident.mock.calls[0]?.[0]).toMatchObject({ retryRecord: null, error: boom })
  })

  test.each([
    [true, ['billed-but-empty'], 2, 0],
    [false, [], 1, 4],
  ])('11. whitespace-only text with treatWhitespaceAsEmpty=%s', async (treat, flags, n, chars) => {
    const blank = withText(emptyResult(), ' \n\t ')
    const { sink, calls } = await callGenerate({ treatWhitespaceAsEmpty: treat }, [
      blank,
      okResult(),
    ])

    expect(sink.records[0]?.flags).toEqual(flags)
    expect(sink.records[0]?.delivered.textChars).toBe(chars)
    expect(calls).toHaveLength(n)
  })

  test('12. providerOptions.gateway.exclude warns once per process', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const params = { providerOptions: { gateway: { exclude: ['baseten'] } } }

    await callGenerate({}, [okResult()], params)
    await callGenerate({}, [okResult()], params)

    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]?.[0]).toBe(
      '[provider-guard] AI Gateway ignores `exclude` as of 2026-09-28. Use exclude() from provider-guard.',
    )
  })
})

describe('guard() generate: guarantees and options', () => {
  test('a model not served through AI Gateway is detected and recorded but not retried', async () => {
    const { sink, calls } = await callGenerate({}, [emptyResult()], {}, { provider: 'openai.chat' })
    expect(calls).toHaveLength(1)
    expect(sink.records[0]).toMatchObject({
      flags: ['billed-but-empty'],
      retry: skipped('not-gateway'),
    })
  })

  test('retry.max 0 detects and records without retrying', async () => {
    const { sink, calls } = await callGenerate({ retry: { max: 0 } }, [emptyResult()])
    expect(calls).toHaveLength(1)
    expect(sink.records[0]?.retry).toEqual(skipped('retry-disabled'))
  })

  test('a detector that does not ask for a retry is report-only', async () => {
    const note: Detector = (call) =>
      call.finishReason === 'stop' ? { id: 'note', reason: 'noted', retry: false } : null
    const { sink, calls } = await callGenerate({ detectors: [note] }, [okResult()])
    expect(calls).toHaveLength(1)
    expect(sink.records[0]).toMatchObject({ flags: ['note'], retry: skipped('report-only') })
  })

  test('custom detectors receive the call summary, and a throwing detector is ignored', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const seen = vi.fn(() => null)
    const broken: Detector = () => {
      throw new Error('bug in detector')
    }
    const { sink } = await callGenerate({ detectors: [broken, seen, 'billedButEmpty'] }, [
      okResult(),
    ])

    expect(seen).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'zai/glm-5.3-flash',
        mode: 'generate',
        finishReason: 'stop',
        usage: { inputTokens: 1830, outputTokens: 6, textTokens: 4, reasoningTokens: 2 },
        delivered: { textChars: 5, reasoningChars: 4, toolCalls: 0 },
        routing: expect.objectContaining({ finalProvider: 'zai' }),
      }),
    )
    expect(sink.records[0]?.flags).toEqual([])
    expect(warn).toHaveBeenCalledOnce()
  })

  test('the requested reasoning level is recorded', async () => {
    const { sink } = await callGenerate({}, [okResult()], { reasoning: 'xhigh' })
    expect(sink.records[0]?.reasoningRequested).toBe('xhigh')
  })

  test('sink and onIncident errors never reach the caller', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const first = emptyResult()
    const throwing = {
      write: () => {
        throw new Error('disk full')
      },
    }
    const { out } = await callGenerate(
      {
        sink: throwing,
        onIncident: () => {
          throw new Error('bad hook')
        },
      },
      [first, okResult()],
    )
    expect(out?.content).toContainEqual({ type: 'text', text: 'Done.' })

    const rejecting = { write: () => Promise.reject(new Error('EACCES')) }
    await callGenerate({ sink: rejecting }, [okResult()])
    await new Promise((r) => setTimeout(r, 0))
    expect(warn.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining([
        expect.stringContaining('disk full'),
        expect.stringContaining('bad hook'),
        expect.stringContaining('EACCES'),
      ]),
    )
  })

  test('enabled: false returns a pass-through middleware', async () => {
    const middleware = guard({ enabled: false, sink: memorySink() })
    expect(middleware.wrapGenerate).toBeUndefined()
    expect(middleware.wrapStream).toBeUndefined()
  })

  test('usage sums keep undefined fields undefined', async () => {
    const first = emptyResult()
    first.usage.inputTokens = {
      total: undefined,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    }
    const second = okResult()
    second.usage.inputTokens.cacheWrite = undefined
    const { out } = await callGenerate({}, [first, second])
    expect(out?.usage.inputTokens).toEqual({
      total: 1830,
      noCache: 1830,
      cacheRead: 0,
      cacheWrite: undefined,
    })
  })
})
