import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { convertReadableStreamToArray, MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { type GuardOptions, guard, memorySink } from '../src/index'
import type { CallOptions, GenerateResult, StreamPart } from '../src/types'

const fixturesDir = join(import.meta.dirname, '..', '..', '..', 'fixtures')
const load = (name: string) => JSON.parse(readFileSync(join(fixturesDir, name), 'utf8'))

// Each call reads the file again, so tests never share mutable fixture objects.
export const emptyResult = (): GenerateResult => load('20932-generate-baseten-empty.json').result
export const okResult = (): GenerateResult => load('20932-generate-zai-ok.json').result
export const emptyParts = (): StreamPart[] => load('20932-stream-baseten-empty.json').parts
export const okParts = (): StreamPart[] => load('20932-stream-zai-ok.json').parts
export const endpointsFixture = () => load('endpoints-zai-glm-5.3-flash.json')

type WithMetadata = { providerMetadata?: GenerateResult['providerMetadata'] }

/** Replaces `providerMetadata.gateway.routing`; `undefined` removes it. */
export function withRouting<T extends WithMetadata>(target: T, routing: unknown): T {
  const gateway: Record<string, unknown> = { ...target.providerMetadata?.gateway }
  if (routing === undefined) delete gateway.routing
  else gateway.routing = routing
  return { ...target, providerMetadata: { ...target.providerMetadata, gateway } } as T
}

export function partsWithRouting(parts: StreamPart[], routing: unknown): StreamPart[] {
  return parts.map((p) => (p.type === 'finish' ? withRouting(p, routing) : p))
}

export function withText(result: GenerateResult, text: string): GenerateResult {
  return {
    ...result,
    content: [...result.content.filter((c) => c.type !== 'text'), { type: 'text', text }],
  }
}

type Scripted<T> = Array<T | Error>

type StreamScript = StreamPart[] | ReadableStream<StreamPart>

/** A gateway-like mock that returns scripted responses in order and records every call. */
export function mockModel(
  opts: {
    generate?: Scripted<GenerateResult>
    stream?: Scripted<StreamScript>
    provider?: string
    modelId?: string
    chunkDelayInMs?: number | null
  } = {},
) {
  const calls: CallOptions[] = []
  const next = <T>(script: Scripted<T> | undefined): T => {
    const value = script?.[calls.length - 1]
    if (value === undefined) throw new Error(`unexpected model call #${calls.length}`)
    if (value instanceof Error) throw value
    return value
  }
  const model = new MockLanguageModelV4({
    provider: opts.provider ?? 'gateway',
    modelId: opts.modelId ?? 'zai/glm-5.3-flash',
    doGenerate: async (options) => {
      calls.push(options)
      return next(opts.generate)
    },
    doStream: async (options) => {
      calls.push(options)
      const chunks = next(opts.stream)
      if (chunks instanceof ReadableStream) return { stream: chunks }
      return {
        stream: simulateReadableStream({ chunks, chunkDelayInMs: opts.chunkDelayInMs ?? null }),
      }
    },
  })
  return { model, calls }
}

/** Invokes guard().wrapGenerate directly, the way wrapLanguageModel does. */
export async function callGenerate(
  options: GuardOptions,
  script: Scripted<GenerateResult>,
  params: Partial<CallOptions> = {},
  modelOptions: { provider?: string } = {},
) {
  const sink = memorySink()
  const { model, calls } = mockModel({ generate: script, ...modelOptions })
  const full = { prompt: [], ...params } as CallOptions
  const middleware = guard({ sink, ...options })
  const out = await middleware.wrapGenerate?.({
    doGenerate: () => model.doGenerate(full),
    doStream: () => model.doStream(full),
    params: full,
    model,
  })
  return { out, sink, calls }
}

/** Invokes guard().wrapStream directly and returns the (unread) guarded stream. */
export async function openStream(
  options: GuardOptions,
  script: Scripted<StreamScript>,
  params: Partial<CallOptions> = {},
  modelOptions: { provider?: string } = {},
) {
  const sink = memorySink()
  const { model, calls } = mockModel({ stream: script, ...modelOptions })
  const full = { prompt: [], ...params } as CallOptions
  const middleware = guard({ sink, ...options })
  const result = await middleware.wrapStream?.({
    doGenerate: () => model.doGenerate(full),
    doStream: () => model.doStream(full),
    params: full,
    model,
  })
  if (!result) throw new Error('guard() returned no wrapStream')
  return { stream: result.stream, sink, calls }
}

/** Like openStream, but reads every part. */
export async function callStream(...args: Parameters<typeof openStream>) {
  const { stream, sink, calls } = await openStream(...args)
  const parts = await convertReadableStreamToArray(stream)
  return { parts, sink, calls }
}

/** A stream the test drives by hand, to observe exactly when parts reach the consumer. */
export function manualStream() {
  let controller!: ReadableStreamDefaultController<StreamPart>
  const stream = new ReadableStream<StreamPart>({
    start(c) {
      controller = c
    },
  })
  return {
    stream,
    push: (...parts: StreamPart[]) => {
      for (const p of parts) controller.enqueue(p)
    },
    close: () => controller.close(),
    error: (e: unknown) => controller.error(e),
  }
}

/** Rejects if `promise` does not settle within `ms`, so a hang fails loudly instead of timing out. */
export function within<T>(promise: Promise<T>, ms = 200, label = 'operation'): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms),
    ),
  ])
}

export const types = (parts: StreamPart[]) => parts.map((p) => p.type)

export const gatewayOf = (call: CallOptions | undefined) => call?.providerOptions?.gateway
