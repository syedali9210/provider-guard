import {
  billedButEmpty,
  type CallSummary,
  createDelivery,
  type Detection,
  type Detector,
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
import type { CallOptions, GenerateResult, Middleware, Model, Usage } from './types'

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
  }
}

function warnIfNativeExclude(params: CallOptions): void {
  if (params.providerOptions?.gateway?.exclude !== undefined) {
    warnOnce(
      'gateway-exclude',
      'AI Gateway ignores `exclude` as of 2026-09-28. Use exclude() from provider-guard.',
    )
  }
}
