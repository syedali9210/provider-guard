import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { consoleSink, guard, noopSink } from '../src/index'
import { fileSink } from '../src/node'
import { _resetDefaultSink, type CallRecord, defaultSink, memorySink, newId } from '../src/records'
import { mockModel, okResult } from './helpers'

const tmp = () => mkdtempSync(join(tmpdir(), 'pg-records-'))
const sample = (i: number): CallRecord => ({
  v: 1,
  id: `pg_${String(i).padStart(4, '0')}`,
  retryOf: null,
  ts: new Date(1_790_000_000_000 + i).toISOString(),
  model: 'zai/glm-5.3-flash',
  provider: 'zai',
  mode: 'stream',
  finish: 'stop',
  tokens: { in: 1, out: 6, text: 4, reasoning: 2 },
  delivered: { textChars: 5, reasoningChars: 4, toolCalls: 0 },
  reasoningRequested: null,
  flags: [],
  retry: null,
  parts: [{ t: 'finish', ms: 3 }],
  generationId: null,
  durationMs: 3,
})

afterEach(() => {
  vi.restoreAllMocks()
  _resetDefaultSink()
})

describe('fileSink', () => {
  test('appends one JSON line per record, in call order, creating the directory', async () => {
    const dir = tmp()
    const file = join(dir, 'nested', 'deeper', 'calls.jsonl')
    const sink = fileSink(file)
    const records = Array.from({ length: 50 }, (_, i) => sample(i))

    await Promise.all(records.map((r) => sink.write(r)))

    const lines = readFileSync(file, 'utf8').split('\n')
    expect(lines.at(-1)).toBe('')
    expect(lines.slice(0, -1).map((l) => JSON.parse(l).id)).toEqual(records.map((r) => r.id))
    rmSync(dir, { recursive: true, force: true })
  })

  test('a failed write rejects, and later writes still work once the cause is gone', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'blocker'), 'not a directory')
    const sink = fileSink(join(dir, 'blocker', 'calls.jsonl'))

    await expect(sink.write(sample(1))).rejects.toThrow()
    rmSync(join(dir, 'blocker'))
    await sink.write(sample(2))

    expect(readFileSync(join(dir, 'blocker', 'calls.jsonl'), 'utf8')).toContain('pg_0002')
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('default sink', () => {
  test('in Node, writes .provider-guard/calls.jsonl under the working directory', async () => {
    const dir = tmp()
    vi.spyOn(process, 'cwd').mockReturnValue(dir)
    await defaultSink().write(sample(7))
    expect(readFileSync(join(dir, '.provider-guard', 'calls.jsonl'), 'utf8')).toContain('pg_0007')
    expect(defaultSink()).toBe(defaultSink())
    rmSync(dir, { recursive: true, force: true })
  })

  test('guard() without a sink records to the default sink', async () => {
    const dir = tmp()
    vi.spyOn(process, 'cwd').mockReturnValue(dir)
    const { model } = mockModel({ generate: [okResult()] })
    await guard().wrapGenerate?.({
      doGenerate: () => model.doGenerate({ prompt: [] }),
      doStream: () => model.doStream({ prompt: [] }),
      params: { prompt: [] },
      model,
    })
    await vi.waitFor(() =>
      expect(readFileSync(join(dir, '.provider-guard', 'calls.jsonl'), 'utf8')).toContain(
        '"model":"zai/glm-5.3-flash"',
      ),
    )
    rmSync(dir, { recursive: true, force: true })
  })

  test('without process.getBuiltinModule (Edge runtimes), records stay in memory', () => {
    const original = process.getBuiltinModule
    Object.defineProperty(process, 'getBuiltinModule', { value: undefined, configurable: true })
    try {
      expect(defaultSink()).toHaveProperty('records', [])
    } finally {
      Object.defineProperty(process, 'getBuiltinModule', { value: original, configurable: true })
    }
  })
})

test('memorySink, consoleSink, and noopSink', () => {
  const memory = memorySink()
  memory.write(sample(1))
  expect(memory.records.map((r) => r.id)).toEqual(['pg_0001'])

  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  consoleSink().write(sample(2))
  expect(JSON.parse(log.mock.calls[0]?.[0])).toMatchObject({ id: 'pg_0002' })

  expect(noopSink().write(sample(3))).toBeUndefined()
})

test('newId is a pg_ ULID whose time prefix sorts by creation time', () => {
  const early = newId(1_790_000_000_000)
  const late = newId(1_790_000_000_001)
  expect(early).toMatch(/^pg_[0-9A-HJKMNP-TV-Z]{26}$/)
  expect(early.slice(0, 13) < late.slice(0, 13)).toBe(true)
  expect(newId(0).slice(3, 13)).toBe('0000000000')
  expect(newId()).not.toBe(newId())
})
