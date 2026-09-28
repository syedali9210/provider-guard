# provider-guard — Product Requirements Document (v0.1)

| | |
|---|---|
| Owner | Syed Ali |
| Status | Ready to build |
| Last verified | 2026-09-28 (all facts, versions, and issue states below were checked on this date) |
| Target | v0.1 on npm + public replay demo in ~10 working days |
| Budget | ₹0. No AI Gateway credits, no paid services, no card on file |

---

## 0. Read this first (instructions for Claude Code)

1. **Work milestone by milestone** (section 11). Do not start a milestone until the previous one meets its acceptance criteria. Write the failing test first, then the code.
2. **Design setup before any UI work.** From the repo root run:
   ```bash
   npx getdesign@latest add vercel
   ```
   This writes `./DESIGN.md` (if one already exists it writes to a nested folder; use `--force` or `--out <path>` to control that). Then read these official Geist pages as Markdown (append `.md` to any Geist URL, or send `Accept: text/markdown`):
   - https://vercel.com/geist/introduction.md
   - https://vercel.com/geist/colors.md
   - https://vercel.com/geist/typography.md
   - https://vercel.com/geist/materials.md
   - https://vercel.com/geist/grid.md
   - https://vercel.com/geist/icons.md
   - Component pages as needed: `https://vercel.com/geist/<component>.md` (for example `/geist/button.md`)
3. **Design source of truth, in order:** (1) the official Geist docs at https://vercel.com/geist/introduction, (2) `DESIGN.md` from getdesign, (3) this PRD. `DESIGN.md` is an unofficial, independently written synthesis meant as a quick reference for agents. If it conflicts with the Geist docs, **Geist wins**. Do not use `vercel.com/design.md`; per the Geist docs that file is for Vercel-authored report websites, not product UI.
4. **Verify APIs against installed types before coding.** Versions checked on 2026-09-28: `ai@7.0.118`, `@ai-sdk/gateway@4.0.96`, `@ai-sdk/provider@4.0.18`. If an installed type differs from this PRD, follow the installed type and leave a note in `NOTES.md`.
5. **No spending, ever.** Never call AI Gateway endpoints that need an API key. The only live network call allowed anywhere (dev, tests, CI) is the public, unauthenticated endpoints API described in 5.2. Tests use fixtures by default.
6. **Windows is the primary dev machine.** Use cross-platform scripts only (no `rm -rf`, no bash-only syntax in `package.json`, `path.join` everywhere). CI must pass on Windows.
7. **Ask before adding any runtime dependency** to the published core package. Target is zero.
8. **Never store or display prompt or response content** anywhere in the product (section 7).

---

## 1. Summary

`provider-guard` is a small npm package for apps built with the AI SDK and Vercel AI Gateway.

> **The gateway catches errors. provider-guard catches successes that aren't.**

When one provider serving a model returns an HTTP 200 response that is billed but unusable (for example, text tokens billed but no text delivered), AI Gateway treats it as a success and never falls back. provider-guard detects these responses, retries once on a different provider, lets developers exclude a single provider for a single model safely, records metadata-only call records, and visualizes everything in a local dashboard called **Studio**.

Deliverables:
1. `guard()`: AI SDK language model middleware (detect, retry, record).
2. `exclude()`: per-model, per-request provider exclusion in userland.
3. `provider-guard report`: terminal report of provider health per model.
4. `provider-guard studio`: local visualization dashboard, plus a public static **replay demo** built from published issue data.

---

## 2. Problem and evidence

### 2.1 The problem
AI Gateway routes one model ID to many providers (up to 20 for a single model today). Gateway fallback only triggers on failures. When a provider returns a *successful but broken* response, nothing fails, so nothing falls back, and the developer usually finds out from user complaints or from staring at token metrics.

