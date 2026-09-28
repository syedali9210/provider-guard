import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Io } from '../src/cli'
import type { CallRecord } from '../src/records'
import { createStudioCommand, startStudio, tailRecords } from '../src/studio'

const record = (id: string, fields: Partial<CallRecord> = {}): CallRecord => ({
  v: 1,
  id,
  retryOf: null,
  ts: '2026-09-28T10:00:00.000Z',
  model: 'zai/glm-5.3-flash',
  provider: 'baseten',
  mode: 'stream',
  finish: 'stop',
  tokens: { in: 1830, out: 6, text: 4, reasoning: 2 },
  delivered: { textChars: 0, reasoningChars: 4, toolCalls: 0 },
  reasoningRequested: null,
  flags: ['billed-but-empty'],
  retry: null,
  parts: [{ t: 'finish', ms: 301 }],
  generationId: null,
  durationMs: 301,
  ...fields,
})
const line = (r: CallRecord) => `${JSON.stringify(r)}\n`

let dir: string
let assetsDir: string
let file: string
const cleanups: Array<() => unknown> = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pg-studio-'))
  assetsDir = join(dir, 'studio')
  mkdirSync(join(assetsDir, 'assets'), { recursive: true })
  writeFileSync(join(assetsDir, 'index.html'), '<!doctype html><title>Studio</title>')
  writeFileSync(join(assetsDir, 'assets', 'app-abc123.js'), 'console.log(1)')
  writeFileSync(join(dir, 'secret.txt'), 'do not serve')
  file = join(dir, 'calls.jsonl')
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  rmSync(dir, { recursive: true, force: true })
})

async function start(options: { replay?: string; port?: number } = {}) {
  const studio = await startStudio({
    file,
    displayFile: 'calls.jsonl',
    assetsDir,
    port: 0,
    ...options,
  })
  cleanups.push(studio.close)
  return studio
}

/** Reads `event: record` messages from the SSE endpoint. */
async function subscribe(url: string) {
  const controller = new AbortController()
  cleanups.push(() => controller.abort())
  const res = await fetch(`${url}/api/stream`, { signal: controller.signal })
  expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
  const reader = (res.body as ReadableStream<Uint8Array>)
    .pipeThrough(new TextDecoderStream())
    .getReader()
  let buffer = ''
  return async function next(timeoutMs = 3000): Promise<CallRecord> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const end = buffer.indexOf('\n\n')
      if (end !== -1) {
        const event = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const data = event.split('\n').find((l) => l.startsWith('data: '))
        if (event.startsWith('event: record') && data) return JSON.parse(data.slice(6))
        continue
      }
      if (Date.now() > deadline) throw new Error('no SSE record arrived in time')
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('SSE timeout')), timeoutMs),
        ),
      ])
      if (chunk.done) throw new Error('SSE stream ended')
      buffer += chunk.value
    }
  }
}

describe('tailRecords', () => {
  test('reports only complete lines appended after it starts, across partial writes', async () => {
    writeFileSync(file, line(record('old')))
    const seen: string[] = []
    const tail = tailRecords(file, (rs) => seen.push(...rs.map((r) => r.id)))
    cleanups.push(tail.close)
    await tail.ready

    const next = line(record('new-1'))
    appendFileSync(file, next.slice(0, 40))
    await tail.check()
    expect(seen).toEqual([])

    appendFileSync(file, next.slice(40) + line(record('new-2')))
    await tail.check()
    expect(seen).toEqual(['new-1', 'new-2'])
  })

  test('decodes a multi-byte character split across two writes', async () => {
    const seen: CallRecord[] = []
    const tail = tailRecords(file, (rs) => seen.push(...rs))
    cleanups.push(tail.close)
    await tail.ready
    const bytes = Buffer.from(line(record('utf8', { provider: 'prövider' })))
    const split = bytes.indexOf(Buffer.from('ö')) + 1 // inside the two-byte ö

    appendFileSync(file, bytes.subarray(0, split))
    await tail.check()
    appendFileSync(file, bytes.subarray(split))
    await tail.check()

    expect(seen.map((r) => r.provider)).toEqual(['prövider'])
  })

  test('starts over when the file is truncated, and waits for a missing file', async () => {
    const seen: string[] = []
    const tail = tailRecords(file, (rs) => seen.push(...rs.map((r) => r.id)))
    cleanups.push(tail.close)
    await tail.ready
    await tail.check() // file does not exist yet

    writeFileSync(file, line(record('a')) + line(record('b')))
    await tail.check()
    writeFileSync(file, line(record('c'))) // shorter: truncated and rewritten
    await tail.check()

    expect(seen).toEqual(['a', 'b', 'c'])
  })

  test('picks up appends through the watchers without an explicit check', async () => {
    writeFileSync(file, '')
    const seen: string[] = []
    const tail = tailRecords(file, (rs) => seen.push(...rs.map((r) => r.id)), { intervalMs: 50 })
    cleanups.push(tail.close)
    await tail.ready
    appendFileSync(file, line(record('watched')))
    await vi.waitFor(() => expect(seen).toEqual(['watched']), { timeout: 3000 })
  })
})

