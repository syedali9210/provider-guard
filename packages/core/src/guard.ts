import {
  billedButEmpty,
  type CallSummary,
  createDelivery,
  type Detection,
  type Detector,
  type PartSummary,
  parseGenerationId,
  parseRouting,
  summarizeUsage,
} from './detect'
import { getProviderList } from './exclude'
import { errorMessage, warnOnce } from './log'
import {
  type CallRecord,
  defaultSink,
  newId,
  type RecordSink,
  type RetryInfo,
  type SkipReason,
} from './records'
import type { CallOptions, GenerateResult, Middleware, Model, StreamPart, Usage } from './types'

type FinishPart = Extract<StreamPart, { type: 'finish' }>
type Reader = ReadableStreamDefaultReader<StreamPart>

// ponytail: fixed cap on part summaries per attempt (first 399 parts + finish). Long answers lose
// the middle of their Studio timeline; bucket parts by time if that ever matters.
const MAX_PARTS = 400

export type GuardOptions = {
  /** Default: `['billedButEmpty']`. */
  detectors?: Array<'billedButEmpty' | Detector>
  /** Default: `{ max: 1, reasoning: 'drop' }`. `reasoning` applies to streams. */
  retry?: { max?: 0 | 1; reasoning?: 'drop' | 'keep' }
  /** Default: a file sink in Node (`.provider-guard/calls.jsonl`), a memory sink elsewhere. */
  sink?: RecordSink
  onIncident?: (incident: Incident) => void
  /** Default: `true`. */
  treatWhitespaceAsEmpty?: boolean
  /** Default: `true`. */
  enabled?: boolean
}

/** A caught call, reported once its retry (if any) has settled. */
export type Incident = {
  /** The attempt a detector caught; `record.retry` holds the outcome. */
  record: CallRecord
  /** The retry attempt, when one completed. */
  retryRecord: CallRecord | null
  detections: Detection[]
  /** Set when the retry threw. */
  error?: unknown
}

type Attempt = {
  id: string
  startedAt: number
  summary: CallSummary
  generationId: string | null
  durationMs: number
  detections: Detection[]
}

const BUILT_IN = { billedButEmpty } satisfies Record<string, Detector>

const lower = (s: string) => s.toLowerCase()
const stringArray = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : undefined
const add = (a: number | undefined, b: number | undefined) =>
  a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0)

/** Both attempts were billed, so the final usage is their sum. */
export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: {
      total: add(a.inputTokens.total, b.inputTokens.total),
      noCache: add(a.inputTokens.noCache, b.inputTokens.noCache),
      cacheRead: add(a.inputTokens.cacheRead, b.inputTokens.cacheRead),
      cacheWrite: add(a.inputTokens.cacheWrite, b.inputTokens.cacheWrite),
    },
    outputTokens: {
      total: add(a.outputTokens.total, b.outputTokens.total),
      text: add(a.outputTokens.text, b.outputTokens.text),
      reasoning: add(a.outputTokens.reasoning, b.outputTokens.reasoning),
    },
  }
}

