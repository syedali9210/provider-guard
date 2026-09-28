# NOTES

Decisions and discrepancies found while building v0.1. Newest findings are appended per milestone.

## M0 — tooling and design setup (2026-09-28)

### Geist pages read (as Markdown, `Accept: text/markdown`)
- Foundations: `introduction.md`, `colors.md`, `typography.md`, `materials.md`, `grid.md`
- `icons.md`: **not available** as Markdown (404 on `.md`; the plain URL with the Markdown header returns the introduction page). Icons are drawn locally as 16px inline SVGs.
- Components: `button.md`, `badge.md`, `table.md`, `tabs.md`, `tooltip.md`, `drawer.md`, `sheet.md`, `empty-state.md`, `note.md`, `skeleton.md`, `theme-switcher.md`, `status-dot.md`, `switch.md`, `description.md`, `loading-dots.md`, `spinner.md`, `snippet.md`

### Geist tokens
- The Markdown pages describe the scales (100–1000 usage, backgrounds, materials, typography classes) but not raw values. Raw values were taken from the stylesheet of the official page `https://vercel.com/geist/colors`: light and dark `--ds-*` color scales (hex, plus the `lab()` wide-gamut block under `@supports (color: lab(0% 0 0))`), `--ds-shadow-*`, `--ds-focus-*`, `.material-*` presets, `.text-*` typography classes, and `--ds-motion-timing-swift`. They live in `packages/studio/src/tokens.css`.
- `@vercel/geistcn` and `@vercel/geistcn-assets`: `npm view` returns E404 on 2026-09-28. Per PRD §6.3, only the needed components are implemented locally (button, badge, table, tabs, tooltip, sheet/drawer, theme switcher, select, switch, empty state, note/banner, skeleton), each matched to its `/geist/<component>.md` spec. No third-party "Geist-like" kits.

### Design conflicts and how they were resolved (Geist docs > DESIGN.md > PRD)
- **Casing.** PRD §6.3 says sentence case everywhere. Geist specs require Title Case for button labels, badge text, tab titles, table column headers, sheet titles, and empty-state titles. Geist wins for those component slots; all other copy (descriptions, body, tooltips, results, errors) is sentence case.
- **"Right-side drawer" for Call anatomy.** Geist says Drawer is a bottom sheet for small viewports only and points to `Sheet` (side `right`) for lateral detail context on desktop. Call anatomy uses a right-side Sheet on desktop (non-modal, explicit Close button, Esc closes, focus returns to the row) and a bottom drawer below 600px.
- **Theme toggle.** Geist's Theme Switcher is a Light / System / Dark radio group. That is the toggle; System follows `prefers-color-scheme`.
- **Time range with four options.** Geist Switch is capped at 3 options; past that it says use Tabs or Select. The time range (15m, 1h, 24h, all) is a native `<select>` styled as Geist Select. Replay speed (1x, 4x) is a Switch.
- **Status Dot** is deployment-only in Geist, so call results use Badges instead.
- **DESIGN.md** (unofficial) describes uppercase Geist Mono eyebrows from the marketing site. PRD says no all-caps and Geist docs do not prescribe uppercase for product UI, so there are none.
- **DESIGN.md line 60** contained stray text inside the YAML front matter (`fontWeight: 500 burada komikledin mi yani son DESIGN.md'leri?`), which made it invalid YAML. It was reduced to `fontWeight: 500`. Nothing else in the file was changed.

### Toolchain discrepancies
- **Node version.** PRD says Node ≥ 20 and CI on Node 20 and 22. `ai@7.0.118` and `@ai-sdk/gateway@4.0.96` both declare `engines.node >= 22`, and Node 20 reached end of life on 2026-04-30. provider-guard follows its peer: `engines.node >= 22`, CI matrix Node 22 and 24.
- **TypeScript.** `typescript@7.0.2` (the native Go compiler) no longer ships the JS compiler API (`exports` is only `lib/version.cjs` plus `unstable/*`), which tsup's declaration build needs. Pinned `typescript@6.0.3`. tsup's dts worker sets the `baseUrl` option, which TypeScript 6 rejects as deprecated (TS5101); `ignoreDeprecations: "6.0"` is passed to the dts build only.
- **Test tooling.** `vitest@5` requires Node `^22.12`; `jsdom@30` requires Node `^22.22.2` (local machine runs 22.18), so Studio tests use `jsdom@29`.
- **pnpm.** Corepack 0.33 cannot launch `pnpm@12` (its bin moved from `pnpm.cjs` to `pnpm.mjs`). The repo pins `packageManager: pnpm@10.34.5`.
- **Changesets 3.** `changeset init` is interactive only; `.changeset/config.json` was written by hand and uses `@changesets/cli/changelog` (resolvable from the root under pnpm).

