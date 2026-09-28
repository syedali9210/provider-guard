import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import pkg from '../package.json' with { type: 'json' }
import { colorEnabled, displayPath, EXIT, type Io, main } from '../src/cli'
import type { CallRecord } from '../src/records'
import type { ModelReport } from '../src/report'

const replayDir = join(import.meta.dirname, '..', '..', 'studio', 'replay')
const replay: CallRecord[] = ['vercel-ai-20932', 'vercel-ai-21207'].flatMap(
  (id) => JSON.parse(readFileSync(join(replayDir, `${id}.json`), 'utf8')).records,
)

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'pg-cli-'))
  mkdirSync(join(dir, '.provider-guard'))
  const lines = replay.map((r) => JSON.stringify(r)).join('\n')
  writeFileSync(join(dir, '.provider-guard', 'calls.jsonl'), `${lines}\n`)
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

async function run(
  argv: string[],
  { env = {}, tty = false, now }: { env?: Io['env']; tty?: boolean; now?: number } = {},
) {
  let stdout = ''
  let stderr = ''
  const io: Io = {
    stdout: { write: (s: string) => (stdout += s), isTTY: tty },
    stderr: { write: (s: string) => (stderr += s) },
    env,
    cwd: dir,
    ...(now === undefined ? {} : { now: () => now }),
  }
  const code = await main(argv, io)
  return { code, stdout, stderr }
}

const ESC = String.fromCharCode(27)

describe('provider-guard report on the replay dataset', () => {
  test('text output matches the committed snapshot', async () => {
    const { code, stdout, stderr } = await run(['report'])
    expect(code).toBe(EXIT.ok)
    expect(stderr).toBe('')
    expect(stdout).not.toContain(ESC)
    await expect(stdout).toMatchFileSnapshot('./__snapshots__/report-replay.txt')
  })

  test('--json output matches the committed snapshot', async () => {
    const { code, stdout } = await run(['report', '--json'])
    const parsed = JSON.parse(stdout)
    expect(code).toBe(EXIT.ok)
    expect(parsed).toMatchObject({
      file: '.provider-guard/calls.jsonl',
      since: null,
      skippedLines: 0,
    })
    await expect(`${JSON.stringify(parsed.models, null, 2)}\n`).toMatchFileSnapshot(
      './__snapshots__/report-replay.json',
    )
  })

  test('flags Baseten as the empty-rate outlier for zai/glm-5.3-flash (vercel/ai#20932)', async () => {
    const { stdout } = await run(['report', '--json'])
    const models: ModelReport[] = JSON.parse(stdout).models
    const glm = models.find((m) => m.model === 'zai/glm-5.3-flash')
    expect(glm).toMatchObject({ attempts: 88, caught: 22 })
    expect(glm?.providers.map((p) => [p.provider, p.attempts, p.empty, p.outlier])).toEqual([
      ['baseten', 51, 22, true],
      ['zai', 30, 0, false],
      ['fireworks', 7, 0, false],
    ])
    expect(glm?.providers[0]?.p).toBeLessThan(0.0001)
    const text = (await run(['report'])).stdout
    expect(text).toMatch(/^ {2}baseten +51 +22 \(43\.1%\) +100% +outlier {2}p < 0\.0001$/m)
  })

  test('shows effort appears ignored for Bedrock on openai/gpt-5.6-sol (vercel/ai#21207)', async () => {
    const { stdout } = await run(['report', '--json'])
    const models: ModelReport[] = JSON.parse(stdout).models
    const rows = models.find((m) => m.model === 'openai/gpt-5.6-sol')?.reasoning?.rows
    expect(rows?.map((r) => [r.provider, r.medians, r.effortIgnored])).toEqual(
      expect.arrayContaining([
        ['openai', { low: 1750, xhigh: 6711 }, false],
        ['bedrock', { low: 2704, xhigh: 3060 }, true],
      ]),
    )
    const text = (await run(['report'])).stdout
    expect(text).toMatch(/^ {2}bedrock +2,704 +3,060 +effort appears ignored$/m)
  })

  test('reports zai/glm-4.7 never reasoning on Baseten as report-only data', async () => {
    const { stdout } = await run(['report', '--model', 'zai/glm-4.7', '--json'])
    const [glm47] = JSON.parse(stdout).models as ModelReport[]
    expect(glm47?.providers.map((p) => [p.provider, p.attempts, p.reasoned, p.outlier])).toEqual([
      ['baseten', 40, 0, false],
      ['zai', 26, 20, false],
    ])
  })
})