### 2.2 Evidence (public, current)
- **vercel/ai#20932** (opened 2026-09-17, still open and blocked, no PR as of 2026-09-28). `zai/glm-5.3-flash` served by Baseten bills the final answer but streams no content when tools are present and the model reasons first. Measured by the reporter (reasoned calls only, provider pinned with `only`):

  | Provider | Tools | Empty / reasoned |
  |---|---|---|
  | baseten | yes | 22 / 51 |
  | baseten | no | 0 / 37 |
  | zai | yes | 0 / 30 |
  | fireworks | yes | 0 / 7 |

  The call finishes `stop` with HTTP 200. About 97% of the reporter's traffic for this model lands on Baseten, and roughly 0.4% of their chat turns lose the final message. The AI SDK bot reproduced it on AI SDK 5, 6, and 7 and concluded the fix belongs in the managed gateway, not the SDK. The reporter proposed the detection rule this product uses: *finishes `stop`, non-reasoning completion tokens billed, no content delta, no tool call.* The reporter also found some models never reason on Baseten with the same request (for example `zai/glm-4.7`: 0/40 on Baseten vs 20/26 on zai).
- **vercel/ai#20934** (opened 2026-09-17, still open, labeled blocked). Feature request for a request-level `exclude` option. The reporter's hand-written workaround fetches the model's provider list and builds an `only` allow-list (extra fetch, cache, failure handling, list goes stale). They also retry "200 but unusable" calls by building `only = fallbacksAvailable minus finalProvider` from routing metadata. The AI SDK bot's live probe showed that passing `exclude` **compiles** (the options type has an index signature) **but is silently ignored**: `only: ['baseten']` plus `exclude: ['baseten']` still routed to Baseten.
- **vercel/ai#21207** (opened 2026-09-20, still open and blocked). A second, unrelated team: AI Gateway silently drops reasoning effort for `openai/gpt-5.6-sol` served by Amazon Bedrock. Median reasoning tokens, 3 runs each:

  | Provider | `reasoning: 'low'` | `reasoning: 'xhigh'` |
  |---|---|---|
  | openai | 1,750 (1552, 1750, 1902) | 6,711 (5696, 6711, 7128) |
  | bedrock | 2,704 (2588, 2704, 3303) | 3,060 (2588, 3060, 3106) |

  Putting Bedrock first in their provider order cut reasoning about 10x in production (median 12,898 to about 1,200 reasoning tokens per turn) with no error anywhere. The catalog lists `reasoning` as supported for the Bedrock endpoint.

### 2.3 What exists today and why it is not enough
- `only`: allow-list; excluding one provider means hand-maintaining the rest per model.
- `order`: preference only; the broken provider still receives traffic.
- Team provider allowlist: team-wide for every model, owner-only, $0.10 per 1K successful requests, not per request.
- Routing rules: match models, not providers.
- `has`: as of `@ai-sdk/gateway@4.0.96` accepts capability tags (`implicit-caching`, `reasoning`, `structured-output`, `tool-use`, `vision`) and weight-format conditions (`quantization:x`, `!quantization:x`). No provider exclusion.
- Nothing detects a billed-but-empty 200.

---

## 3. Goals and non-goals

### Goals (v0.1)
- G1. Detect billed-but-empty responses in both `generateText` and `streamText` flows with zero added latency for healthy calls.
- G2. Retry a flagged call once on a different provider, transparently to the caller.
- G3. Provide `exclude()` for per-model provider exclusion that stays correct as providers are added or removed.
- G4. Record metadata-only call records and summarize provider health per model (CLI report).
- G5. Visualize catches, provider health, and call anatomy in Studio (local) and a public replay demo.
- G6. Production-quality package: typed, tested on Windows/macOS/Linux, zero runtime dependencies in core.

