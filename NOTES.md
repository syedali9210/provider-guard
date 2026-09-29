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

## M5–M6 — Studio (2026-09-28)

### Server (`provider-guard studio`, `packages/core/src/studio.ts`)
- **Beyond the two PRD endpoints**, `GET /api/config` tells the UI whether it is live or replay and which file it reads, for the data-source badge. It exposes no record data.
- **Hardening.** Bound to `127.0.0.1`. Requests whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` get 403, so a DNS-rebinding page cannot read records. Anything but GET/HEAD gets 405. Every response carries a CSP (`default-src 'self'`), `nosniff`, `no-referrer`, and `X-Frame-Options: DENY`. The theme bootstrap is an external `theme.js`, so the CSP needs no `'unsafe-inline'` for scripts.
- **Tailing.** Follows the file by byte offset and splits only on the newline byte, which never occurs inside a multi-byte UTF-8 sequence, so a character split across two writes decodes correctly. A shorter file means truncation or replacement, and reading starts over. `fs.watch` (when the file exists) plus `fs.watchFile` polling every 500 ms, because `fs.watch` alone is unreliable on Windows. Verified on Windows by `test/studio.test.ts`, including an append picked up by the watchers alone.
- **No gaps between load and live.** The UI opens the SSE stream first, then loads `/api/records`; records arriving on both are dropped by id.
- **Ports.** 4747, then the next 10. `--port 0` is accepted by the server and resolves to the assigned port (used by the tests).

### UI (`packages/studio`)
- **Geist.** Tokens are generated into `src/tokens.css` from the official values (see M0). Typography classes and materials copy the Geist definitions. All colors reference `--ds-*` tokens.
- **Result wording.** The PRD lists "Delivered", "Caught → recovered on zai", "Caught · retry failed", and "Caught · no other provider". Two more outcomes exist: "Caught · retry still empty" and "Caught · not retried". The latter has a tooltip naming the skip reason.
- **Tokens column.** Shows the billed text / reasoning tokens of the attempt that served the call, which is what makes an empty answer visible ("4 / 2"). The summed usage is in Call anatomy.
- **Hold on hover (not in the PRD).** During replay at 1x, a new row arrives every 800 ms, so rows moved under the pointer and clicks landed on the wrong call. While the pointer is over the list or a row has keyboard focus, the Feed holds its rows still and shows a "Show N New Calls" button: the usual live-tail pattern.
- **Catch animation.** 450 ms, ease-out: flag mark (0–150 ms), line (150–330 ms), retry chip and check (330–450 ms). It plays once per caught call that arrives while the screen is open. With `prefers-reduced-motion`, the class is never applied (checked in JS, and also disabled in CSS), so the final state shows at once.
- **Virtualization.** Above 1,000 calls, only the rows in view (plus 12 of overscan) are rendered, with spacer rows. Keyboard moves to rows that are not rendered yet scroll first, then focus.
- **Charts.** Hand-built SVG, drawn at the figure's measured width, so text stays at its type size instead of scaling with a viewBox. Axis labels skip ticks to stay at least 56 px apart.
- **Phones (≤ 480 px).** The demo link is often opened on a phone. The Feed drops the time and lets the result wrap; Providers drops the reasoned and median columns and the rate bar (the reasoning plot below still shows reasoning). The result and the outlier verdict stay in view without sideways scrolling; Playwright checks both at 375 px.
- **Replay.** All #21207 runs load as history, so the reasoning panel is there at once. The first 55% of #20932 is history, cut two calls before a catch, and the rest plays at 800 ms per call (200 ms at 4x). Datasets are interleaved in the history and timestamps are rebased to now. Replay records have `generationId: null`; no IDs are made up, so that copy button is disabled with a tooltip.
- **Bundle.** 81 KB of JS gzipped (budget 150 KB). Fonts and replay data are separate assets.

### Tooling
- `geist` declares `next` as a peer. With pnpm's `autoInstallPeers`, that installed Next.js just to ship two `.woff2` files, and `packageExtensions` could not make the peer optional. `autoInstallPeers` is off, the missing `next` peer is ignored, and core lists `vite` (vitest's peer) and `zod` (`ai`'s peer) explicitly.
- **Playwright.** The smoke test runs against the static replay build (`vite build --mode replay`), the same artifact the demo deploys. Locally, `PW_CHANNEL=msedge` drives the installed Edge instead of downloading Playwright's Chromium. CI installs Chromium.

## M7 — release and deploy (2026-09-28)

- **Repository.** `github.com/syedali9210/provider-guard`, renamed from `vercel-demo` before the first publish (GitHub redirects the old URLs). `packages/core/package.json` points `repository`, `homepage`, and `bugs` there: npm provenance requires `repository.url` to match the publishing repo exactly. README images use absolute `raw.githubusercontent.com` URLs, so they also render on npmjs.com, which gets a copy of the README without the `docs/` folder.
- **First publish.** npm trusted publishing (OIDC, no token) can only be configured on a package that already exists, so 0.1.0 is published with a short-lived granular token in the `NPM_TOKEN` secret (publish rights, "Bypass two-factor authentication"). After that, a trusted publisher for `release.yml` can replace the token. **0.1.0 was published on 2026-09-29 by Release run 10, with a provenance attestation**; npmjs.com shows "Built and signed on GitHub Actions" and renders the README images.
- **Pitch media.** `e2e/pitch.spec.ts` (run with `PITCH=1`) renders `docs/og.png`, the demo's link-preview image, and `docs/demo.mp4`, a 61-second 1080p video: title, the problem, a live catch, Call anatomy, the Baseten outlier, Bedrock ignoring effort, and the code. The video is built from CDP screencast frames at 2x, so text stays sharp, and encoded with ffmpeg; it is not committed. Only the replay build serves `og.png` and adds the Open Graph tags; the Studio shipped in the npm package does not.
- **Demo.** The Vercel project `provider-guard-demo` (team "syedwali9286-1132's projects") is linked to the repo with root directory `packages/studio`; `packages/studio/vercel.json` sets the build (`vite build --mode replay`), output (`dist-replay`), CSP, and asset caching. Every push to `main` redeploys. The production domain **https://provider-guard-demo.vercel.app** is public. Team-suffixed and per-deployment URLs require Vercel login (the default Standard Protection).
- **Vercel connector limits.** The connector could create the project but could not read it back or create a production deployment (403). The Git integration deploys instead.
- **Release workflow.** The changesets bot flow opens a "Version Packages" PR, which the repository does not allow Actions to do, so every Release run failed. The workflow now publishes whenever `packages/core/package.json` carries a version that is not on npm yet, and versions are applied locally with `pnpm changeset version` (0.1.0 was applied this way). Without an `NPM_TOKEN` secret the run succeeds with a notice that publishing was skipped. Add the secret and re-run to publish `provider-guard@0.1.0` with provenance.
- **A cross-platform race found by CI.** After Esc, focus returned to the Feed row on the next animation frame, so a key pressed right away landed on `<body>`. It passed on Windows and failed on Linux and macOS. Focus now returns synchronously.
- **CI annotations.** `pnpm -r` prefixes each output line with the package name, so Vitest's `::error` lines were not parsed as annotations. CI runs each package's tests in its own step.

## After v0.1: How It Works (2026-09-29)

- **Why.** The owner asked for the backstory on the demo itself, animated, so that a newcomer knows why provider-guard exists and what the screen shows.
- **A Sheet, not a Modal.** Geist keeps Modal for decisions that must block the page and names Sheet (desktop) or Drawer (mobile) for persistent associated context where the page stays readable. The replay keeps playing beside it, so real catches arrive in the Feed while the story is told.
- **Five steps.** One model, many providers → errors fall back → empty successes don't (vercel/ai#20932, 22 of 51) → provider-guard catches them (plus `exclude()` for #20934 and the effort check for #21207) → reading this screen, with a real caught call from the replay drawn by the Feed's own components and catch animation.
- **Motion.** Each step has a small SVG flow diagram: the call is a dot that travels between nodes, 600 ms per hop, and labels fade in as it arrives. It plays once, holds its last frame, and has Play Again. With reduced motion the last frame shows at once. PRD 6.3 allows one orchestrated motion moment (the catch); this second one was requested by the owner and reuses the catch's vocabulary: flag, line to the retry provider, check.
- **Replay only.** PRD 6.1 made the data-source label the only visual difference between modes. At the owner's request, replay mode also has a How It Works button. The panel opens by itself only in the public demo build on a first visit; closing it sets `provider-guard-intro-seen` in `localStorage`, a per-viewer convenience wrapped in try/catch. `studio --replay` shows the button but does not open by itself.
- **Tests.** Unit tests cover the steps, the issue links, playback, reduced motion, and one panel at a time. Playback uses Vitest fake timers with `shouldAdvanceTime`, because Testing Library awaits a real `setTimeout(0)` that plain Vitest fakes stall. Playwright starts past the panel by default (`storageState`) and checks a real first visit, including every step at 375 px.
