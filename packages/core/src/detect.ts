import type { FinishReason, ReasoningLevel, Usage } from './types'

/** Fields observed under `providerMetadata.gateway.routing` in public issues. Untyped upstream. */
export type GatewayRouting = {
  finalProvider?: string
  fallbacksAvailable?: string[]
  originalModelId?: string
  resolvedProvider?: string
  modelAttemptCount?: number
  planningReasoning?: string
}

/** One stream part as a type and a time offset. Never content. */
export type PartSummary = { type: string; atMs: number }

export type CallSummary = {
  modelId: string
  mode: 'generate' | 'stream'
  finishReason?: FinishReason
  usage: {
    inputTokens?: number
    outputTokens?: number
    textTokens?: number
    reasoningTokens?: number
  }
  delivered: { textChars: number; reasoningChars: number; toolCalls: number }
  reasoningRequested?: ReasoningLevel
  routing?: GatewayRouting
  /** Stream only. */
  parts?: PartSummary[]
}

export type Detection = { id: string; reason: string; retry: boolean }
export type Detector = (call: CallSummary) => Detection | null

/** A 200 that billed text tokens and delivered neither text nor a tool call (vercel/ai#20932). */
export const billedButEmpty: Detector = ({ finishReason, usage, delivered }) => {
  const billed = usage.textTokens ?? 0
  if (finishReason !== 'stop' || billed <= 0) return null
  if (delivered.textChars !== 0 || delivered.toolCalls !== 0) return null
  const tokens = billed === 1 ? 'token' : 'tokens'
  return {
    id: 'billed-but-empty',
    reason: `Finished "stop" with ${billed} text ${tokens} billed but no text or tool calls delivered`,
    retry: true,
  }
}

export function summarizeUsage(usage: Usage): CallSummary['usage'] {
  const { total, text, reasoning } = usage.outputTokens
  const derived = total !== undefined && reasoning !== undefined ? total - reasoning : undefined
  return {
    inputTokens: usage.inputTokens.total,
    outputTokens: total,
    textTokens: text ?? derived,
    reasoningTokens: reasoning,
  }
}

const WHITESPACE = /\s/

/** Counts delivered characters incrementally. Content is never stored. */
export function createDelivery(trimWhitespace: boolean) {
  let text = 0
  let trailing = 0
  let started = !trimWhitespace
  let reasoning = 0
  let toolCalls = 0
  return {
    text(delta: string) {
      if (!trimWhitespace) {
        text += delta.length
        return
      }
      // Length of the trimmed concatenation: skip leading whitespace, subtract trailing.
      for (let i = 0; i < delta.length; i++) {
        const ws = WHITESPACE.test(delta.charAt(i))
        if (!started) {
          if (ws) continue
          started = true
        }
        text++
        trailing = ws ? trailing + 1 : 0
      }
    },
    reasoning(delta: string) {
      reasoning += delta.length
    },
    toolCall() {
      toolCalls++
    },
    result: (): CallSummary['delivered'] => ({
      textChars: text - trailing,
      reasoningChars: reasoning,
      toolCalls,
    }),
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const gatewayOf = (providerMetadata: unknown) =>
  isObject(providerMetadata) && isObject(providerMetadata.gateway)
    ? providerMetadata.gateway
    : undefined

const STRING_FIELDS = [
  'finalProvider',
  'originalModelId',
  'resolvedProvider',
  'planningReasoning',
] as const

/**
 * Hand-written validator for gateway routing metadata. Any field with an unexpected type makes
 * the whole object `undefined`: callers degrade gracefully and never throw on metadata shape.
 */
export function parseRouting(providerMetadata: unknown): GatewayRouting | undefined {
  const routing = gatewayOf(providerMetadata)?.routing
  if (!isObject(routing)) return undefined
  const out: GatewayRouting = {}
  for (const key of STRING_FIELDS) {
    const value = routing[key]
    if (value == null) continue
    if (typeof value !== 'string') return undefined
    out[key] = value
  }
  const { fallbacksAvailable, modelAttemptCount } = routing
  if (fallbacksAvailable != null) {
    const ok =
      Array.isArray(fallbacksAvailable) && fallbacksAvailable.every((p) => typeof p === 'string')
    if (!ok) return undefined
    out.fallbacksAvailable = fallbacksAvailable
  }
  if (modelAttemptCount != null) {
    if (typeof modelAttemptCount !== 'number') return undefined
    out.modelAttemptCount = modelAttemptCount
  }
  return out
}

export function parseGenerationId(providerMetadata: unknown): string | undefined {
  const id = gatewayOf(providerMetadata)?.generationId
  return typeof id === 'string' ? id : undefined
}