### Non-goals (v0.1)
- Automatic retries for reasoning drift (#21207). v0.1 **reports** it; it does not retry on it.
- Retries for non-gateway providers. `guard()` still detects and records for them, but only retries when the model is served through AI Gateway.
- Image, video, embedding, speech, or realtime models.
- Any hosted backend, accounts, or telemetry.
- Storing or displaying prompts, responses, or tool arguments.

---

## 4. Users and use cases

Primary user: a developer shipping an app or agent on the AI SDK and AI Gateway, using models served by several providers.

- U1. "When a provider sends me a billed but empty answer, my user should still get an answer." → `guard()`
- U2. "One provider is broken for one of my models. Keep every other provider, including new ones." → `exclude()`
- U3. "Which provider is causing this, and for which model?" → `report`, Studio Providers screen
- U4. "Prove to me why this call was flagged." → Studio Call anatomy
- U5. "Did switching provider order change my model's behavior?" → reasoning panel in `report` and Studio

---

## 5. Product surface and API

### 5.0 Usage (the README hero example)
```ts
import { gateway } from '@ai-sdk/gateway'
import { streamText, wrapLanguageModel } from 'ai'
import { guard, exclude } from 'provider-guard'

const model = wrapLanguageModel({
  model: gateway('zai/glm-5.3-flash'),
  middleware: guard(),
})

const result = streamText({
  model,
  tools,
  prompt,
  providerOptions: { gateway: await exclude('zai/glm-5.3-flash', ['baseten']) },
})
```

### 5.1 `guard(options?)` — middleware

Built on the AI SDK middleware interface (`LanguageModelMiddleware` from `ai`, based on `LanguageModelV4Middleware`: `transformParams`, `wrapGenerate`, `wrapStream`).

```ts
type GuardOptions = {
  detectors?: Array<'billedButEmpty' | Detector>   // default: ['billedButEmpty']
  retry?: { max?: 0 | 1; reasoning?: 'drop' | 'keep' } // default: { max: 1, reasoning: 'drop' }
  sink?: RecordSink                                   // default: file sink in Node, memory sink elsewhere
  onIncident?: (incident: Incident) => void
  treatWhitespaceAsEmpty?: boolean                    // default: true
  enabled?: boolean                                   // default: true
}

type CallSummary = {
  modelId: string
  mode: 'generate' | 'stream'
  finishReason?: 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other'
  usage: { inputTokens?: number; outputTokens?: number; textTokens?: number; reasoningTokens?: number }
  delivered: { textChars: number; reasoningChars: number; toolCalls: number }
  reasoningRequested?: 'provider-default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  routing?: GatewayRouting          // parsed from provider metadata, may be undefined
  parts?: PartSummary[]             // stream only: { type, atMs } per stream part, no content
}

type Detection = { id: string; reason: string; retry: boolean }
type Detector = (call: CallSummary) => Detection | null
```

**Built-in detector `billedButEmpty`** fires when all are true:
- `finishReason === 'stop'` (V4 `finishReason.unified`)
- `textTokens > 0`, where `textTokens = usage.outputTokens.text ?? (usage.outputTokens.total - usage.outputTokens.reasoning)` when those are defined
- `delivered.textChars === 0` (after trimming if `treatWhitespaceAsEmpty`)
- `delivered.toolCalls === 0`

**Routing metadata.** `providerMetadata.gateway` is untyped JSON owned by the gateway service and may change without an SDK release. Fields observed in public issues under `providerMetadata.gateway.routing`: `finalProvider`, `fallbacksAvailable`, `originalModelId`, `resolvedProvider`, `modelAttemptCount`, `planningReasoning`. Parse with a hand-written runtime validator (no zod in core). If validation fails, set `routing` to `undefined` and continue; never throw because of metadata shape. In streams, look for it on the `finish` part first, then on any part carrying `providerMetadata.gateway`. Confirm the location with a recorded fixture in M1.

**Retry semantics.**
1. Candidate providers = `routing.fallbacksAvailable` if present, else the model's provider list from `exclude()`'s cache/fetch (5.2).
2. Remove the provider that served the flagged attempt (`routing.finalProvider`).
3. If the caller set `only`, intersect with it. Remove the served provider from `order` if present. Keep `sort`, `models`, and everything else unchanged.
4. If no candidates remain, do not retry; record `retry.outcome = 'skipped'`, `skipReason = 'no-alternative-provider'`.
5. Never retry when: a tool call was emitted, the abort signal is aborted, `retry.max` is reached, the served provider is unknown, or the model is not served through the gateway.
6. The final result's `usage` is the **sum** of both attempts (both were billed). Attach `providerMetadata.providerGuard = { retried, reason, attempts: [{ provider, usage }] }`.
7. If the retry throws, return the original result unchanged, record `retry.outcome = 'failed'`, and call `onIncident`. provider-guard must never make a call worse than it would have been without it.

**Streaming (the hard part).**
- Pass every part through immediately. No buffering of text or reasoning.
- Hold back only attempt 1's `finish` part. Evaluate detectors synchronously on it (no added latency for healthy calls).
- If flagged and retry is allowed: start attempt 2 via `doStream` with the transformed params, pipe its parts into the same stream, skipping its `stream-start` and `response-metadata` parts and (by default) its `reasoning-*` parts, then emit a single `finish` with summed usage and the `providerGuard` metadata.
- If not flagged: emit the held `finish` unchanged.

**Warnings (via the logger, once per process per key):**
- `providerOptions.gateway.exclude` is present: "AI Gateway ignores `exclude` as of 2026-09-28. Use exclude() from provider-guard."

### 5.2 `exclude(modelId, providers, options?)`

```ts
type ExcludeOptions = {
  ttlMs?: number                              // default 10 minutes
  onUnavailable?: 'allow-all' | 'throw'       // default 'allow-all' (with a warning)
  fetch?: typeof fetch                        // injectable for tests
  baseURL?: string                            // default 'https://ai-gateway.vercel.sh'
}
// Returns a partial gateway options object to spread into providerOptions.gateway
function exclude(modelId: string, providers: string[], options?: ExcludeOptions): Promise<{ only?: string[] }>
```

- Data source: `GET {baseURL}/v1/models/{creator}/{model}/endpoints`. **Public, no API key.** Provider slug field: `data.endpoints[].provider_name`. Other useful fields: `context_length`, `max_completion_tokens`, `supported_parameters`, `tags`, `pricing`, `has_zdr`, `status`, `uptime_last_1h`.
- In-memory cache per model with stale-while-revalidate: return cached immediately, refresh in the background after `ttlMs`. De-duplicate concurrent fetches.
- Fetch failure: use the last known list. If none and `onUnavailable === 'allow-all'`, return `{}` (no restriction) and warn. If `'throw'`, throw `ProviderListUnavailableError`.
- Slugs compare case-insensitively. Unknown slugs produce a warning, not an error.
- If every provider would be excluded, throw `NoProvidersLeftError` with a message naming the model and the excluded list.
- Single-provider models: excluding that provider throws `NoProvidersLeftError`; excluding nothing returns `{}`.

### 5.3 Call records

One JSON object per attempt, appended as a line to `.provider-guard/calls.jsonl` (Node default) or passed to a custom sink.

```jsonc
{
  "v": 1,
  "id": "pg_01J…",                  // attempt id
  "retryOf": null,                   // id of the flagged attempt, for retries
  "ts": "2026-09-28T10:15:02.114Z",
  "model": "zai/glm-5.3-flash",
  "provider": "baseten",             // routing.finalProvider or null
  "mode": "stream",
  "finish": "stop",
  "tokens": { "in": 1830, "out": 6, "text": 4, "reasoning": 2 },
  "delivered": { "textChars": 0, "reasoningChars": 4, "toolCalls": 0 },
  "reasoningRequested": null,
  "flags": ["billed-but-empty"],
  "retry": { "attempted": true, "provider": "zai", "outcome": "recovered", "skipReason": null },
  "parts": [ { "t": "reasoning-delta", "ms": 212 }, { "t": "reasoning-delta", "ms": 260 }, { "t": "finish", "ms": 301 } ],
  "generationId": null,
  "durationMs": 301
}
```

`retry.outcome`: `recovered` | `still-empty` | `failed` | `skipped`.

Sinks: `fileSink(path)` (Node only, exported from `provider-guard/node`), `memorySink()`, `consoleSink()`, `noopSink()`, or any `{ write(record): void | Promise<void> }`. Sink errors are caught and logged, never thrown into the app. In non-Node runtimes (Edge), default to `memorySink()`.

### 5.4 CLI (`provider-guard`)

Argument parsing with `node:util` `parseArgs`. Colors only when stdout is a TTY; respect `NO_COLOR` and `FORCE_COLOR`. Every command supports `--json`.

- `provider-guard report [--file <path>] [--model <id>] [--since <duration>] [--json]`
- `provider-guard studio [--file <path>] [--port <n>] [--replay <dataset>] [--no-open]`
- `provider-guard --help`, `--version`

Exit codes: `0` success, `1` usage error, `2` records file not found or unreadable.

Report layout (text mode):
```
zai/glm-5.3-flash                               88 attempts · 22 caught
  provider  attempts   empty         reasoned
  baseten         51   22 (43.1%)    100%       outlier  p < 0.0001
  zai             30    0 (0.0%)     100%
  fireworks        7    0 (0.0%)     100%
```

**Outlier rule (empty rate):** flag a provider when it has at least 10 calls, an empty rate of at least 10%, and a one-sided Fisher exact test against all other providers of the same model gives p < 0.01. Implement Fisher's exact test in core (small, zero dependencies) and unit-test it against known values.

**Reasoning panel:** when records include at least two `reasoningRequested` levels for a model, show median reasoning tokens per provider per level. Flag "effort appears ignored" for a provider when its medians across the lowest and highest requested levels differ by less than 25% while another provider of the same model differs by at least 2x. Report-only in v0.1.

---

## 6. Studio (visualization layer)

### 6.1 Purpose
Make the product legible in seconds: show the catch happening, show which provider is at fault, and prove why a call was flagged. One build serves two modes:
- **Live** (`provider-guard studio`): reads the user's real records file.
- **Replay** (public demo): plays the dataset in section 8. The only visual difference is the data-source label.

### 6.2 Architecture
- UI: React + Vite + TypeScript in `packages/studio`, built to static assets and copied into the core package at `dist/studio` during build. Users install nothing extra.
- Server: `node:http`, bound to `127.0.0.1` only, read-only, no CORS. Default port 4747; if busy, try the next 10 ports.
- Endpoints: `GET /api/records?since=<iso>` (JSON array) and `GET /api/stream` (Server-Sent Events of new records).
- Tailing: track the byte offset of the records file, read only new bytes on change, handle partial trailing lines. Use `fs.watch` with a 500 ms `fs.watchFile` polling fallback (Windows `fs.watch` is unreliable).
- Charts: hand-built SVG. No chart library. Studio JS budget: under 150 KB gzipped. Virtualize the feed list above 1,000 rows.

### 6.3 Design system (mandatory)
- Follow Geist (section 0). Use Geist color scales, typography scale, materials (radii, fills, strokes, shadows), and grid exactly. Expose tokens as CSS custom properties. No ad-hoc hex values.
- Fonts: official `geist` npm package (Geist Sans for UI, Geist Mono for model IDs, provider slugs, token counts, generation IDs).
- Components: the Geist docs say components ship as `@vercel/geistcn` and icons as `@vercel/geistcn-assets`. On 2026-09-28 neither was found on the public npm registry. Check with `npm view @vercel/geistcn`; if still unavailable, implement only the components needed (button, badge, table, tabs, tooltip, drawer) locally, matching each `/geist/<component>.md` spec. Do not substitute third-party "Geist-like" UI kits.
- Light and dark themes following system preference, with a toggle.
- Branding: the product is "provider-guard". Never use Vercel logos or imply affiliation. Footer text: "Not affiliated with Vercel."
- Writing: sentence case everywhere, plain verbs, no all-caps labels, errors say what happened and how to fix it. Use the same word for the same thing on every surface: "caught" (flagged by a detector), "retried", "recovered", "outlier".
- Restraint: one orchestrated motion moment (the catch, 6.4). Everything else is quiet. Color is never the only signal; pair it with an icon or text.

### 6.4 Screens

**Top bar.** Product name (text), data-source badge ("Live · .provider-guard/calls.jsonl" or "Replay · vercel/ai#20932, #21207"), time range (15m, 1h, 24h, all), theme toggle. Two tabs: Feed and Providers.

**Feed (hero screen).**
- Newest first. Row: time, model, provider chip, result, text/reasoning tokens, duration.
- Results: "Delivered" (quiet check), "Caught → recovered on zai", "Caught · retry failed", "Caught · no other provider".
- **The catch animation** (only for incidents that arrive while the screen is open): the served provider chip gets a flag mark, a line animates from it to the retry provider chip, then the recovered check appears. 450 ms total, ease-out, once per incident. With `prefers-reduced-motion`, show the final state instantly.
- New incidents are announced through an `aria-live="polite"` region.
- Clicking a row opens Call anatomy in a right-side drawer. Rows are keyboard navigable (arrow keys, Enter opens, Esc closes the drawer).
- Empty state: "No calls recorded yet. Wrap your model with guard() and make a request. Calls appear here as they happen."

**Providers.**
- Model list on the left with call and catch counts. Selected model on the right.
- Provider table: calls, empty count and rate (inline bar), reasoned %, median reasoning tokens, outlier badge with Fisher p-value.
- Reasoning panel (when at least two effort levels exist): dot plot, one row per provider, dots per run grouped by effort level. The #21207 data must make Bedrock's overlapping clusters visibly different from OpenAI's separated ones.

**Call anatomy (drawer).**
- Header: model, attempts (provider chips in order), copy buttons for record id and generation id.
- Timeline: one lane per attempt, stream parts as ticks on a shared time axis, marked by part type (reasoning, text, tool, finish) using shape plus color. Attempt 2 lane labeled "spliced into the same stream".
- Evidence list for flagged attempts, rendered as the actual checks: finish reason `stop` ✓, text tokens billed `4` ✓, text delivered `0 chars` ✓, tool calls `0` ✓ → "Matched billed-but-empty".
- Totals: summed usage across attempts, with a note that both attempts were billed.

**States for every screen:** loading, empty, error (records file unreadable: show the path and the fix), and large data.

---

## 7. Privacy and security
- Records and Studio contain metadata only: never prompts, responses, reasoning text, or tool arguments. `delivered.*Chars` are counts, not content.
- The Studio server binds to `127.0.0.1`, is read-only, and serves only the records file and bundled assets.
- No telemetry. Adoption is measured through npm downloads and GitHub activity. State this in the README.

---

## 8. Replay dataset (public demo)

Generated by a deterministic script (`scripts/build-replay.ts`, seeded PRNG) into `packages/studio/replay/`. Every number below comes from the cited issues; individual records are **reconstructed** to match the published aggregates.

- **`vercel-ai-20932`**: `zai/glm-5.3-flash`, tools present. Baseten 51 attempts (22 billed-but-empty), zai 30 attempts (0 empty), fireworks 7 attempts (0 empty). Each of the 22 caught attempts is followed by a recovered retry; those retries are drawn from the zai and fireworks attempts (for example 18 on zai, 4 on fireworks) so per-provider totals match the published numbers exactly. Empty attempts use the published part shape: two reasoning deltas, then `finish` with `stop`, usage `{ total: 6, text: 4, reasoning: 2 }`, zero text parts. Successful attempts add one text part before `finish`. Add the reporter's "no reasoning on Baseten" rows as report-only data (for example `zai/glm-4.7`: 0/40 reasoned on Baseten vs 20/26 on zai).
- **`vercel-ai-21207`**: `openai/gpt-5.6-sol` with `reasoningRequested` `low` and `xhigh`. Use the exact per-run reasoning token values from section 2.2 (3 runs per cell).
- Playback: records emit over time to simulate live traffic, with speed control (1x, 4x) and restart.
- Banner, always visible in replay mode: "Replay reconstructed from data published in vercel/ai#20932 and #21207. No live traffic."
- Deploy: static build of `packages/studio` with `VITE_MODE=replay`, as its own project on the owner's Vercel team.

---

## 9. Technical requirements

**Repo layout (pnpm workspaces):**
```
provider-guard/
├─ packages/
│  ├─ core/        # published as `provider-guard` (library + CLI + dist/studio)
│  └─ studio/      # private; React UI, built into core
├─ fixtures/       # recorded and issue-derived stream fixtures
├─ scripts/        # build-replay.ts, copy-studio.ts
├─ DESIGN.md       # from `npx getdesign@latest add vercel`
├─ PRD.md
└─ NOTES.md        # decisions and API discrepancies found during the build
```

**Core package:**
- TypeScript strict. Node ≥ 20. Build with `tsup` to ESM and CJS with type declarations.
- Exports: `provider-guard` (`guard`, `exclude`, built-in detectors, sinks except file, types, errors), `provider-guard/node` (`fileSink`), `bin: provider-guard`.
- Peer dependency: `ai@>=7 <8`. Zero runtime dependencies.

**Quality:**
- Tests: `vitest`. Integration tests use `MockLanguageModelV4` and `simulateReadableStream` from `ai/test`. Studio component tests with Testing Library; one Playwright smoke test against the replay build.
- Coverage: at least 90% lines in core.
- Lint and format: Biome.
- CI (GitHub Actions, free for public repos): matrix `ubuntu-latest`, `windows-latest`, `macos-latest` × Node 20 and 22. Steps: install, lint, typecheck, test, build, pack and install the tarball in a temp project and run `provider-guard --version`.
- Release: changesets, npm publish with provenance. Package name `provider-guard` (available on 2026-09-28; re-check before first publish). License MIT.

---

## 10. Test plan

Fixtures in `fixtures/` built from #20932's published chunk shapes, expressed as V4 stream parts, plus gateway routing metadata naming the served provider.

**`guard()` scenarios (generate and stream each):**
1. Healthy call → passes through unchanged, one record, no added latency (held `finish` released immediately).
2. Billed-but-empty → retried once on another provider → recovered; usage summed; `providerGuard` metadata present; two linked records.
3. Retry also empty → `still-empty`, no second retry.
4. Tool call emitted → never retried.
5. Routing metadata missing or malformed → no retry, record written, no throw.
6. `fallbacksAvailable` absent → candidates from `exclude()` data.
7. Caller's `only` and `order` respected and adjusted correctly.
8. No alternative provider → `skipped` with reason.
9. Abort signal fired mid-stream → no retry, clean shutdown.
10. Retry throws → original result returned, `failed` recorded, `onIncident` called.
11. Whitespace-only text with `treatWhitespaceAsEmpty` true and false.
12. `providerOptions.gateway.exclude` present → one warning per process.
13. Streaming splice: attempt 1 reasoning passes through live; attempt 2 reasoning dropped by default and kept with `reasoning: 'keep'`; exactly one `finish` emitted.

**`exclude()`:** cache hit, stale-while-revalidate, concurrent de-dupe, fetch failure with and without a last-known list, `onUnavailable: 'throw'`, case-insensitive slugs, unknown slug warning, all excluded, single-provider model. One opt-in live test against the public endpoints API (skipped in CI unless `PG_LIVE_PUBLIC=1`).

**CLI:** snapshot tests for `report` text and `--json`, Fisher exact test values, outlier and reasoning-panel rules against the replay dataset (Baseten must be flagged; Bedrock must show "effort appears ignored"), exit codes, `NO_COLOR`.

**Studio:** tail logic with partial lines and file growth; SSE delivery; Feed catch animation respects reduced motion; keyboard navigation; Playwright smoke on replay build (loads, catch appears, drawer opens, Providers flags Baseten).

---

## 11. Milestones and acceptance criteria

| # | Milestone | Days | Done when |
|---|---|---|---|
| M0 | Repo, tooling, CI, `DESIGN.md`, Geist docs read | 1 | CI green on all 3 OS with a placeholder test; `DESIGN.md` present; `NOTES.md` lists the Geist pages read |
| M1 | Fixtures, detector, `guard()` for generate | 1–2 | Scenarios 1–12 pass for generate |
| M2 | `guard()` streaming and splice | 3 | All 13 scenarios pass for stream; no buffering of healthy output |
| M3 | `exclude()` | 4 | All `exclude()` tests pass; README section written |
| M4 | Records, sinks, `report` CLI | 5 | Report on the replay dataset flags Baseten and Bedrock correctly; snapshots committed |
| M5 | Studio foundation and Feed | 6–7 | Live mode tails a file on Windows; catch animation done; keyboard and reduced motion verified |
| M6 | Providers and Call anatomy | 8 | Both screens complete with all states; Playwright smoke passes |
| M7 | Replay dataset, demo deploy, README, release | 9–10 | v0.1 on npm with provenance; demo URL live; README complete |

---

## 12. README outline
1. One-line pitch and the tagline.
2. The problem in three sentences, linking #20932, #20934, #21207.
3. Install and the 10-line hero example.
4. What counts as "caught" (the exact rule).
5. Retry behavior and guarantees (at most once, never after a tool call, never worse than without it).
6. `exclude()`.
7. Report and Studio, with a screenshot and the demo link.
8. Privacy (metadata only, no telemetry).
9. Limitations (reasoning drift is report-only; gateway metadata is untyped and may change).
10. Note that native `exclude` would make `exclude()` a thin shim, and that provider-guard will adopt it.

---

## 13. Success criteria for v0.1
- Installs cleanly and all tests pass on Windows, macOS, Linux.
- Public replay demo shows a catch, the Baseten outlier, and the Bedrock reasoning collapse within 30 seconds of opening.
- A 60-second screen recording: catch in Feed → Call anatomy evidence → Providers outlier → the three lines of code.
- At least one reporter from the cited issues tries it and responds.

---

## 14. Risks and open questions
- **Vercel fixes Baseten or Bedrock, or ships native `exclude`.** The product targets the class of bug, which recurs across providers (for example vercel/ai#17274, #19866). `exclude()` would switch to the native option.
- **Routing metadata changes shape.** Runtime validation plus graceful degradation; fixture tests pin the expected shape.
- **Stream splice UX.** Duplicate reasoning is dropped by default; document the behavior and the `reasoning: 'keep'` option.
- **No live verification without gateway credits.** Tests are fixture-based. An optional script `scripts/live-repro.ts` may be written but must refuse to run without an explicit API key and is never run in CI.
- **Geist component package availability.** See 6.3.
- **Open question for Syed:** confirm the final package name and MIT license before M7.

---

## 15. References
- vercel/ai#20932: https://github.com/vercel/ai/issues/20932
- vercel/ai#20934: https://github.com/vercel/ai/issues/20934
- vercel/ai#21207: https://github.com/vercel/ai/issues/21207
- AI Gateway provider options: https://vercel.com/docs/ai-gateway/models-and-providers/provider-options
- AI Gateway models and providers (public endpoints API): https://vercel.com/docs/ai-gateway/models-and-providers
- AI Gateway provider allowlist: https://vercel.com/docs/ai-gateway/capabilities/provider-allowlist
- Geist design system: https://vercel.com/geist/introduction
- getdesign CLI: https://getdesign.md

---

## Appendix: suggested `CLAUDE.md`
```md
# provider-guard
- Read PRD.md fully before any work. Build milestone by milestone (PRD §11); tests first.
- Before any UI work, read DESIGN.md and the Geist .md pages listed in PRD §0. Geist docs win on conflicts.
- Zero runtime dependencies in packages/core. Ask before adding one.
- Never call AI Gateway endpoints that need an API key. Fixtures by default.
- Never store or display prompt or response content.
- Cross-platform scripts only; CI must pass on Windows.
- Log decisions and API discrepancies in NOTES.md.
```
