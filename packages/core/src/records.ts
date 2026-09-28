import type * as NodeFs from 'node:fs'
import type * as NodePath from 'node:path'
import type { FinishReason, ReasoningLevel } from './types'

export type RetryOutcome = 'recovered' | 'still-empty' | 'failed' | 'skipped'

export type SkipReason =
  | 'no-alternative-provider'
  | 'provider-list-unavailable'
  | 'unknown-provider'
  | 'not-gateway'
  | 'tool-call-emitted'
  | 'aborted'
  | 'retry-disabled'
  | 'report-only'

export type RetryInfo = {
  attempted: boolean
  provider: string | null
  outcome: RetryOutcome
  skipReason: SkipReason | null
}

/** One line of `.provider-guard/calls.jsonl`: one attempt, metadata only. */
export type CallRecord = {
  v: 1
  /** Attempt id. */
  id: string
  /** Id of the caught attempt this one retried. */
  retryOf: string | null
  ts: string
  model: string
  provider: string | null
  mode: 'generate' | 'stream'
  finish: FinishReason | null
  tokens: { in: number | null; out: number | null; text: number | null; reasoning: number | null }
  delivered: { textChars: number; reasoningChars: number; toolCalls: number }
  reasoningRequested: ReasoningLevel | null
  flags: string[]
  /** Set on caught attempts only. */
  retry: RetryInfo | null
  /** Stream only: part type and offset from the attempt start. No content. */
  parts: Array<{ t: string; ms: number }> | null
  generationId: string | null
  durationMs: number
}

export type RecordSink = { write(record: CallRecord): void | Promise<void> }

export function memorySink(): RecordSink & { records: CallRecord[] } {
  const records: CallRecord[] = []
  return {
    records,
    write(record) {
      records.push(record)
    },
  }
}

export function consoleSink(): RecordSink {
  return { write: (record) => console.log(JSON.stringify(record)) }
}

export function noopSink(): RecordSink {
  return { write() {} }
}

/** Appends JSON lines, one write at a time, so records from one process never interleave. */
export function createFileSink(fs: typeof NodeFs, path: typeof NodePath, file: string): RecordSink {
  let tail: Promise<unknown> = Promise.resolve()
  let dirReady: Promise<unknown> | undefined
  const ensureDir = () => {
    dirReady ??= fs.promises.mkdir(path.dirname(file), { recursive: true }).catch((error) => {
      dirReady = undefined
      throw error
    })
    return dirReady
  }
  return {
    write(record) {
      const line = `${JSON.stringify(record)}\n`
      const next = tail.then(async () => {
        await ensureDir()
        await fs.promises.appendFile(file, line, 'utf8')
      })
      tail = next.catch(() => {})
      return next
    },
  }
}

export const DEFAULT_RECORDS_FILE = '.provider-guard/calls.jsonl'

let fallbackSink: RecordSink | undefined

/**
 * File sink in Node, memory sink elsewhere. Uses `process.getBuiltinModule` instead of a static
 * `node:fs` import so the main entry stays loadable in Edge runtimes and bundlers.
 */
export function defaultSink(): RecordSink {
  if (fallbackSink) return fallbackSink
  if (typeof process !== 'undefined' && typeof process.getBuiltinModule === 'function') {
    const fs = process.getBuiltinModule('node:fs')
    const path = process.getBuiltinModule('node:path')
    fallbackSink = createFileSink(fs, path, path.resolve(process.cwd(), DEFAULT_RECORDS_FILE))
  } else {
    fallbackSink = memorySink()
  }
  return fallbackSink
}

/** @internal test helper */
export function _resetDefaultSink(): void {
  fallbackSink = undefined
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** `pg_` + a ULID: 10 time characters then 16 random ones, so ids sort by creation time. */
export function newId(now = Date.now()): string {
  let time = ''
  for (let i = 0, t = now; i < 10; i++, t = Math.floor(t / 32)) time = CROCKFORD[t % 32] + time
  let random = ''
  for (const byte of crypto.getRandomValues(new Uint8Array(16))) random += CROCKFORD[byte % 32]
  return `pg_${time}${random}`
}
