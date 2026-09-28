// `provider-guard studio`: a read-only local server for the Studio UI. Node only.
import { spawn } from 'node:child_process'
import { existsSync, type FSWatcher, unwatchFile, watch, watchFile } from 'node:fs'
import { open, readFile, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXIT, type StudioCommand } from './cli'
import { errorMessage } from './log'
import type { CallRecord } from './records'
import { parseRecords } from './report'

export const DEFAULT_PORT = 4747
export const REPLAY_DATASETS = ['all', 'vercel-ai-20932', 'vercel-ai-21207'] as const
const HOST = '127.0.0.1'
const PORT_ATTEMPTS = 11 // the requested port plus the next 10

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'",
}

/**
 * Follows a JSONL file by byte offset and reports only newly appended, complete records.
 * A partial trailing line waits for its newline. Uses fs.watch for speed plus fs.watchFile
 * polling, because fs.watch alone is unreliable on Windows and network drives.
 */
export function tailRecords(
  file: string,
  onRecords: (records: CallRecord[]) => void,
  { intervalMs = 500, fromStart = false } = {},
) {
  let offset = -1 // -1: start at the current end of the file (or 0 if it does not exist yet)
  let remainder = Buffer.alloc(0)
  let running: Promise<void> | undefined
  let pending = false
  let watcher: FSWatcher | undefined
  let closed = false

  async function readNew() {
    let size = 0
    try {
      size = (await stat(file)).size
    } catch {
      size = 0
    }
    if (offset === -1) offset = fromStart ? 0 : size
    if (size < offset) {
      // Truncated or replaced: start over from the beginning.
      offset = 0
      remainder = Buffer.alloc(0)
    }
    if (size === offset) return
    const handle = await open(file, 'r')
    try {
      const buffer = Buffer.alloc(size - offset)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      offset += bytesRead
      const chunk = Buffer.concat([remainder, buffer.subarray(0, bytesRead)])
      // Split on the newline byte; it never occurs inside a multi-byte UTF-8 sequence.
      const cut = chunk.lastIndexOf(0x0a)
      remainder = cut === -1 ? chunk : chunk.subarray(cut + 1)
      if (cut === -1) return
      const { records } = parseRecords(chunk.subarray(0, cut).toString('utf8'))
      if (records.length > 0 && !closed) onRecords(records)
    } finally {
      await handle.close()
    }
  }

  /** Reads anything new. Concurrent calls coalesce into one extra pass. */
  function check(): Promise<void> {
    if (running) {
      pending = true
      return running
    }
    running = (async () => {
      do {
        pending = false
        try {
          await readNew()
        } catch {
          // The file may be mid-rotation or briefly locked on Windows; the next tick retries.
        }
        attachWatcher()
      } while (pending && !closed)
    })().finally(() => {
      running = undefined
    })
    return running
  }

  function attachWatcher() {
    if (watcher || closed || !existsSync(file)) return
    try {
      watcher = watch(file, () => void check())
      watcher.on('error', () => {
        watcher?.close()
        watcher = undefined
      })
    } catch {
      watcher = undefined
    }
  }

  const poll = () => void check()
  watchFile(file, { interval: intervalMs, persistent: false }, poll)
  const ready = check()

  return {
    ready,
    check,
    close() {
      closed = true
      watcher?.close()
      unwatchFile(file, poll)
    },
  }
}

export type StudioServerOptions = {
  file: string
  displayFile: string
  assetsDir: string
  port?: number
  replay?: string
}

