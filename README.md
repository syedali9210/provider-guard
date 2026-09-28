# provider-guard

> **The gateway catches errors. provider-guard catches successes that aren't.**

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
