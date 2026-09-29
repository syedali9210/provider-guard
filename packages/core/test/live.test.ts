import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { parseGenerationId, parseRouting } from '../src/detect'
import type { StreamPart } from '../src/types'
import { callStream } from './helpers'

// A live AI Gateway recording made with scripts/live-repro.ts on 2026-09-29: two streamed calls
// (a tool call, then the answer) for inclusionai/ling-3.0-flash pinned to novita. Text is replaced
// by its length and IDs are redacted. It confirms the routing metadata that guard() relies on.
const live: { calls: StreamPart[][] } = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '..', '..', '..', 'fixtures', 'live-ling-3.0-flash-novita.json'),
    'utf8',
  ),
)

const finishMetadata = (parts: StreamPart[]) => {
  const finish = parts.find((p) => p.type === 'finish')
  return finish?.type === 'finish' ? finish.providerMetadata : undefined
}

describe('a live AI Gateway recording', () => {
  test('carries routing metadata on the finish part, in the shape guard() reads', () => {
    expect(live.calls).toHaveLength(2)
    for (const parts of live.calls) {
      const metadata = finishMetadata(parts)
      expect(parseRouting(metadata)).toEqual({
        finalProvider: 'novita',
        resolvedProvider: 'novita',
        originalModelId: 'inclusionai/ling-3.0-flash',
        planningReasoning: expect.stringContaining('novita'),
        fallbacksAvailable: [],
        modelAttemptCount: 1,
      })
      expect(parseGenerationId(metadata)).toMatch(/^gen_/)
    }
  })

  test('guard() passes the live answer through and records the provider that served it', async () => {
    const answer = live.calls[1] ?? []
    const { parts, sink } = await callStream({}, [answer])
    expect(parts.map((p) => p.type)).toEqual(answer.map((p) => p.type))
    expect(sink.records).toHaveLength(1)
    expect(sink.records[0]).toMatchObject({
      model: 'zai/glm-5.3-flash',
      provider: 'novita',
      finish: 'stop',
      flags: [],
      retry: null,
    })
    expect(sink.records[0]?.generationId).toMatch(/^gen_/)
  })
})