describe('studio server', () => {
  test('/api/config describes the live data source', async () => {
    const { url } = await start()
    expect(await (await fetch(`${url}/api/config`)).json()).toEqual({
      mode: 'live',
      file: 'calls.jsonl',
      dataset: null,
    })
  })

  test('/api/records returns records, filtered by since', async () => {
    writeFileSync(
      file,
      line(record('early', { ts: '2026-09-28T09:00:00.000Z' })) +
        'not json\n' +
        line(record('late', { ts: '2026-09-28T11:00:00.000Z' })),
    )
    const { url } = await start()
    const all: CallRecord[] = await (await fetch(`${url}/api/records`)).json()
    expect(all.map((r) => r.id)).toEqual(['early', 'late'])
    const recent: CallRecord[] = await (
      await fetch(`${url}/api/records?since=2026-09-28T10:00:00.000Z`)
    ).json()
    expect(recent.map((r) => r.id)).toEqual(['late'])
    const bad = await fetch(`${url}/api/records?since=yesterday`)
    expect(bad.status).toBe(400)
  })

  test('a missing records file is an empty list, not an error', async () => {
    const { url } = await start()
    const res = await fetch(`${url}/api/records`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  test('an unreadable records file is a 500 that names the path and the fix', async () => {
    mkdirSync(file) // a directory where the file should be
    const { url } = await start()
    const res = await fetch(`${url}/api/records`)
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toMatchObject({ code: 'unreadable', path: 'calls.jsonl' })
    expect(body.error.message).toContain('provider-guard studio --file <path>')
  })

  test('/api/stream delivers appended records as server-sent events', async () => {
    writeFileSync(file, line(record('before')))
    const { url } = await start()
    const next = await subscribe(url)

    const appended = line(record('first'))
    appendFileSync(file, appended.slice(0, 30))
    appendFileSync(file, appended.slice(30) + line(record('second')))

    expect((await next()).id).toBe('first')
    expect((await next()).id).toBe('second')
  })

  test('serves the app, its assets, and the SPA fallback, and nothing outside', async () => {
    const { url } = await start()
    const home = await fetch(url)
    expect(home.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(home.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(await home.text()).toContain('<title>Studio</title>')

    const asset = await fetch(`${url}/assets/app-abc123.js`)
    expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(asset.headers.get('cache-control')).toContain('immutable')

    expect(await (await fetch(`${url}/providers`)).text()).toContain('<title>Studio</title>')
    expect((await fetch(`${url}/missing.js`)).status).toBe(404)
    expect((await fetch(`${url}/..%2fsecret.txt`)).status).toBe(404)
    expect((await fetch(`${url}/%E0%A4%A`)).status).toBe(400)
  })

  test('is read-only', async () => {
    const { url } = await start()
    const res = await fetch(`${url}/api/records`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('GET, HEAD')
  })

  test('rejects requests whose Host header is not the loopback address it serves', async () => {
    const { port } = await start()
    const status = await new Promise<number>((resolve, reject) => {
      request(
        { host: '127.0.0.1', port, path: '/api/records', headers: { host: 'evil.test' } },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        },
      )
        .on('error', reject)
        .end()
    })
    expect(status).toBe(403)
  })

  test('moves to the next port when the requested one is busy', async () => {
    const blocker = createServer()
    await new Promise<void>((ok) => blocker.listen(0, '127.0.0.1', ok))
    cleanups.push(() => new Promise((ok) => blocker.close(ok)))
    const busy = (blocker.address() as { port: number }).port

    const studio = await start({ port: busy })
    expect(studio.port).toBe(busy + 1)
  })

  test('replay mode serves config only, never the records file', async () => {
    writeFileSync(file, line(record('private')))
    const { url } = await start({ replay: 'all' })
    expect(await (await fetch(`${url}/api/config`)).json()).toEqual({
      mode: 'replay',
      file: null,
      dataset: 'all',
    })
    expect(await (await fetch(`${url}/api/records`)).json()).toEqual([])
  })
})

describe('studio command', () => {
  function io() {
    const out = { stdout: '', stderr: '' }
    const value: Io = {
      stdout: { write: (s: string) => (out.stdout += s) },
      stderr: { write: (s: string) => (out.stderr += s) },
      env: {},
      cwd: dir,
    }
    return { out, value }
  }
  const base = () => ({ file, displayFile: 'calls.jsonl', port: 0, open: true, json: false })
  const onStart = (studio: { close: () => Promise<void> }) => cleanups.push(studio.close)

  test('starts, prints where, and opens the browser', async () => {
    const opened: string[] = []
    const { out, value } = io()
    const command = createStudioCommand({ assetsDir, openBrowser: (u) => opened.push(u), onStart })

    const code = await command({ ...base(), io: value })

    expect(code).toBe(0)
    expect(out.stdout).toMatch(
      /^Studio is running at http:\/\/127\.0\.0\.1:\d+\nLive · calls\.jsonl\nPress Ctrl\+C to stop\.\n$/,
    )
    expect(opened).toEqual([out.stdout.split('\n')[0]?.replace('Studio is running at ', '')])
  })

  test('--json and --no-open', async () => {
    const opened: string[] = []
    const { out, value } = io()
    const command = createStudioCommand({ assetsDir, openBrowser: (u) => opened.push(u), onStart })
    await command({ ...base(), open: false, json: true, replay: 'vercel-ai-20932', io: value })
    expect(JSON.parse(out.stdout)).toMatchObject({
      mode: 'replay',
      dataset: 'vercel-ai-20932',
      file: null,
    })
    expect(opened).toHaveLength(0)
  })

  test('rejects an unknown dataset and a missing Studio build', async () => {
    const { out, value } = io()
    expect(await createStudioCommand({ assetsDir })({ ...base(), replay: 'nope', io: value })).toBe(
      1,
    )
    expect(out.stderr).toContain('Unknown replay dataset "nope"')
    expect(
      await createStudioCommand({ assetsDir: join(dir, 'nowhere') })({ ...base(), io: value }),
    ).toBe(1)
    expect(out.stderr).toContain('Studio files are missing')
  })
})
