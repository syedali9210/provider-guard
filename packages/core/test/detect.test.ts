import { describe, expect, test } from 'vitest'
import {
  billedButEmpty,
  type CallSummary,
  createDelivery,
  parseGenerationId,
  parseRouting,
  summarizeUsage,
} from '../src/detect'

const emptyCall: CallSummary = {
  modelId: 'zai/glm-5.3-flash',
  mode: 'stream',
  finishReason: 'stop',
  usage: { inputTokens: 1830, outputTokens: 6, textTokens: 4, reasoningTokens: 2 },
  delivered: { textChars: 0, reasoningChars: 4, toolCalls: 0 },
}

describe('billedButEmpty', () => {
  test('fires on the vercel/ai#20932 shape and asks for a retry', () => {
    expect(billedButEmpty(emptyCall)).toEqual({
      id: 'billed-but-empty',
      reason: 'Finished "stop" with 4 text tokens billed but no text or tool calls delivered',
      retry: true,
    })
  })

  test('uses the singular for one token', () => {
    const one = { ...emptyCall, usage: { ...emptyCall.usage, textTokens: 1 } }
    expect(billedButEmpty(one)?.reason).toContain('1 text token billed')
  })

  test.each<[string, Partial<CallSummary>]>([
    ['the finish reason is not stop', { finishReason: 'length' }],
    ['there is no finish reason', { finishReason: undefined }],
    ['no text tokens were billed', { usage: { ...emptyCall.usage, textTokens: 0 } }],
    ['text tokens are unknown', { usage: { ...emptyCall.usage, textTokens: undefined } }],
    ['text was delivered', { delivered: { ...emptyCall.delivered, textChars: 5 } }],
    ['a tool call was delivered', { delivered: { ...emptyCall.delivered, toolCalls: 1 } }],
  ])('does not fire when %s', (_label, patch) => {
    expect(billedButEmpty({ ...emptyCall, ...patch })).toBeNull()
  })
})

describe('summarizeUsage', () => {
  const usage = (text?: number, total?: number, reasoning?: number) => ({
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total, text, reasoning },
  })

  test('prefers the reported text tokens', () => {
    expect(summarizeUsage(usage(4, 6, 2))).toEqual({
      inputTokens: 10,
      outputTokens: 6,
      textTokens: 4,
      reasoningTokens: 2,
    })
  })

  test('derives text tokens as total minus reasoning when text is missing', () => {
    expect(summarizeUsage(usage(undefined, 6, 2)).textTokens).toBe(4)
  })

  test('leaves text tokens unknown when reasoning is not reported', () => {
    expect(summarizeUsage(usage(undefined, 6, undefined)).textTokens).toBeUndefined()
  })
})

describe('createDelivery', () => {
  test('trims leading and trailing whitespace across deltas without keeping content', () => {
    const d = createDelivery(true)
    for (const delta of ['  ', '\n', ' hi', ' there ', '\n ']) d.text(delta)
    expect(d.result().textChars).toBe('hi there'.length)
  })

  test('counts whitespace-only text as zero when trimming', () => {
    const d = createDelivery(true)
    d.text(' \n\t ')
    expect(d.result().textChars).toBe(0)
  })

  test('counts every character when not trimming', () => {
    const d = createDelivery(false)
    d.text(' \n\t ')
    d.reasoning('abc')
    d.reasoning('de')
    d.toolCall()
    expect(d.result()).toEqual({ textChars: 4, reasoningChars: 5, toolCalls: 1 })
  })
})

describe('parseRouting', () => {
  const meta = (routing: unknown) => ({ gateway: { routing } })

  test('reads the fields observed in public issues and ignores unknown ones', () => {
    expect(
      parseRouting(
        meta({
          finalProvider: 'baseten',
          fallbacksAvailable: ['baseten', 'zai'],
          originalModelId: 'zai/glm-5.3-flash',
          resolvedProvider: 'baseten',
          modelAttemptCount: 1,
          planningReasoning: 'planned',
          somethingNew: { nested: true },
          attempts: null,
        }),
      ),
    ).toEqual({
      finalProvider: 'baseten',
      fallbacksAvailable: ['baseten', 'zai'],
      originalModelId: 'zai/glm-5.3-flash',
      resolvedProvider: 'baseten',
      modelAttemptCount: 1,
      planningReasoning: 'planned',
    })
  })

  test('treats null fields as absent', () => {
    expect(parseRouting(meta({ finalProvider: 'zai', planningReasoning: null }))).toEqual({
      finalProvider: 'zai',
    })
  })

  test.each([
    ['no metadata', undefined],
    ['no gateway key', { openai: {} }],
    ['gateway is not an object', { gateway: 'x' }],
    ['routing is an array', meta([])],
    ['finalProvider is a number', meta({ finalProvider: 1 })],
    ['fallbacksAvailable is not a string array', meta({ fallbacksAvailable: ['a', 2] })],
    ['modelAttemptCount is a string', meta({ modelAttemptCount: '1' })],
  ])('returns undefined when %s', (_label, value) => {
    expect(parseRouting(value)).toBeUndefined()
  })
})

test('parseGenerationId reads gateway.generationId only when it is a string', () => {
  expect(parseGenerationId({ gateway: { generationId: 'gen_1' } })).toBe('gen_1')
  expect(parseGenerationId({ gateway: { generationId: 1 } })).toBeUndefined()
  expect(parseGenerationId(undefined)).toBeUndefined()
})