export function guard(options: GuardOptions = {}): Middleware {
  if (options.enabled === false) return { specificationVersion: 'v4' }

  const detectors = (options.detectors ?? ['billedButEmpty']).map((d) =>
    typeof d === 'string' ? BUILT_IN[d] : d,
  )
  const maxRetries = options.retry?.max ?? 1
  const trimWhitespace = options.treatWhitespaceAsEmpty ?? true
  const sink = () => options.sink ?? defaultSink()

  function detect(summary: CallSummary): Detection[] {
    const found: Detection[] = []
    for (const detector of detectors) {
      try {
        const hit = detector(summary)
        if (hit) found.push(hit)
      } catch (error) {
        const name = detector.name || 'anonymous'
        warnOnce(
          `detector:${name}`,
          `Detector "${name}" threw and was ignored: ${errorMessage(error)}`,
        )
      }
    }
    return found
  }

  function write(record: CallRecord): void {
    const failed = (error: unknown) =>
      warnOnce(
        `sink:${errorMessage(error)}`,
        `Could not write a call record: ${errorMessage(error)}`,
      )
    try {
      const pending = sink().write(record)
      if (pending) pending.then(undefined, failed)
    } catch (error) {
      failed(error)
    }
  }

  function toRecord(a: Attempt, retryOf: string | null, retry: RetryInfo | null): CallRecord {
    const { summary: s } = a
    return {
      v: 1,
      id: a.id,
      retryOf,
      ts: new Date(a.startedAt).toISOString(),
      model: s.modelId,
      provider: s.routing?.finalProvider ?? null,
      mode: s.mode,
      finish: s.finishReason ?? null,
      tokens: {
        in: s.usage.inputTokens ?? null,
        out: s.usage.outputTokens ?? null,
        text: s.usage.textTokens ?? null,
        reasoning: s.usage.reasoningTokens ?? null,
      },
      delivered: s.delivered,
      reasoningRequested: s.reasoningRequested ?? null,
      flags: a.detections.map((d) => d.id),
      retry,
      parts: s.parts?.map((p) => ({ t: p.type, ms: p.atMs })) ?? null,
      generationId: a.generationId,
      durationMs: a.durationMs,
    }
  }

  const start = () => ({ id: newId(), startedAt: Date.now(), t0: performance.now() })

  function complete(
    begun: ReturnType<typeof start>,
    summary: CallSummary,
    generationId: string | undefined,
  ): Attempt {
    return {
      id: begun.id,
      startedAt: begun.startedAt,
      summary,
      generationId: generationId ?? null,
      durationMs: Math.round(performance.now() - begun.t0),
      detections: detect(summary),
    }
  }

  function summarizeGenerate(
    begun: ReturnType<typeof start>,
    result: GenerateResult,
    model: Model,
    params: CallOptions,
  ): Attempt {
    const delivery = createDelivery(trimWhitespace)
    for (const part of result.content) {
      if (part.type === 'text') delivery.text(part.text)
      else if (part.type === 'reasoning') delivery.reasoning(part.text)
      else if (part.type === 'tool-call') delivery.toolCall()
    }
    const summary: CallSummary = {
      modelId: model.modelId,
      mode: 'generate',
      finishReason: result.finishReason.unified,
      usage: summarizeUsage(result.usage),
      delivered: delivery.result(),
      reasoningRequested: params.reasoning,
      routing: parseRouting(result.providerMetadata),
    }
    const generationId = parseGenerationId(result.providerMetadata) ?? result.response?.id
    return complete(begun, summary, generationId)
  }

  /** Watches one streamed attempt: counts, part types, and timings. Never content. */
  function observeStream(begun: ReturnType<typeof start>, model: Model, params: CallOptions) {
    const delivery = createDelivery(trimWhitespace)
    const parts: PartSummary[] = []
    let earlierMetadata: unknown
    let responseId: string | undefined
    return {
      observe(part: StreamPart) {
        if (part.type !== 'raw' && (parts.length < MAX_PARTS - 1 || part.type === 'finish')) {
          parts.push({ type: part.type, atMs: Math.round(performance.now() - begun.t0) })
        }
        if (part.type === 'text-delta') delivery.text(part.delta)
        else if (part.type === 'reasoning-delta') delivery.reasoning(part.delta)
        else if (part.type === 'tool-call') delivery.toolCall()
        else if (part.type === 'response-metadata') responseId ??= part.id
        if (
          part.type !== 'finish' &&
          'providerMetadata' in part &&
          part.providerMetadata?.gateway
        ) {
          earlierMetadata = part.providerMetadata
        }
      },
      complete(finish: FinishPart): Attempt {
        const summary: CallSummary = {
          modelId: model.modelId,
          mode: 'stream',
          finishReason: finish.finishReason.unified,
          usage: summarizeUsage(finish.usage),
          delivered: delivery.result(),
          reasoningRequested: params.reasoning,
          // The finish part first, then any earlier part carrying gateway metadata.
          routing: parseRouting(finish.providerMetadata) ?? parseRouting(earlierMetadata),
          parts,
        }
        const generationId =
          parseGenerationId(finish.providerMetadata) ??
          parseGenerationId(earlierMetadata) ??
          responseId
        return complete(begun, summary, generationId)
      },
    }
  }

  /** Attempt 2 joins a stream already in progress: drop its preamble and (by default) reasoning. */
  const forwardFromRetry = (part: StreamPart) =>
    part.type !== 'stream-start' &&
    part.type !== 'response-metadata' &&
    (options.retry?.reasoning === 'keep' || !part.type.startsWith('reasoning'))

  /** PRD §5.1 retry semantics: candidates, exclusions, and every "never retry" rule. */
  async function planRetry(
    caught: Attempt,
    params: CallOptions,
    model: Model,
  ): Promise<{ params: CallOptions } | { skip: SkipReason }> {
    const { summary } = caught
    if (!caught.detections.some((d) => d.retry)) return { skip: 'report-only' }
    if (maxRetries < 1) return { skip: 'retry-disabled' }
    if (summary.delivered.toolCalls > 0) return { skip: 'tool-call-emitted' }
    if (params.abortSignal?.aborted) return { skip: 'aborted' }
    if (model.provider !== 'gateway') return { skip: 'not-gateway' }
    const served = summary.routing?.finalProvider
    if (!served) return { skip: 'unknown-provider' }

    let pool = summary.routing?.fallbacksAvailable
    if (!pool) {
      try {
        pool = await getProviderList(summary.modelId)
      } catch {
        pool = undefined
      }
      if (!pool) return { skip: 'provider-list-unavailable' }
    }

    const gateway = params.providerOptions?.gateway ?? {}
    const callerOnly = stringArray(gateway.only)?.map(lower)
    const candidates = pool.filter(
      (p) => lower(p) !== lower(served) && (!callerOnly || callerOnly.includes(lower(p))),
    )
    if (candidates.length === 0) return { skip: 'no-alternative-provider' }

    const next: typeof gateway = { ...gateway, only: candidates }
    const order = stringArray(gateway.order)
    if (order) {
      const kept = order.filter((p) => lower(p) !== lower(served))
      if (kept.length > 0) next.order = kept
      else delete next.order
    }
    return { params: { ...params, providerOptions: { ...params.providerOptions, gateway: next } } }
  }

  /** Writes the caught attempt (and its retry) and reports the incident. */
  function settle(caught: Attempt, retry: RetryInfo, retried?: Attempt, error?: unknown): void {
    const record = toRecord(caught, null, retry)
    const retryRecord = retried ? toRecord(retried, caught.id, null) : null
    write(record)
    if (retryRecord) write(retryRecord)
    try {
      options.onIncident?.({
        record,
        retryRecord,
        detections: caught.detections,
        ...(error === undefined ? {} : { error }),
      })
    } catch (hookError) {
      const message = errorMessage(hookError)
      warnOnce(`onIncident:${message}`, `onIncident threw and was ignored: ${message}`)
    }
  }

  const skipped = (skipReason: SkipReason): RetryInfo => ({
    attempted: false,
    provider: null,
    outcome: 'skipped',
    skipReason,
  })

  const outcomeOf = (retried: Attempt): RetryInfo => ({
    attempted: true,
    provider: retried.summary.routing?.finalProvider ?? null,
    outcome: retried.detections.some((d) => d.retry) ? 'still-empty' : 'recovered',
    skipReason: null,
  })

  const failed: RetryInfo = { attempted: true, provider: null, outcome: 'failed', skipReason: null }

  const guardMetadata = (caught: Attempt, retried: Attempt) => ({
    retried: true,
    reason: caught.detections.map((d) => d.reason).join('; '),
    attempts: [caught, retried].map((a) => ({
      provider: a.summary.routing?.finalProvider ?? null,
      usage: { ...a.summary.usage },
    })),
  })

  return {
    specificationVersion: 'v4',

    async wrapGenerate({ doGenerate, params, model }) {
      warnIfNativeExclude(params)
      const first = start()
      const result = await doGenerate()
      const caught = summarizeGenerate(first, result, model, params)
      if (caught.detections.length === 0) {
        write(toRecord(caught, null, null))
        return result
      }

      const plan = await planRetry(caught, params, model)
      if ('skip' in plan) {
        settle(caught, skipped(plan.skip))
        return result
      }

      const second = start()
      let retryResult: GenerateResult
      try {
        retryResult = await model.doGenerate(plan.params)
      } catch (error) {
        // Never worse than without provider-guard: hand back the original result.
        settle(caught, failed, undefined, error)
        return result
      }
      const retried = summarizeGenerate(second, retryResult, model, plan.params)
      settle(caught, outcomeOf(retried), retried)
      return {
        ...retryResult,
        usage: addUsage(result.usage, retryResult.usage),
        providerMetadata: {
          ...retryResult.providerMetadata,
          providerGuard: guardMetadata(caught, retried),
        },
      }
    },

    async wrapStream({ doStream, params, model }) {
      warnIfNativeExclude(params)
      const first = start()
      const result = await doStream()
      const readers: Reader[] = []
      const state = { cancelled: false }

      async function* guarded(): AsyncGenerator<StreamPart> {
        const attempt1 = observeStream(first, model, params)
        let held: { finish: FinishPart; caught: Attempt } | undefined
        for await (const part of readParts(result.stream, readers)) {
          if (held) continue // a caught attempt ends at its finish part
          attempt1.observe(part)
          if (part.type !== 'finish') {
            yield part // pass-through, never buffered
            continue
          }
          const caught = attempt1.complete(part)
          if (caught.detections.length > 0) {
            held = { finish: part, caught } // only a caught finish is held back
            continue
          }
          // Healthy: decided synchronously on the finish part and released at once.
          write(toRecord(caught, null, null))
          yield part
        }
        if (!held) return
        const { finish, caught } = held

        const plan: Awaited<ReturnType<typeof planRetry>> = state.cancelled
          ? { skip: 'aborted' }
          : await planRetry(caught, params, model)
        if ('skip' in plan) {
          settle(caught, skipped(plan.skip))
          yield finish
          return
        }

        const second = start()
        const attempt2 = observeStream(second, model, plan.params)
        let retryStream: ReadableStream<StreamPart> | undefined
        let finish2: FinishPart | undefined
        try {
          retryStream = (await model.doStream(plan.params)).stream
          for await (const part of readParts(retryStream, readers)) {
            if (part.type === 'error') throw part.error
            attempt2.observe(part)
            if (part.type === 'finish') finish2 = part
            else if (forwardFromRetry(part)) yield part
          }
          if (state.cancelled) throw new Error('The stream was cancelled during the retry.')
          if (!finish2) throw new Error('The retry stream ended without a finish part.')
        } catch (error) {
          retryStream?.cancel().catch(() => {})
          // Never worse than without provider-guard: end with the original finish part.
          settle(caught, failed, undefined, error)
          yield finish
          return
        }
        const retried = attempt2.complete(finish2)
        settle(caught, outcomeOf(retried), retried)
        yield {
          ...finish2,
          usage: addUsage(finish.usage, finish2.usage),
          providerMetadata: {
            ...finish2.providerMetadata,
            providerGuard: guardMetadata(caught, retried),
          },
        }
      }

      return { ...result, stream: toReadable(guarded(), readers, state) }
    },
  }
}