describe('report filters', () => {
  test('--model keeps one model', async () => {
    const { stdout } = await run(['report', '--model', 'openai/gpt-5.6-sol'])
    expect(stdout.startsWith('openai/gpt-5.6-sol')).toBe(true)
    expect(stdout).not.toContain('zai/')
  })

  test('--since keeps recent calls only', async () => {
    const now = Date.parse('2026-09-20T15:00:00.000Z')
    const { stdout } = await run(['report', '--since', '1d', '--json'], { now })
    expect(JSON.parse(stdout).models.map((m: ModelReport) => m.model)).toEqual([
      'openai/gpt-5.6-sol',
    ])
  })

  test('an empty result says so and exits 0', async () => {
    const { code, stdout } = await run(['report', '--model', 'nope/none', '--since', '15m'])
    expect(code).toBe(EXIT.ok)
    expect(stdout).toBe(
      'No calls recorded for nope/none in the last 15m in .provider-guard/calls.jsonl. Wrap your model with guard() and make a request.\n',
    )
  })

  test('lines that are not records are skipped and counted', async () => {
    const file = join(dir, 'mixed.jsonl')
    writeFileSync(file, `${JSON.stringify(replay[0])}\nnot json\n`)
    const { code, stdout, stderr } = await run(['report', '--file', 'mixed.jsonl'])
    expect(code).toBe(EXIT.ok)
    expect(stdout).toContain('zai/')
    expect(stderr).toBe('Skipped 1 line in mixed.jsonl that were not call records.\n')
  })
})

describe('colors', () => {
  test('on a TTY by default', async () => {
    expect((await run(['report'], { tty: true })).stdout).toContain(ESC)
  })
  test('never with NO_COLOR', async () => {
    expect((await run(['report'], { tty: true, env: { NO_COLOR: '1' } })).stdout).not.toContain(ESC)
  })
  test('with FORCE_COLOR even when piped', async () => {
    expect((await run(['report'], { env: { FORCE_COLOR: '1' } })).stdout).toContain(ESC)
  })
  test('FORCE_COLOR=0 disables and TERM=dumb disables', () => {
    const io = (env: Io['env']): Io => ({
      stdout: { write: () => true, isTTY: true },
      stderr: { write: () => true },
      env,
      cwd: dir,
    })
    expect(colorEnabled(io({ FORCE_COLOR: '0' }))).toBe(false)
    expect(colorEnabled(io({ TERM: 'dumb' }))).toBe(false)
    expect(colorEnabled(io({ NO_COLOR: '' }))).toBe(true)
  })
})

describe('exit codes and usage', () => {
  test('--version prints the package version', async () => {
    expect(await run(['--version'])).toEqual({ code: 0, stdout: `${pkg.version}\n`, stderr: '' })
    expect(JSON.parse((await run(['--version', '--json'])).stdout)).toEqual({
      version: pkg.version,
    })
  })

  test('--help prints usage and exits 0; no command prints usage and exits 1', async () => {
    const help = await run(['--help'])
    expect(help.code).toBe(0)
    expect(help.stdout).toContain('provider-guard report [--file <path>]')
    const bare = await run([])
    expect(bare.code).toBe(EXIT.usage)
    expect(bare.stderr).toContain('Usage')
  })

  test.each([
    [['frobnicate'], 'Unknown command "frobnicate". Run provider-guard --help.'],
    [['report', '--wat'], "Unknown option '--wat'"],
    [['report', '--since', 'soon'], '--since expects a duration like 15m, 1h, or 7d; got "soon".'],
    [['report', '--port', '1'], '--port does not apply to provider-guard report.'],
    [['report', 'extra'], 'Unexpected argument "extra".'],
    [['studio', '--port', '70000'], '--port expects a number from 1 to 65535; got "70000".'],
  ])('%j is a usage error (exit 1)', async (argv, message) => {
    const { code, stderr } = await run(argv)
    expect(code).toBe(EXIT.usage)
    expect(stderr).toContain(message)
  })

  test('a missing records file exits 2 and says how to fix it', async () => {
    const { code, stderr } = await run(['report', '--file', 'missing.jsonl'])
    expect(code).toBe(EXIT.file)
    expect(stderr).toBe(
      'No records file at missing.jsonl. Wrap your model with guard() and make a request, or pass --file <path>.\n',
    )
  })

  test('an unreadable records file exits 2', async () => {
    const { code, stderr } = await run(['report', '--file', '.provider-guard'])
    expect(code).toBe(EXIT.file)
    expect(stderr).toMatch(
      /^Could not read \.provider-guard \(E[A-Z]+\)\. Check that it is a readable file/,
    )
  })

  test('errors are JSON with --json', async () => {
    const { code, stderr } = await run(['report', '--file', 'missing.jsonl', '--json'])
    expect(code).toBe(EXIT.file)
    expect(JSON.parse(stderr)).toMatchObject({ error: { code: 'file' } })
    const usage = await run(['report', '--since', 'x', '--json'])
    expect(JSON.parse(usage.stderr)).toMatchObject({ error: { code: 'usage' } })
  })
})

test('displayPath is relative with forward slashes inside cwd, absolute outside', () => {
  expect(displayPath(join(dir, '.provider-guard', 'calls.jsonl'), dir)).toBe(
    '.provider-guard/calls.jsonl',
  )
  expect(displayPath(join(tmpdir(), 'elsewhere.jsonl'), dir)).toBe(
    join(tmpdir(), 'elsewhere.jsonl'),
  )
})
