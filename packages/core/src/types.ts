// V4 types derived from the `ai` peer dependency, so published declarations only reference `ai`.
import type { LanguageModelMiddleware } from 'ai'

type WrapStreamOptions = Parameters<NonNullable<LanguageModelMiddleware['wrapStream']>>[0]

export type Middleware = LanguageModelMiddleware
export type Model = WrapStreamOptions['model']
export type CallOptions = WrapStreamOptions['params']
export type GenerateResult = Awaited<ReturnType<WrapStreamOptions['doGenerate']>>
export type StreamResult = Awaited<ReturnType<WrapStreamOptions['doStream']>>
export type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never
export type Usage = GenerateResult['usage']
export type FinishReason = GenerateResult['finishReason']['unified']
export type ReasoningLevel = NonNullable<CallOptions['reasoning']>