async function* readParts(stream: ReadableStream<StreamPart>, readers: Reader[]) {
  const reader = stream.getReader()
  readers.push(reader)
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      yield value
    }
  } finally {
    reader.releaseLock()
  }
}

/** Pull-based with no queue (highWaterMark 0): a part is read only when the consumer asks. */
function toReadable(
  parts: AsyncGenerator<StreamPart>,
  readers: Reader[],
  state: { cancelled: boolean },
): ReadableStream<StreamPart> {
  return new ReadableStream<StreamPart>(
    {
      async pull(controller) {
        try {
          const { done, value } = await parts.next()
          if (state.cancelled) return
          if (done) controller.close()
          else controller.enqueue(value)
        } catch (error) {
          if (!state.cancelled) controller.error(error)
        }
      },
      async cancel(reason) {
        state.cancelled = true
        await Promise.allSettled(readers.map((r) => r.cancel(reason)))
        parts.return(undefined).catch(() => {})
      },
    },
    { highWaterMark: 0 },
  )
}

function warnIfNativeExclude(params: CallOptions): void {
  if (params.providerOptions?.gateway?.exclude !== undefined) {
    warnOnce(
      'gateway-exclude',
      'AI Gateway ignores `exclude` as of 2026-09-28. Use exclude() from provider-guard.',
    )
  }
}