### AI SDK API checks against installed types (`ai@7.0.118`, `@ai-sdk/gateway@4.0.96`, `@ai-sdk/provider@4.0.18`)
- `LanguageModelMiddleware` (from `ai`) = `Omit<LanguageModelV4Middleware, 'specificationVersion'> & { specificationVersion?: string }`. Matches the PRD.
- `wrapGenerate` / `wrapStream` receive `doGenerate()` / `doStream()` **with no arguments** (they close over the transformed params). A retry with different gateway options therefore calls `model.doGenerate(retryParams)` / `model.doStream(retryParams)`. `wrapLanguageModel` passes the next-inner model as `model`, so a retry does not re-enter `guard()` (verified in `ai/dist/index.js`, `doWrap`).
- Core imports types only from `ai` (the peer). V4 stream part, usage, call options, and result types are derived from `LanguageModelMiddleware`, so the published `.d.ts` never references `@ai-sdk/provider` directly.
- V4 finish reason is `{ unified, raw }`; usage is `{ inputTokens: { total, noCache, cacheRead, cacheWrite }, outputTokens: { total, text, reasoning }, raw? }`. Call options carry `reasoning?: 'provider-default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'`, matching the PRD's `reasoningRequested`.
- `GatewayProviderOptions` has an index signature `[key: string]: unknown`, so `exclude` type-checks and is silently ignored (as the PRD says). `has` accepts exactly the capability tags and `quantization:` / `!quantization:` conditions listed in the PRD.
- `GatewayProviderMetadata` is `{ asyncJob?, [key: string]: JSONValue }`; routing metadata is untyped, as expected.
- `GatewayLanguageModel.provider` is always `"gateway"`, and it forwards the full `providerOptions` object in the request body. `guard()` treats `model.provider === 'gateway'` as "served through AI Gateway".
- `ai/test` exports `MockLanguageModelV4`, `simulateReadableStream`, and `convertReadableStreamToArray`.

### Live network calls made
- One call to the public, unauthenticated endpoints API on 2026-09-28: `GET https://ai-gateway.vercel.sh/v1/models/zai/glm-5.3-flash/endpoints` → 200, 19 providers, slugs at `data.endpoints[].provider_name`. Saved as `fixtures/endpoints-zai-glm-5.3-flash.json`.
- No AI Gateway endpoint that needs an API key was called.
- **Biome 2.5.** `rules.recommended` is deprecated in favor of `rules.preset`. `biome migrate --write` rewrote `recommended: true` as `preset: "none"`, which disables every rule; it was corrected by hand to `preset: "recommended"`.

## M1–M4 — core decisions (2026-09-28)

### guard()
- **Routing metadata was not recorded live.** A live recording needs an AI Gateway API key, which the PRD rules out. The fixtures in `fixtures/20932-*.json` are built from the chunk shapes and field names quoted in vercel/ai#20932 and #20934 (`providerMetadata.gateway.routing.{finalProvider, fallbacksAvailable, …}` on the `finish` part). The parser also accepts routing from any earlier part that carries `providerMetadata.gateway`. `fallbacksAvailable` is assumed to be a string array. **Open item:** confirm the location and shape with one real recording (see `scripts/live-repro.ts`), then replace the fixtures.
- "Served through AI Gateway" means `model.provider === 'gateway'` (the value `GatewayLanguageModel` always reports).
- **Skip reasons.** The PRD names `no-alternative-provider`. The other "never retry" rules also record `outcome: 'skipped'`, each with its own reason: `tool-call-emitted`, `aborted`, `retry-disabled`, `unknown-provider`, `not-gateway`, `provider-list-unavailable`, and `report-only` (a detector that returns `retry: false`).
- `providerMetadata.providerGuard` is attached only when a retry produced the result (`recovered` or `still-empty`). When the retry is skipped or fails, the caller gets the original result unchanged.
- `retry.reasoning` applies to streams. In `generateText`, nothing has reached the caller yet, so the retry's full content, including its reasoning, is returned.
- **Records.** One record per *completed* attempt. An attempt that errors or is aborted before its `finish` part writes nothing, the same as without provider-guard. The caught attempt is written after its retry settles, so its `retry.outcome` is final, followed by the retry's record (`retryOf`).
- **`parts` cap.** At most 400 part summaries per attempt (the first 399 plus `finish`); `raw` parts are never recorded. Marked with a `ponytail:` comment in `guard.ts`.
- **Stream mechanics.** The guarded stream is pull-based with `highWaterMark: 0`, so a part is read from the provider only when the consumer asks for it. Cancelling the guarded stream cancels the provider stream and never starts a retry. A retry stream that throws, emits an `error` part, or ends without `finish` is a failed retry: the stream ends with the original `finish` and no error reaches the caller.
- **Default sink.** The main entry must load in Edge runtimes, so it cannot import `node:fs`. The default file sink gets `fs` and `path` from `process.getBuiltinModule` (Node ≥ 22.3) and falls back to a memory sink when that does not exist. `provider-guard/node` exports `fileSink` with static imports. The file sink serializes appends within a process.

### exclude()
- After a failed fetch, the cache waits 30 seconds before fetching that model's list again, so a down endpoints API is not hit on every request. The last known list, or `{}` with `allow-all`, is used in the meantime.
- An empty `endpoints` array is treated as unavailable.

### Report and CLI
- "caught" is any detector flag. "empty" is the `billed-but-empty` flag. "reasoned" is `reasoningChars > 0` or reasoning tokens > 0. Records without a provider are grouped as `unknown`.
- Effort rule: a provider is flat when `(max − min) / min < 25%` between its medians at the lowest and highest requested levels, and responsive when `max / min ≥ 2`. Zero at both levels counts as flat, and `0 → n` counts as responsive. `provider-default` is not an ordered level and is ignored.
- p-values are rounded to 12 significant digits so float noise (for example 0.99999999999998) never shows up in JSON.
- `--no-open` is declared as its own flag because `parseArgs({ allowNegative })` needs Node 22.4 and engines allow 22.0.
- Colors follow Node's precedence: `FORCE_COLOR` (unless `0`/`false`) wins over `NO_COLOR`, then TTY detection and `TERM=dumb`.
- The replay dataset (`scripts/build-replay.ts`) was built in M4 rather than M7 because M4's acceptance runs the report against it.
- `__snapshots__` are excluded from Biome; formatting them breaks byte-exact file snapshots.
