import { readFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import pkg from '../package.json' with { type: 'json' }
import { errorMessage } from './log'
import { DEFAULT_RECORDS_FILE } from './records'
import { buildReport, parseDuration, parseRecords, renderReport } from './report'

export type Io = {
  stdout: { write(chunk: string): unknown; isTTY?: boolean }
  stderr: { write(chunk: string): unknown }
  env: Record<string, string | undefined>
  cwd: string
  now?: () => number
}

export const EXIT = { ok: 0, usage: 1, file: 2 } as const

const HELP = `provider-guard ${pkg.version}

Usage
  provider-guard report [--file <path>] [--model <id>] [--since <duration>] [--json]
  provider-guard studio [--file <path>] [--port <n>] [--replay <dataset>] [--no-open] [--json]
  provider-guard --help
  provider-guard --version

Commands
  report    Provider health per model from recorded calls
  studio    Open the local dashboard on 127.0.0.1

Options
  --file <path>       Records file (default: .provider-guard/calls.jsonl)
  --model <id>        Only this model, for example zai/glm-5.3-flash
  --since <duration>  Only calls newer than this, for example 15m, 1h, or 7d
  --port <n>          Studio port (default: 4747; the next 10 ports are tried if it is busy)
  --replay <dataset>  Replay published issue data: all, vercel-ai-20932, or vercel-ai-21207
  --no-open           Do not open a browser
  --json              Machine-readable output

Exit codes
  0  success
  1  usage error
  2  records file not found or unreadable
`

const OPTIONS = {
  file: { type: 'string' },
  model: { type: 'string' },
  since: { type: 'string' },
  port: { type: 'string' },
  replay: { type: 'string' },
  'no-open': { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const

const COMMAND_OPTIONS: Record<string, string[]> = {
  report: ['file', 'model', 'since', 'json'],
  studio: ['file', 'port', 'replay', 'no-open', 'json'],
}

type Values = {
  [K in keyof typeof OPTIONS]?: (typeof OPTIONS)[K]['type'] extends 'string' ? string : boolean
}

export type StudioCommand = (options: {
  file: string
  displayFile: string
  port?: number
  replay?: string
  open: boolean
  json: boolean
  io: Io
}) => Promise<number>

/** Colors only on a TTY; FORCE_COLOR wins, then NO_COLOR (https://no-color.org). */
export function colorEnabled(io: Io): boolean {
  const { FORCE_COLOR, NO_COLOR, TERM } = io.env
  if (FORCE_COLOR) return FORCE_COLOR !== '0' && FORCE_COLOR !== 'false'
  if (NO_COLOR) return false
  return Boolean(io.stdout.isTTY) && TERM !== 'dumb'
}

/** Paths are shown relative to the working directory, with forward slashes on every OS. */
export function displayPath(file: string, cwd: string): string {
  const rel = relative(cwd, file)
  return rel && !rel.startsWith('..') ? rel.split(sep).join('/') : file
}

export async function main(argv: string[], io: Io, studio?: StudioCommand): Promise<number> {
  const out = (text: string) => io.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
  let values: Values
  let positionals: string[]
  try {
    ;({ values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }))
  } catch (error) {
    return usage(io, `${errorMessage(error)}.`, argv.includes('--json'))
  }
  const json = values.json === true

  if (values.version) {
    out(json ? JSON.stringify({ version: pkg.version }) : pkg.version)
    return EXIT.ok
  }
  const [command, ...rest] = positionals
  if (values.help) {
    out(json ? JSON.stringify({ usage: HELP }) : HELP)
    return EXIT.ok
  }
  if (!command) {
    io.stderr.write(HELP)
    return EXIT.usage
  }
  const allowed = COMMAND_OPTIONS[command]
  if (!allowed) return usage(io, `Unknown command "${command}". Run provider-guard --help.`, json)
  if (rest.length > 0) return usage(io, `Unexpected argument "${rest[0]}".`, json)
  for (const key of Object.keys(values)) {
    if (!allowed.includes(key)) {
      return usage(io, `--${key} does not apply to provider-guard ${command}.`, json)
    }
  }

  const file = resolve(io.cwd, values.file ?? DEFAULT_RECORDS_FILE)
  const shown = displayPath(file, io.cwd)

  if (command === 'studio') {
    let port: number | undefined
    if (values.port !== undefined) {
      port = Number(values.port)
      if (!/^\d+$/.test(values.port) || port < 1 || port > 65535) {
        return usage(io, `--port expects a number from 1 to 65535; got "${values.port}".`, json)
      }
    }
    if (!studio) throw new Error('studio command is not available')
    return studio({
      file,
      displayFile: shown,
      port,
      replay: values.replay,
      open: values['no-open'] !== true,
      json,
      io,
    })
  }

  // report
  let since: number | undefined
  if (values.since !== undefined) {
    since = parseDuration(values.since)
    if (since === undefined) {
      return usage(
        io,
        `--since expects a duration like 15m, 1h, or 7d; got "${values.since}".`,
        json,
      )
    }
  }
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    return fileError(io, shown, error, json)
  }
  let { records, skipped } = parseRecords(text)
  if (since !== undefined) {
    const cutoff = (io.now ?? Date.now)() - since
    records = records.filter((r) => Date.parse(r.ts) >= cutoff)
  }
  if (values.model !== undefined) records = records.filter((r) => r.model === values.model)
  const models = buildReport(records)

  if (json) {
    out(
      JSON.stringify(
        {
          file: shown,
          since: values.since ?? null,
          model: values.model ?? null,
          skippedLines: skipped,
          models,
        },
        null,
        2,
      ),
    )
    return EXIT.ok
  }
  if (models.length === 0) {
    const scope = [
      values.model ? ` for ${values.model}` : '',
      values.since ? ` in the last ${values.since}` : '',
    ].join('')
    out(`No calls recorded${scope} in ${shown}. Wrap your model with guard() and make a request.`)
  } else {
    out(renderReport(models, { color: colorEnabled(io) }))
  }
  if (skipped > 0) {
    io.stderr.write(
      `Skipped ${skipped} line${skipped === 1 ? '' : 's'} in ${shown} that were not call records.\n`,
    )
  }
  return EXIT.ok
}

function usage(io: Io, message: string, json: boolean): number {
  io.stderr.write(
    json
      ? `${JSON.stringify({ error: { code: 'usage', message } })}\n`
      : `${message}\nRun provider-guard --help for usage.\n`,
  )
  return EXIT.usage
}

function fileError(io: Io, shown: string, error: unknown, json: boolean): number {
  const code = (error as NodeJS.ErrnoException).code
  const message =
    code === 'ENOENT'
      ? `No records file at ${shown}. Wrap your model with guard() and make a request, or pass --file <path>.`
      : `Could not read ${shown} (${code ?? errorMessage(error)}). Check that it is a readable file, or pass --file <path>.`
  io.stderr.write(
    json ? `${JSON.stringify({ error: { code: 'file', message } })}\n` : `${message}\n`,
  )
  return EXIT.file
}