export async function startStudio(options: StudioServerOptions) {
  const mode = options.replay ? 'replay' : 'live'
  const clients = new Set<ServerResponse>()
  const tail =
    mode === 'live'
      ? tailRecords(options.file, (records) => {
          const events = records
            .map((r) => `event: record\ndata: ${JSON.stringify(r)}\n\n`)
            .join('')
          for (const client of clients) client.write(events)
        })
      : undefined
  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(': ping\n\n')
  }, 15_000)
  heartbeat.unref()

  let port = options.port ?? DEFAULT_PORT
  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent)
        sendJson(res, 500, { error: { code: 'internal', message: errorMessage(error) } })
      else res.end()
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse) {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value)
    // Bound to 127.0.0.1 and checked by Host header, so a DNS-rebinding page cannot read records.
    const host = req.headers.host ?? ''
    if (host !== `${HOST}:${port}` && host !== `localhost:${port}`) {
      return sendJson(res, 403, {
        error: { code: 'forbidden-host', message: 'Use the URL printed by provider-guard studio.' },
      })
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD')
      return sendJson(res, 405, { error: { code: 'read-only', message: 'Studio is read-only.' } })
    }
    const url = new URL(req.url ?? '/', `http://${HOST}`)

    if (url.pathname === '/api/config') {
      return sendJson(res, 200, {
        mode,
        file: mode === 'live' ? options.displayFile : null,
        dataset: options.replay ?? null,
      })
    }
    if (url.pathname === '/api/records') {
      const since = url.searchParams.get('since')
      const cutoff = since ? Date.parse(since) : Number.NaN
      if (since && Number.isNaN(cutoff)) {
        return sendJson(res, 400, {
          error: { code: 'bad-since', message: `"since" must be an ISO date; got "${since}".` },
        })
      }
      if (mode === 'replay') return sendJson(res, 200, [])
      let text = ''
      try {
        text = await readFile(options.file, 'utf8')
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') {
          return sendJson(res, 500, {
            error: {
              code: 'unreadable',
              path: options.displayFile,
              message: `Could not read ${options.displayFile} (${code ?? errorMessage(error)}). Check that it is a readable file, then restart with provider-guard studio --file <path>.`,
            },
          })
        }
      }
      const { records } = parseRecords(text)
      return sendJson(
        res,
        200,
        Number.isNaN(cutoff) ? records : records.filter((r) => Date.parse(r.ts) >= cutoff),
      )
    }
    if (url.pathname === '/api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      })
      res.write('retry: 2000\n\n')
      clients.add(res)
      req.on('close', () => clients.delete(res))
      // Pick up anything appended since the last poll right away.
      void tail?.check()
      return
    }
    return serveAsset(url.pathname, res)
  }

  async function serveAsset(pathname: string, res: ServerResponse) {
    const root = resolve(options.assetsDir)
    let decoded: string
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      return sendText(res, 400, 'Bad request')
    }
    const target = resolve(join(root, decoded))
    if (target !== root && !target.startsWith(root + sep)) return sendText(res, 404, 'Not found')
    let file = target
    const info = await stat(file).catch(() => undefined)
    if (!info?.isFile()) {
      // Unknown asset paths 404; everything else is the single-page app.
      if (extname(decoded)) return sendText(res, 404, 'Not found')
      file = join(root, 'index.html')
    }
    const body = await readFile(file)
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': file.includes(`${sep}assets${sep}`)
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    })
    res.end(body)
  }

  // Default port 4747; if busy, try the next 10.
  for (let attempt = 0; ; attempt++) {
    try {
      await listen(server, port)
      port = (server.address() as AddressInfo).port // resolves port 0 to the one assigned
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || attempt === PORT_ATTEMPTS - 1) {
        clearInterval(heartbeat)
        tail?.close()
        throw error
      }
      port++
    }
  }
  await tail?.ready

  return {
    url: `http://${HOST}:${port}`,
    port,
    mode,
    close: () =>
      new Promise<void>((done) => {
        clearInterval(heartbeat)
        tail?.close()
        for (const client of clients) client.end()
        server.close(() => done())
      }),
  }
}

function listen(server: Server, port: number) {
  return new Promise<void>((ok, fail) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      fail(error)
    }
    const onListening = () => {
      server.off('error', onError)
      ok()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, HOST)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': TYPES['.json'] as string, 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function sendText(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { 'content-type': TYPES['.txt'] as string })
  res.end(body)
}

export function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]]
  const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true })
  child.on('error', () => {})
  child.unref()
}

export function createStudioCommand({
  assetsDir = fileURLToPath(new URL('./studio/', import.meta.url)),
  openBrowser = openInBrowser,
  onStart,
}: {
  assetsDir?: string
  openBrowser?: (url: string) => void
  onStart?: (studio: Awaited<ReturnType<typeof startStudio>>) => void
} = {}): StudioCommand {
  return async ({ file, displayFile, port, replay, open, json, io }) => {
    const fail = (message: string) => {
      io.stderr.write(
        json ? `${JSON.stringify({ error: { code: 'usage', message } })}\n` : `${message}\n`,
      )
      return EXIT.usage
    }
    if (replay !== undefined && !(REPLAY_DATASETS as readonly string[]).includes(replay)) {
      return fail(`Unknown replay dataset "${replay}". Use one of: ${REPLAY_DATASETS.join(', ')}.`)
    }
    if (!existsSync(join(assetsDir, 'index.html'))) {
      return fail(
        `Studio files are missing from this install (${assetsDir}). Reinstall provider-guard.`,
      )
    }
    let studio: Awaited<ReturnType<typeof startStudio>>
    try {
      studio = await startStudio({ file, displayFile, assetsDir, port, replay })
    } catch (error) {
      const first = port ?? DEFAULT_PORT
      return fail(
        (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
          ? `Ports ${first}–${first + PORT_ATTEMPTS - 1} are all in use. Pass --port <n> to pick another.`
          : `Could not start Studio: ${errorMessage(error)}`,
      )
    }
    onStart?.(studio)
    const source = replay ? `Replay · ${replay}` : `Live · ${displayFile}`
    io.stdout.write(
      json
        ? `${JSON.stringify({ url: studio.url, port: studio.port, mode: studio.mode, file: replay ? null : displayFile, dataset: replay ?? null })}\n`
        : `Studio is running at ${studio.url}\n${source}\nPress Ctrl+C to stop.\n`,
    )
    if (open) openBrowser(studio.url)
    return EXIT.ok
  }
}
