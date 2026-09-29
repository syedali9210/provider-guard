# provider-guard

> **The gateway catches errors. provider-guard catches successes that aren't.**

[![npm](https://img.shields.io/npm/v/provider-guard)](https://www.npmjs.com/package/provider-guard) [![CI](https://github.com/syedali9210/provider-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/syedali9210/provider-guard/actions/workflows/ci.yml) · **[Live demo](https://provider-guard-demo.vercel.app)**, a replay of the data published in the issues below

AI SDK middleware for apps on Vercel AI Gateway. It catches responses that return HTTP 200 and bill tokens but deliver nothing, retries them once on a different provider, lets you exclude one provider for one model, and records what happened without ever storing prompts or responses.

## The problem

AI Gateway routes one model ID to many providers and falls back only when a call fails. When a provider returns a successful but unusable response, nothing fails, so nothing falls back: in [vercel/ai#20932](https://github.com/vercel/ai/issues/20932), Baseten billed the final answer of `zai/glm-5.3-flash` but streamed no text in 22 of 51 reasoned calls with tools. You also cannot exclude one provider per request today, because `exclude` compiles but is silently ignored ([vercel/ai#20934](https://github.com/vercel/ai/issues/20934)), and a provider can silently drop reasoning effort ([vercel/ai#21207](https://github.com/vercel/ai/issues/21207)).

## Install

```bash
npm install provider-guard
```

Requires `ai@7` and Node.js 22 or later. provider-guard has no runtime dependencies.

```ts
import { gateway } from '@ai-sdk/gateway'
import { streamText, wrapLanguageModel } from 'ai'
import { exclude, guard } from 'provider-guard'

const model = wrapLanguageModel({ model: gateway('zai/glm-5.3-flash'), middleware: guard() })

const result = streamText({
  model,
  tools,
  prompt,
  providerOptions: { gateway: await exclude('zai/glm-5.3-flash', ['baseten']) },
})
```

## What counts as "caught"

The built-in `billedButEmpty` detector catches an attempt when all four are true:

1. The finish reason is `stop`.
2. Text tokens were billed: `usage.outputTokens.text > 0`, or `total − reasoning > 0` when the provider does not report text tokens separately. If neither can be computed, nothing is caught.
3. No text was delivered. Whitespace-only text counts as empty; pass `treatWhitespaceAsEmpty: false` to count it.
4. No tool call was delivered.

You can add your own detectors. A detector receives a content-free summary of the call and returns `{ id, reason, retry }` or `null`:

```ts
import { guard, type Detector } from 'provider-guard'

const tooShort: Detector = (call) =>
  call.finishReason === 'length' && call.delivered.textChars < 20
    ? { id: 'too-short', reason: 'Hit the length limit almost immediately', retry: false }
    : null

guard({ detectors: ['billedButEmpty', tooShort] })
```

## Retry behavior and guarantees

- **At most once.** A caught attempt is retried once on a different provider. If the retry is also empty, it is recorded as `still-empty` and returned as is.
- **Never after a tool call**, never after the abort signal fired, and never when the served provider is unknown or the model is not served through AI Gateway. Those calls are still detected and recorded.
- **Never worse than without it.** If the retry throws, errors, or ends without a finish, you get the original result and the incident is recorded as `failed`.
- **No added latency for healthy calls.** Stream parts pass through as they arrive. Only the `finish` part of a caught stream is held back; detectors run on it synchronously.
- **Where the retry goes.** Candidates are the gateway's `fallbacksAvailable` (or, if absent, the model's current provider list) minus the provider that served the empty answer, intersected with your `only`. That provider is also removed from your `order`. `sort`, `models`, and every other option are unchanged.
- **Honest usage.** Both attempts were billed, so the final `usage` is their sum. `providerMetadata.providerGuard` lists each attempt's provider and usage.
- **One stream.** In `streamText`, the retry is spliced into the same stream. Its reasoning is dropped by default because the first attempt's reasoning was already streamed; pass `retry: { reasoning: 'keep' }` to forward it. Exactly one `finish` part is emitted.

```ts
import { guard } from 'provider-guard'
import { fileSink } from 'provider-guard/node'

guard({
  detectors: ['billedButEmpty'], // default
  retry: { max: 1, reasoning: 'drop' }, // default; max: 0 detects and records without retrying
  treatWhitespaceAsEmpty: true, // default
  sink: fileSink('.provider-guard/calls.jsonl'), // default in Node; memory sink elsewhere
  onIncident: (incident) => console.warn(incident.record.retry),
})
```

## `exclude()`

Exclude one provider for one model and keep every other provider, including ones added later:

```ts
providerOptions: {
  gateway: {
    sort: 'cost',
    ...(await exclude('zai/glm-5.3-flash', ['baseten'])),
  },
}
```

`exclude()` reads the model's providers from the public AI Gateway endpoints API (`GET https://ai-gateway.vercel.sh/v1/models/{creator}/{model}/endpoints`, no API key) and returns `{ only: [...] }` with every provider except the ones you named. When nothing would actually be excluded, it returns `{}`.

- **Cached.** Each model's list is kept in memory for `ttlMs` (default 10 minutes). After that, the cached list is returned at once and refreshed in the background. Concurrent calls share one request.
- **Resilient.** If a refresh fails, the last known list is used. If there is no list yet, `exclude()` returns `{}` (every provider stays eligible) and logs a warning, or throws `ProviderListUnavailableError` with `onUnavailable: 'throw'`. After a failure it waits 30 seconds before fetching again.
- **Forgiving about names.** Slugs compare case-insensitively. A slug that does not serve the model logs a warning instead of throwing.
- **Strict about emptiness.** Excluding every provider throws `NoProvidersLeftError`, which names the model and the list.

| Option | Default | |
|---|---|---|
| `ttlMs` | `600000` | How long a list is fresh |
| `onUnavailable` | `'allow-all'` | Or `'throw'` |
| `fetch` | `globalThis.fetch` | For tests or proxies |
| `baseURL` | `'https://ai-gateway.vercel.sh'` | |

`providerOptions.gateway.exclude` is ignored by AI Gateway as of 2026-09-28. `guard()` logs a warning once per process when it sees it.

## Report

`provider-guard report` summarizes provider health per model from your recorded calls:

```bash
npx provider-guard report
```

This is the report on the replay data reconstructed from the three issues:

```
zai/glm-5.3-flash                            88 attempts · 22 caught
  provider    attempts   empty        reasoned
  baseten           51   22 (43.1%)   100%       outlier  p < 0.0001
  zai               30    0 (0.0%)    100%
  fireworks          7    0 (0.0%)    100%

zai/glm-4.7                                   66 attempts · 0 caught
  provider   attempts   empty      reasoned
  baseten          40   0 (0.0%)   0%
  zai              26   0 (0.0%)   77%

openai/gpt-5.6-sol                            12 attempts · 0 caught
  provider   attempts   empty      reasoned
  bedrock           6   0 (0.0%)   100%
  openai            6   0 (0.0%)   100%

  reasoning tokens (median)     low   xhigh
  bedrock                     2,704   3,060   effort appears ignored
  openai                      1,750   6,711
```

- **Outlier.** A provider is flagged when it has at least 10 calls, an empty rate of at least 10%, and a one-sided Fisher exact test against every other provider of the same model gives p < 0.01.
- **Effort appears ignored.** When calls requested at least two reasoning levels, the report shows median reasoning tokens per provider per level. A provider is flagged when its medians at the lowest and highest level differ by less than 25% while another provider of the same model differs by at least 2x. This is reported only; it never triggers a retry.
- **Options.** `--file <path>` (default `.provider-guard/calls.jsonl`), `--model <id>`, `--since 15m|1h|7d`, and `--json` for machine-readable output.
- **Exit codes.** `0` success, `1` usage error, `2` records file not found or unreadable. Colors appear only on a terminal and respect `NO_COLOR` and `FORCE_COLOR`.

## Studio

`provider-guard studio` opens a local dashboard at `http://127.0.0.1:4747` (if that port is busy, the next 10 are tried). It reads `.provider-guard/calls.jsonl` and follows it as new calls are recorded.

![Feed with a caught call open in Call anatomy](https://raw.githubusercontent.com/syedali9210/provider-guard/main/docs/studio-catch.png)

- **Feed.** Every call, newest first. A caught call shows the provider that served the empty answer, a line to the provider that recovered it, and the result in words. Click a row, or use the arrow keys and Enter, to open Call anatomy.
- **Call anatomy.** Each attempt's stream parts on one time axis, the retry marked "spliced into the same stream"; the detector's checks with the recorded values; and the summed usage of both attempts.
- **Providers.** Per model: calls, empty rate, reasoned share, median reasoning tokens, and the outlier badge with its p-value. When effort levels vary, a dot plot shows every run.

![Providers flagging Baseten as the empty-rate outlier](https://raw.githubusercontent.com/syedali9210/provider-guard/main/docs/studio-providers.png)

![Reasoning by effort level, with Bedrock ignoring effort](https://raw.githubusercontent.com/syedali9210/provider-guard/main/docs/studio-reasoning.png)

The public demo at **https://provider-guard-demo.vercel.app** plays the published issue data. On a first visit it opens How It Works: five short animated steps on why provider-guard exists and how to read the screen. To replay it locally without any records of your own:

```bash
npx provider-guard studio --replay all
```

Options: `--file <path>`, `--port <n>`, `--replay all|vercel-ai-20932|vercel-ai-21207`, `--no-open`, and `--json`.

## Records

Each attempt is one JSON line, appended to `.provider-guard/calls.jsonl` in Node (add `.provider-guard/` to your `.gitignore`). A caught attempt and its retry are linked by `retryOf`:

```jsonc
{
  "v": 1,
  "id": "pg_01K6A…",
  "retryOf": null,
  "ts": "2026-09-28T10:15:02.114Z",
  "model": "zai/glm-5.3-flash",
  "provider": "baseten",
  "mode": "stream",
  "finish": "stop",
  "tokens": { "in": 1830, "out": 6, "text": 4, "reasoning": 2 },
  "delivered": { "textChars": 0, "reasoningChars": 4, "toolCalls": 0 },
  "reasoningRequested": null,
  "flags": ["billed-but-empty"],
  "retry": { "attempted": true, "provider": "zai", "outcome": "recovered", "skipReason": null },
  "parts": [{ "t": "reasoning-delta", "ms": 212 }, { "t": "reasoning-delta", "ms": 260 }, { "t": "finish", "ms": 301 }],
  "generationId": "gen_…",
  "durationMs": 301
}
```

`retry.outcome` is `recovered`, `still-empty`, `failed`, or `skipped`; a skipped retry says why in `skipReason` (for example `no-alternative-provider` or `tool-call-emitted`).

Pass any sink as `guard({ sink })`: `fileSink(path)` from `provider-guard/node`, `memorySink()`, `consoleSink()`, `noopSink()`, or your own `{ write(record) }`. Sink errors are logged once and never reach your app. In Edge runtimes the default is `memorySink()`.

## Privacy

- **Metadata only.** Records and Studio contain model and provider names, finish reasons, token counts, character counts, and stream part types with timings. They never contain prompts, responses, reasoning text, or tool arguments.
- **Local and read-only.** Studio binds to `127.0.0.1`, serves only the records file and its own assets, and refuses requests for any other host name.
- **No telemetry.** provider-guard sends nothing anywhere. Its only network request is to the public AI Gateway endpoints API, from `exclude()` or when a retry needs the model's provider list. Adoption is measured only by npm downloads and GitHub activity.

## Limitations

- **Reasoning drift is report-only.** Effort that appears ignored (vercel/ai#21207) is shown in the report and Studio, never retried.
- **Gateway metadata is untyped.** Routing metadata is owned by the gateway service and may change without an SDK release. provider-guard validates it at runtime; when it cannot tell which provider served a call, it records the incident and skips the retry. The field names were confirmed against a live AI Gateway recording on 2026-09-29 (`fixtures/live-ling-3.0-flash-novita.json`), which a test replays.
- **Retries need AI Gateway.** With other providers, calls are still detected and recorded, but not retried.
- **Language models only.** Image, video, embedding, speech, and realtime models are not covered.
- **Runtime.** Node.js 22 or later (as required by `ai@7`) for the file sink, CLI, and Studio. The main entry has no Node imports and runs in Edge runtimes with an in-memory sink.

## If AI Gateway adds `exclude`

AI Gateway ignores a request-level `exclude` today ([vercel/ai#20934](https://github.com/vercel/ai/issues/20934)). If it ships, `exclude()` becomes a thin shim over the native option, and provider-guard will adopt it.

## License

MIT. Not affiliated with Vercel.
