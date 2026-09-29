// Records one real AI Gateway call to confirm where routing metadata lives (NOTES.md, M1 open item).
//
//   AI_GATEWAY_API_KEY=... pnpm exec tsx scripts/live-repro.ts [model] [provider]
//
// This makes billed AI Gateway calls, so it refuses to run without an explicit API key and never
// runs in CI. On the free tier, pick a free model: `inclusionai/ling-3.0-flash novita`.
// Content is stripped before anything is written: every text, reasoning, and tool input string is
// replaced by its length. Session and request IDs are redacted.
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

if (process.env.CI) {
  console.error('live-repro never runs in CI.')
  process.exit(1)
}
if (!process.env.AI_GATEWAY_API_KEY) {
  console.error(
    'Refusing to run: this makes billed AI Gateway calls. Set AI_GATEWAY_API_KEY explicitly to continue.',
  )
  process.exit(1)
}

const root = join(import.meta.dirname, '..')
// `ai` is a dependency of packages/core, not of the repo root: resolve it from there.
const fromCore = createRequire(join(root, 'packages', 'core', 'package.json'))
const load = (name: string) => import(pathToFileURL(fromCore.resolve(name)).href)
const { jsonSchema, stepCountIs, streamText, tool, wrapLanguageModel } = await load('ai')
const { gateway } = await load('@ai-sdk/gateway')

const modelId = process.argv[2] ?? 'zai/glm-5.3-flash'
const provider = process.argv[3] ?? 'baseten'

type Part = Record<string, unknown> & { type: string }
const calls: Part[][] = []

const REDACTED_KEYS = new Set(['clientSessionId', 'providerRequestId', 'providerResponseId'])

/** Replaces IDs that can point back to the machine or account that made the call. */
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (typeof value !== 'object' || value === null || value instanceof Date) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [
      key,
      REDACTED_KEYS.has(key) ? '<redacted>' : key === 'generationId' ? 'gen_redacted' : redact(v),
    ]),
  )
}

/** A content-free, redacted copy of a stream part. */
function strip(part: Part): Part {
  const copy: Part = { ...part }
  for (const key of ['delta', 'text', 'input']) {
    if (typeof copy[key] === 'string') copy[key] = `<${(copy[key] as string).length} chars>`
  }
  if ('rawValue' in copy) copy.rawValue = '<raw chunk>'
  if ('error' in copy) copy.error = String(copy.error)
  if (copy.type === 'response-metadata') copy.id = '<redacted>'
  return redact(copy) as Part
}

const recorder = {
  specificationVersion: 'v4',
  async wrapStream({ doStream }: { doStream: () => Promise<{ stream: ReadableStream<Part> }> }) {
    const result = await doStream()
    const parts: Part[] = []
    calls.push(parts)
    const stream = result.stream.pipeThrough(
      new TransformStream<Part, Part>({
        transform(part, controller) {
          parts.push(strip(part))
          controller.enqueue(part)
        },
      }),
    )
    return { ...result, stream }
  },
}

// The #20932 shape: tools present, so the model reasons, calls a tool, then answers.
const result = streamText({
  model: wrapLanguageModel({ model: gateway(modelId), middleware: recorder }),
  prompt: 'Use the weather tool for Paris, then answer in one sentence.',
  tools: {
    weather: tool({
      description: 'Current weather for a city',
      inputSchema: jsonSchema({
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      }),
      execute: async () => ({ tempC: 18, sky: 'clear' }),
    }),
  },
  stopWhen: stepCountIs(2),
  providerOptions: { gateway: { only: [provider] } },
})
await result.consumeStream()

if (calls.length === 0) {
  console.error(
    'No model calls were recorded: the request failed before streaming (see the error above).\n' +
      'On the free tier, try a free model: pnpm exec tsx scripts/live-repro.ts inclusionai/ling-3.0-flash novita',
  )
  process.exit(1)
}

const file = join(
  root,
  'fixtures',
  `live-${modelId.replace('/', '-')}-${provider}-${Date.now()}.json`,
)
writeFileSync(
  file,
  `${JSON.stringify({ source: `Live recording of ${modelId} pinned to ${provider}, ${new Date().toISOString()}. Content stripped.`, calls }, null, 2)}\n`,
)
console.log(`Wrote ${calls.length} model calls to ${file}`)
for (const [i, parts] of calls.entries()) {
  const withGateway = parts.filter((p) => {
    const meta = p.providerMetadata as Record<string, unknown> | undefined
    return meta?.gateway !== undefined
  })
  console.log(
    `call ${i + 1}: parts carrying providerMetadata.gateway: ${withGateway.map((p) => p.type).join(', ') || 'none'}`,
  )
}
