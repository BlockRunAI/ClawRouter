# Changelog

All notable changes to ClawRouter.

---

## v0.12.214 — June 28, 2026

Recover tool calls that Gemini 3.5 Flash emits as plain-text transcripts instead of structured `tool_calls` ([#189](https://github.com/BlockRunAI/ClawRouter/issues/189)).

### Gemini `[Called function "…" with args: {…}]` transcripts now become real tool calls

- **Symptom:** through the OpenAI-compatible path, Gemini 3.5 Flash sometimes narrates a tool call as assistant text — `[Called function "terminal" with args: {"command":"whoami"}]` — instead of returning structured `tool_calls` with `finish_reason: "tool_calls"`. Downstream chat surfaces (seen in Chermes/Telegram) then **displayed the transcript** to the user instead of dispatching the tool, stalling agent loops.
- **Fix:** added a third recognizer to `src/textual-tool-calls.ts` (which already synthesizes structured tool calls from OpenClaw `<tool_call>` and Anthropic `<function_calls>` text shapes). The new extractor locates `[Called function "NAME" with args: ` and parses the JSON args with a **balanced-brace scan** that honors string literals — so commas, braces, and `]` inside the JSON can't truncate the match. It only fires when the args parse as a JSON object **and** the block is closed by `]`, so prose that merely quotes the format doesn't mis-fire. Both call sites — streaming and non-streaming in `proxy.ts` — share this function, so the recovered call is forwarded as a proper `tool_calls` delta/message with empty content and `finish_reason: "tool_calls"`.
- **Tests:** 8 new cases in `src/textual-tool-calls.test.ts` (single/multi-arg, empty args, nested JSON with embedded brackets, multiple transcripts with prose stripping, no-mis-fire on missing bracket / non-object args). Full suite **631 passed**, lint + typecheck + build clean.
- **Out of scope:** the issue's secondary `[Tool "function" returned]: {…}` display line is a downstream chat-surface rendering concern, not a ClawRouter normalization gap — left untouched.

---

## v0.12.213 — June 26, 2026

Fix an HTTP 500 (`Failed to parse payment requirements`) that broke paid Base-chain calls whenever a small request seeded the pre-auth cache before a larger one ([#188](https://github.com/BlockRunAI/ClawRouter/pull/188), thanks [@KillerQueen-Z](https://github.com/KillerQueen-Z)).

### Pre-auth no longer reuses a stale amount under per-request pricing

- **Root cause:** the pre-auth cache (`payment-preauth.ts`) is keyed `path:model` and stores a single signed amount, but BlockRun prices each call on `input tokens + max_tokens` — so the **same model costs different amounts** across requests. When a later request needed more than the cached amount, the signed payment underpaid; the gateway rejected it with a 402 that is **not** a fresh x402 challenge, and the old code reused that rejection as the challenge → `getPaymentRequiredResponse` threw → **HTTP 500**.
- **Impact:** every paid Base model failed once a cheaper request seeded the cache before a larger one (any growing/agentic usage — Codex, long contexts). Reproduced on a clean `npx @blockrun/clawrouter@latest`: 12/12 paid models failed `tiny→large`; a 10-turn coding conversation failed ~50% of turns. **Not** affected: free models (no payment) and **Solana** (`skipPreAuth`).
- **Fix (three guards):** (1) **never knowingly underpay** — reuse a cached pre-auth only when the up-front `estimateAmount` (already used for balance checks) proves the cached amount still covers this request; (2) **safety net** — if a pre-auth is rejected anyway, discard it and re-request **without** payment to get a fresh, canonical challenge, never treating the rejection as the challenge; (3) **fail safe** — when no estimate is available, skip pre-auth rather than risk an underpay. The fast path (cached amount covers the request) still pre-signs and skips the 402 round-trip; only would-be underpays fall back to the normal flow.
- **Tests:** new `src/payment-preauth.test.ts` (reuse-when-covered / skip-on-growth / reject-then-refetch / no-estimator); full suite **623 passed**, lint + typecheck clean.

---

## v0.12.212 — June 22, 2026

Stop advertising delisted/redirect aliases in `/v1/models` ([#187](https://github.com/BlockRunAI/ClawRouter/pull/187), thanks [@KillerQueen-Z](https://github.com/KillerQueen-Z)).

### Model list no longer surfaces full-slug redirect aliases

- **`MODEL_ALIASES` mixes two kinds of keys** — friendly short names (`free`, `opus`, `gpt-120b`) and full `provider/model` redirects for backward-compat + delisted models (e.g. `free/deepseek-v4-pro` → `free/deepseek-v4-flash` after V4 Pro's NVIDIA host hung 2026-04-30). `ALIAS_MODELS` turned **every** alias into a listable model, so dead slugs leaked into `/v1/models` (and any downstream picker) as if they were real, available models — a Codex picker built from `/v1/models` showed "DeepSeek V4 Pro (free)" that silently routes to v4-flash.
- **Fix: only surface friendly short aliases (no `/`).** Full-slug redirect aliases are skipped from the advertised list — their target is a real model that's already listed, so nothing the user wants disappears. They remain **fully callable** via `resolveModelAlias()` (which reads `MODEL_ALIASES` directly), so pinned callers don't break. One-line filter in `ALIAS_MODELS`; `MODEL_ALIASES` and resolution logic are untouched.
- **Scope confirmed:** the OpenClaw picker (`VISIBLE_OPENCLAW_MODELS` / `top-models.json`) and the `openclaw.json` allowlist sync are unaffected — every picker entry is a real catalog id, never an alias key. Three delisted-redirect aliases that are _also_ real catalog ids (`openai/o1-mini`, `nvidia/kimi-k2.5`, `google/gemini-3-pro-preview`) drop off the HTTP discovery surface as well — intended: all three are dead redirects whose live successors stay listed, and all stay callable.

### Maintenance

- Formatted `test/test-e2e.ts` (a pre-existing `prettier --check` failure that was red-lining the **Lint & Typecheck** required check on every PR) and added `.pytest_cache/` to `.gitignore`.

---

## v0.12.211 — June 18, 2026

Add Z.AI's new flagship **GLM-5.2** (launched 2026-06-16), aligning with BlockRun's source-of-truth catalog (`zai/glm-5.2`, first in the GLM lineup).

### GLM-5.2 added

- **`zai/glm-5.2` added to the catalog** — 1M-token context (262K max output), paid per-token at $1.40/$4.40 (same rate as GLM-5.1, cached $0.26). Z.AI's newest flagship: beats GPT-5.5 on long-horizon coding at a fraction of the cost. Categories: chat, reasoning, coding.
- **Bare `glm` alias retargeted** GLM-5.1 → **GLM-5.2** (bare alias always tracks the newest flagship). New `glm-5.2` explicit shorthand added. `glm-5.1` explicit pin preserved as the 200K-context predecessor (identical price, so no cost-stability tradeoff — kept for behavioral parity).
- **Picker visibility** — added to `top-models.json` (head of the GLM group), so it surfaces in the OpenClaw `/model` picker and the allowlist sync on next provider refresh. README Mid-Range pricing table updated.
- No router-tier changes: GLM models are accessed by alias/direct call, not wired into any auto/eco/premium tier chain — GLM-5.2 follows the same path. All 619 tests pass.

---

## v0.12.210 — June 16, 2026

Align the free tier with BlockRun's 2026-06-14 free-tier refresh (`blockrun` commit `5817ecd`: self-healing health gate + probe-verified NVIDIA lineup). BlockRun found only 7 of 17 "available" free models were actually being served and replaced the stale manual redirect list with a per-model circuit breaker.

### Free models realigned with the probe-verified lineup

- **`free/qwen3-coder-480b` retired** — NVIDIA EOL'd it on 2026-06-14; BlockRun now redirects `qwen3-coder` → `seed-oss-36b` server-side. Dropped from the auto-pick cascade (`FREE_MODELS`), the picker (`top-models.json`), and the router COMPLEX backstops. The catalog entry + explicit `nvidia/qwen3-coder-480b` alias stay for pinned callers (BlockRun still resolves them via redirect); the generic coding shorthands (`qwen-coder`, `glm-free`, `devstral`, …) now point at the live successor `free/seed-oss-36b`.
- **`free/deepseek-v4-flash` removed from the eco SIMPLE fallback** — NVIDIA upstream hung; BlockRun redirects it. Replaced with the live `free/qwen3-next-80b-a3b-instruct`. Catalog entry kept (still direct-callable, redirects server-side).
- **6 new live free models added** to the catalog + aliases (probe-verified by BlockRun): `free/qwen3-next-80b-a3b-instruct` (262K ctx, reasoning + coding), `free/seed-oss-36b` (coding), `free/mistral-nemotron`, `free/step-3.7-flash` (reasoning), `free/nemotron-nano-9b-v2` (fast lightweight), `free/nemotron-nano-12b-v2-vl` (vision-language).
- **Auto-pick cascade 7 → 12**, gpt-oss kept at the head (heavy-user default — never retired). Picker free set 7 → 8 (`qwen3-coder-480b` → `qwen3-next-80b-a3b-instruct` + `seed-oss-36b`). README/SKILL free-count synced 7 → 8; install-script `/model` help echoes refreshed to live models.

### Updater: clean stale OpenClaw install metadata ([#186](https://github.com/BlockRunAI/ClawRouter/pull/186), thanks [@0xCheetah1](https://github.com/0xCheetah1))

- **`scripts/update.sh` now removes ClawRouter's stale record from `~/.openclaw/plugins/installs.json` after a verified update.** OpenClaw 2026.6 migrates its plugin install index toward shared SQLite; a leftover ClawRouter `installRecords` entry that no longer matches the installed version/path made `openclaw doctor` warn about conflicting install metadata on every run. The updater now compares the legacy record against the current package across the `extensions/`, project-scoped, and global npm layouts, and removes **only** ClawRouter's record (other plugins untouched) when it is stale — guarded by a full try/catch and an atomic write.

---

## v0.12.209 — June 14, 2026

Registry realignment with the 2026-06-13 → 06-14 BlockRun catalog sweep: Fable 5 delisting reverted, Kimi K2.7 promoted, free tier strengthened. 619 tests passing.

### Fable 5 delisting (revert of the 06-11 promotion)

- **`anthropic/claude-fable-5` DELISTED by Anthropic 2026-06-13** (offer withdrawn upstream — no longer served on direct Anthropic or Bedrock). BlockRun removed the catalog entry and redirects fable → `opus-4.8` (`route.ts` MODEL_REDIRECTS). v0.12.208's same-day promotion of Fable 5 to **premium COMPLEX primary** was therefore pointing default premium-tier complex traffic at a now-dead model. Reverted: catalog entry removed, all `fable*` aliases (`fable`, `fable-5`, `fable-5.0`, `anthropic/fable`, `anthropic/claude-fable-5[.0]`) now resolve to `anthropic/claude-opus-4.8`, and premium COMPLEX primary restored to `opus-4.8` (its first fallback before the promotion). Pinned callers silently land on opus-4.8, matching the gateway.

### Kimi K2.7 (BlockRun commit `cd3d79b`, 2026-06-13)

- **`moonshot/kimi-k2.7` added** — Moonshot's new flagship: 256K context, multi-modal (image + **video** input), returns `reasoning_content`. AT-COST pricing **$0.95/$4.00** — identical to K2.6 (BlockRun serves it via the OpenRouter credit pool failing over to direct Moonshot; zero margin by design). Bare aliases (`kimi`, `moonshot`, `kimi-k2`) retargeted K2.6 → K2.7; explicit `kimi-k2.6` / `kimi-k2.5` pins preserved. K2.6 marked superseded (hidden on BlockRun) but stays fully routable as an **identical-cost** first fallback.
- **Router primaries promoted K2.6 → K2.7** (same price, so cost-neutral): `auto.MEDIUM`, `agentic.MEDIUM`, `premium.SIMPLE`. Each keeps K2.6 as its first fallback (in-family hot swap). K2.7 also prepended ahead of K2.6 in the premium MEDIUM/COMPLEX and agentic COMPLEX fallback chains. Picker (`top-models.json`) swapped K2.6 → K2.7.

### Free tier strengthened (BlockRun 06-14 catalog sweep)

- **Auto-pick set 6 → 7**, gpt-oss kept at the head (heavy-user default, deliberately retained despite BlockRun hiding it). Mid/back strengthened with two BlockRun-re-featured free flagships: **`free/mistral-large-3-675b`** (675B general, un-retired — NVIDIA upstream recovered) and **`free/qwen3.5-122b-a10b`** (newest-gen Qwen). `free/deepseek-v4-flash` dropped from the auto-pick set + picker (BlockRun hid it) but stays catalog-routable for direct `$0` calls. New free shorthands: `mistral-large`, `qwen3.5-122b`. eco SIMPLE fallback chain extended with both new models. README/SKILL free-count synced (6 → 7).

---

## v0.12.208 — June 11, 2026

Stop non-English prompts from crashing paid responses via the `x-clawrouter-reasoning` header.

- **Non-ASCII routing reasoning crashed `res.writeHead` after settlement** (`src/proxy.ts`). The routing reasoning string embeds matched keywords from the multilingual lists in `src/router/config.ts` (Cyrillic, CJK, …). Debug headers are on by default, so for e.g. Russian prompts the raw Cyrillic keywords landed in the `x-clawrouter-reasoning` response header and Node rejected the write with `ERR_INVALID_CHAR` — _after_ the upstream call had completed and the x402 payment had settled. The client never received the body and retried, signing a fresh payment each round: a paid retry loop. Header values are now percent-encoded outside printable ASCII (`sanitizeHeaderValue`, reversible via `decodeURIComponent`), and as defense in depth a rejected `writeHead` sanitizes all header values and still delivers the paid body instead of throwing. (Test: `proxy.reasoning-header.test.ts`, 13 cases, including a live Russian-prompt repro through `classifyByRules` validated against Node's `validateHeaderValue`.)
- **`CLAWROUTER_DEBUG_HEADERS=off|false|0`** — new env kill switch for the `x-clawrouter-*` debug headers, for clients that can't set the per-request `x-clawrouter-debug: false` header. Comments claiming the headers were "opt-in" corrected (they are on by default).

---

## v0.12.207 — June 11, 2026

Honor standard proxy environment variables for upstream traffic.

- **`HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` fallback** (`src/upstream-proxy.ts`). Node's fetch (undici) ignores the standard proxy env vars, so users whose system traffic is meant to flow through a local proxy (mihomo/clash without TUN mode, corporate proxies) had ClawRouter connecting _directly_ while their `curl` tests went through the proxy — on throttled routes (e.g. RU → Google-hosted gateway) this surfaced as instant 500s on large request bodies, `Premature close`, and per-model timeouts, while small requests slipped through. When `BLOCKRUN_UPSTREAM_PROXY` is unset, ClawRouter now applies the standard env vars via undici's `EnvHttpProxyAgent`. `NO_PROXY` is honored, and loopback hosts (`localhost`, `127.0.0.1`, `::1`) are always excluded so local health checks and sibling proxies stay direct. `BLOCKRUN_UPSTREAM_PROXY` still wins when set; SOCKS URLs in the standard env vars are _not_ auto-applied (a warning points to `BLOCKRUN_UPSTREAM_PROXY=socks5://…`). (Test: `test/upstream-proxy.test.ts`, 9 cases, dependency-injected — no process-global mutation in tests.)

---

## v0.12.206 — June 10, 2026

End-to-end audit sweep: 4 proxy reliability fixes (each TDD'd with a new regression test), abort/teardown hardening, registry realignment with the gateway, and doc/count sync. 596 tests passing (8 new).

### Proxy reliability (all in `src/proxy.ts` unless noted)

- **Process-crash fix: escaped rejections from the request handler.** The `paymentStore.run(async () => …)` promise wrapping every request was never `.catch()`ed, and the media endpoints (`/v1/images/generations`, `image2image`, `audio`, `videos`) read the request body **outside** their `try` blocks — a client aborting mid-upload rejected the body iterator, escaped the handler, and became an `unhandledRejection`, which kills the whole proxy under Node's default semantics. A safety-net `.catch()` now logs, replies 500 when possible, and never lets a rejection escape. (Test: `proxy.aborted-upload.test.ts`.)
- **Partner-API corruption: `content-length` forwarded after fetch decompression.** `proxyPaidApiRequest` stripped `content-encoding` but kept `content-length`, so any gzipped upstream response (pm/exa/surf/phone/…) reached the client with the _compressed_ length and _decompressed_ bytes → truncated JSON. `content-length` joins the skip list; Node chunks instead. (Test: `proxy.partner-gzip.test.ts`.)
- **Client abort now cancels upstream work in the media + partner paths.** The image/video 202-poll loops kept polling after the client disconnected — and the first `completed` poll **settles the x402 payment**, charging the user for a clip nobody will receive. Both loops (and the partner proxy + media submit calls) now thread an `AbortController` tied to `res` close, bail before the next poll, and pass `signal` into `payFetch`. (Test: `proxy.poll-abort.test.ts`.)
- **Streaming dedup waiters get heartbeats.** A streaming retry that attached to an in-flight identical request waited in silence (no headers, no bytes) for up to minutes — recreating the OpenClaw ~10-15s timeout/retry storm the heartbeat mechanism exists to prevent, and stacking more waiters each round. Waiters now receive SSE headers + `: heartbeat` comments immediately and replay the original's transcript when it lands. (Test: `proxy.dedup-streaming.test.ts`.)
- **Balance check time-bounded at 2.5s** (`BALANCE_CHECK_TIMEOUT_MS`). The pre-request balance check runs before SSE headers; a slow RPC (Solana retry ladder ≈ 34s worst case, and zero balances are never cached) starved streaming clients of their first byte. On expiry the request proceeds optimistically; the in-flight RPC still warms the monitor cache. (Test: `proxy.balance-check-latency.test.ts`, via the existing `_balanceMonitorOverride` seam.)
- **Teardown/leak batch:** partner proxy now `res.end()`s after a mid-stream body-read timeout instead of hanging the client until socket timeout; `readBodyWithTimeout` cancels the stream on timeout (was leaking the undici connection until GC); the budget second-pass 429 path releases the global timeout + close listener; the empty-wallet fallback writes the exclude-aware `freeFallback` pick into the body instead of the hardcoded `FREE_MODEL` (latent exclude-list bypass); the 429-retry success path uses `FREE_MODELS.has()` like its siblings (phantom ~$0.001 session-budget entries); the video poll loop tracks an explicit `completed` flag so a completed-but-empty job no longer reports as "timed out"; `payment-preauth.ts` reuses the rejected pre-auth 402 (which already carries fresh requirements) instead of buying an identical 402 with an extra unpaid round trip.
- **Hot-path perf:** `estimateAmount` now uses a module-level `Map` (the budget pre-check scanned `BLOCKRUN_MODELS` linearly per model → O(n²) per request); `loadExcludeList` (`src/exclude-models.ts`) gained an mtime-validated cache.

### Registry / pricing (gateway alignment, blockrun = source of truth)

- **`anthropic/claude-sonnet-4.5` added** ($3/$15, 200K ctx, vision) — public upstream since the 4.6 launch but missing here entirely; same gap class v0.12.167 fixed for opus-4.5. Pins: `sonnet-4.5`, `sonnet-4-5`, `anthropic/claude-sonnet-4-5`. Bare `sonnet` stays on 4.6; not picker-listed (superseded tier).
- **Seedance i2v telemetry rates un-discounted** — blockrun `403e61e` (2026-06-01) removed the image-to-video discount; the stale `pricePerSecondImageInput` rows (0.13369/0.1742) under-logged i2v cost ~41%. i2v now logs at the text rate. Telemetry-only (payments are server-dictated). Known remaining gap, documented in the comment: blockrun's `RESOLUTION_TOKEN_FACTOR` (1080p = 2.25×) still isn't modeled.
- **`azure/sora-2` added to `VIDEO_PRICING`** ($0.10/s flat, 4s default — a 12s clip was falling back to the generic ~$0.42 telemetry row) and **`openai/gpt-image-2` added to `IMAGE_PRICING`** ($0.06 / $0.12 by size). Both added to README + SKILL docs.
- **Duplicate-id picker entries eliminated** (`src/models.ts`): catalog entries shadowed by an identically-keyed alias (`free`, `openai/o1-mini`, `google/gemini-3-pro-preview`, `nvidia/kimi-k2.5`) are now excluded from `OPENCLAW_MODELS` — `resolveModelAlias` checks aliases first, so those catalog entries were unreachable and advertised the _old_ model's metadata while callers got the redirect target. The picker's double `free` row is gone (39 → 38 = `top-models.json`), and the surviving `free` entry finally says **GPT-OSS 120B** instead of the retired "Nemotron Ultra 253B". (Tests added in `models.test.ts`.)

### Docs / cleanup

- **Free-model count corrected everywhere: 6** (was variously 8, 9, and 10 across README badges/prose and SKILL.md — stale since the 2026-06-07 sweep). README profile table AUTO·MEDIUM cell synced to `kimi-k2.6 ($0.95/$4.00)` (changed in v0.12.174); ECO·REASONING cell named the actual primary (`grok-4-1-fast-reasoning`); doctor sample output and CLAUDE.md now say Node 22 (floor raised in #183).
- **Dead code removed:** `src/router/llm-classifier.ts` (designed LLM-fallback classifier, never wired), the vestigial `walletKeyAuth`/`envKeyAuth` interactive auth methods in `src/auth.ts`, `decompressContent` (codebook), `generatePathMapHeader` (paths); two internal-only functions un-exported.
- **`@noble/hashes` declared as a direct dependency** — `src/wallet.ts` imports it directly but it only resolved via `@scure/*` hoisting (phantom dep; masked at runtime by tsup bundling). Stale tsconfig `exclude` of `error-classification.test.ts` dropped (it typechecks fine).

---

## v0.12.205 — June 8, 2026

Finished de-listing `nvidia/mistral-small-4-119b` after the gateway hid + redirected it (2026-06-08).

- **`nvidia/mistral-small-4-119b` fully de-listed** — the gateway now marks it `hidden` and server-redirects it to `nvidia/llama-4-maverick` (NVIDIA upstream timing out, 3/3 probes >60s). All five alias targets that still resolved to `free/mistral-small-4-119b` (`nvidia/mistral-small-4-119b`, `nvidia/mistral-large-3-675b`, `free/mistral-large-3-675b`, `mistral-free`, `mistral-small`) now resolve to `free/llama-4-maverick`, matching the gateway. Removed from the model catalog and the `/model` picker (`top-models.json`); README budget row dropped. (Test pricing fixture kept as a generic $0 entry.)

## v0.12.204 — June 8, 2026

Free-tier routing realigned to the backend's 2026-06-07 model sweep.

- **`nvidia/qwen3-next-80b-a3b-thinking` removed** — NVIDIA end-of-life 2026-05-21 (HTTP 410; server redirects to `nvidia/llama-4-maverick`). Dropped from the auto-pick set, the `/model` picker (`top-models.json`), the eco-tier fallback chain, and the model catalog. All 15 alias/redirect targets that pointed at it (the nemotron family, `qwen-thinking`, `qwen3-next`, the `nvidia/qwen3-next…` identity) now resolve to `free/llama-4-maverick`, matching the gateway.
- **`nvidia/glm-4.7` de-listed from auto-pick + picker** — NVIDIA NIM deployment hung; the gateway redirects it to `nvidia/qwen3-coder-480b`. Its aliases (`nvidia/glm-4.7`, `glm-free`) now resolve to `free/qwen3-coder-480b`. (Catalog entry kept so direct `free/glm-4.7` calls still price at $0.)
- **`nvidia/mistral-small-4-119b` dropped from auto-pick + eco fallback** — upstream timing out (3/3 probes >60s). Still directly callable (alias resolution intact, officially `available` server-side); just no longer a smart-routing target. README annotated.

---

## v0.12.203 — June 6, 2026

- **GLM flat pricing fully retired (backend d840de7).** Z.AI's remaining flat $0.001/call promos ended 2026-06-06: `zai/glm-5` now bills per-token at $0.60/$1.92 and `zai/glm-5-turbo` at $1.20/$4.00 (glm-5.1 stays $1.40/$4.40). Their permanent `flatPrice` fields are removed so payment pre-estimation sizes per-token again; the `flatPrice` mechanism itself stays for any future flat-billed SKU. README pricing rows updated.

---

## v0.12.202 — June 6, 2026

- **Upstream delistings mirrored (gateway health probe 2026-06-06).** `openai/o1-mini` 404s at OpenAI and `google/gemini-3-pro-preview` 404s at Google; the gateway hid both and redirects them (`o1-mini` → `o4-mini`, `gemini-3-pro-preview` → `gemini-3.1-pro`). ClawRouter mirrors the redirects in `MODEL_ALIASES` (pinned callers land on the successor instead of an upstream error), drops gemini-3-pro-preview from the picker, and removes it from the AUTO COMPLEX fallback chain (it would have silently resolved to the tier primary anyway).

---

## v0.12.201 — June 5, 2026

- **Catalog sync with BlockRun backend (2026-06-04/05 model drops + repricing).**
  - **New xAI models** (`src/models.ts`, `src/top-models.json`): `xai/grok-4.3` ($1.50/$4.00, 1M ctx, reasoning + vision + agentic) and `xai/grok-build-0.1` ($1.50/$3.00, 256K, agentic coding) — both resold via BlockRun's OpenRouter credit pool and public in the backend catalog, so both are picker-visible. Aliases: bare `grok` promoted `xai/grok-3` → `xai/grok-4.3` (grok-3 and the 4-fast/4-1-fast families are now hidden on BlockRun; explicit IDs still resolve). `grok-code` repointed `deepseek/deepseek-chat` → `xai/grok-build-0.1` (xAI again has a real coding SKU); new pins `grok-4.3`, `grok-build`. The delisted `grok-code-fast-1` redirects stay on cheap chat.
  - **`deepseek/deepseek-v4-pro` added to the catalog** ($0.435/$0.87 — the 75% launch promo became DeepSeek's permanent list price after 2026-05-31; 1M ctx, reasoning + agentic). Fixes a latent picker bug: `top-models.json` already listed it, but with no `BLOCKRUN_MODELS` entry the `VISIBLE_OPENCLAW_MODELS` filter silently dropped it. `deepseek-chat`/`deepseek-reasoner` entries refreshed from stale V3.2 ($0.28/$0.42, 128K) to V4 Flash ($0.20/$0.40, 1M).
  - **GLM flat pricing modeled correctly** (`src/models.ts`): new permanent `flatPrice` field on `BlockRunModel` (backend `billingMode: "flat"`; takes precedence in `getActivePromoPrice`). `zai/glm-5` and `zai/glm-5-turbo` switch from an expired promo (ended 2026-04-15 in our metadata) to permanent flat $0.001/request — they had been mis-estimated per-token for 7 weeks. `zai/glm-5.1`'s promo end corrected to 2026-06-05 (when BlockRun actually ended it); it now bills per-token $1.40/$4.40.
  - **Router untouched:** tier primaries/fallbacks in `src/router/config.ts` are benchmark-driven; grok-4.3 / grok-build-0.1 / v4-pro enter routing only after they get benchmark rows.
  - **Docs:** README pricing tables refreshed (deepseek V4 rows, glm flat rows, grok-4.3 / grok-build-0.1 / minimax-m3 / glm-5.1 added); `skills/clawrouter/SKILL.md` model list updated.

---

## v0.12.198 — May 29, 2026

- **Claude Opus 4.8 is now the Anthropic flagship.** BlockRun's source-of-truth model registry (`blockrun/src/lib/models.ts`) shipped `anthropic/claude-opus-4.8` as its current featured flagship — $5/$25 per 1M (identical to 4.7), 1M context, 128K output, adaptive thinking, `fallbackModel: claude-opus-4.7`. This release aligns ClawRouter:
  - **Model registry** (`src/models.ts`): added `anthropic/claude-opus-4.8` to `BLOCKRUN_MODELS` (mirrors the 4.7 spec — 1M ctx, 128K out, reasoning/vision/agentic/tools).
  - **Aliases** (`src/models.ts`): bare `opus`, `opus-4`, `anthropic/opus`, and generic `anthropic/claude-opus-4` now resolve to 4.8, matching BlockRun (where bare opus / `clawrouter-premium` redirect to 4.8). New explicit pins `opus-4.8` / `opus-4-8` / `anthropic/claude-opus-4-8`. Explicit `opus-4.7` / `opus-4.6` / `opus-4.5` pins stay routable on their own version for cost-stability callers.
  - **Router** (`src/router/config.ts`): `premiumTiers.COMPLEX` primary promoted `claude-opus-4.7` → `claude-opus-4.8` (cost-neutral — same $5/$25), with 4.7 inserted as the first in-family fallback. 4.8 also inserted ahead of 4.7 in the premium REASONING, agentic COMPLEX, and agentic REASONING fallback chains. `selector.ts` baseline left on 4.7 (pricing-identical; no savings-math change).
  - **Picker** (`src/top-models.json`): added 4.8, removed 4.6 (already hidden on BlockRun). Picker now shows opus-4.8 + opus-4.7; 4.6 stays resolvable via explicit alias. Note: existing users carry stale `cfg.models.providers.blockrun.models` arrays (OpenClaw merges, never deletes), so the 4.6 removal only takes effect on a fresh prune/re-install — same caveat as v0.12.175.
  - **Diagnostics** (`src/doctor.ts`): `doctor opus` deep-analysis model bumped to 4.8 (identical cost).
  - **Docs**: README pricing tables/examples and `skills/clawrouter/SKILL.md` model list refreshed.
  - No provider-routing or `thinking`-block changes: 4.8's adaptive-thinking contract is identical to 4.7's, which ClawRouter has routed in production without injecting explicit thinking blocks.

---

## v0.12.197 — May 27, 2026

- **Plugin now loads at gateway boot (manifest capability declarations).** OpenClaw 2026.5.x's strict gateway-boot plugin loader requires the manifest to declare the capabilities a plugin provides. `openclaw.plugin.json` declared none (`Shape: non-capability`), so after `openclaw gateway restart` the loader silently **skipped** ClawRouter: the x402 proxy never bound `:8402`, the BlockRun provider/web-search/partner tools never registered, and `/wallet`, `/blockrun`, `/stats` etc. returned "no such command" inside the TUI. Install-time hot-reload is lenient and still loaded the plugin, which masked the regression — `openclaw plugins doctor` was the tell, repeating `clawrouter: plugin must declare contracts.tools before registering agent tools` 26×. Fix adds the four declarations the strict loader needs:
  - `contracts.tools` — the 26 partner tools registered at runtime (`blockrun_predexon_*`, `blockrun_stock_*`, `blockrun_crypto_*`/`fx_*`/`commodity_*`, `blockrun_image_*`, `blockrun_video_generation`, `blockrun_phone_*`, `blockrun_voice_*`). Verified to be an **exact match** to `src/partners/registry.ts` runtime registration — no missing, no extra.
  - `contracts.webSearchProviders: ["blockrun-exa"]` — the Exa-backed web search provider (`src/web-search-provider.ts`).
  - `providers: ["blockrun"]` — declares ownership of the `blockrun/*` model IDs (`src/provider.ts`), same pattern as `anthropic`/`openai`.
  - `activation.onStartup: true` + `enabledByDefault: true` — opt into the trusted boot-load path so the proxy comes up at gateway start instead of lazy-loading.

  Manifest-only change (static JSON read directly by the loader, not bundled into `dist/`); it does not touch the runtime config-write path, so it cannot trip OpenClaw's `baseHash` `ConfigMutationConflictError`. Closes the gateway-restart load failure on OpenClaw 2026.5.19+. Contributor credit: PR [#171](https://github.com/BlockRunAI/ClawRouter/pull/171) by [@bogdan-velicu](https://github.com/bogdan-velicu) — first-time contributor, thorough repro + verification writeup. 🎉

- **Ships v0.12.195's Seedance pricing fix (latent stale-`dist/`).** v0.12.195 updated `src/proxy.ts` to the 720p+audio per-second rates (e.g. `seedance-1.5-pro` `$0.04375/sec` → `$0.0875/sec`), but the committed `dist/` bundle at v0.12.195 **and** v0.12.196 was never rebuilt from that source — both releases shipped the old 480p-baseline pricing, so the local `estimateVideoCost` telemetry kept under-reporting Seedance usage by ~2× (payment is server-dictated, so no overcharge — telemetry only). This release rebuilds `dist/` from current source, so the corrected Seedance per-second rates finally land in the published bundle.

---

## v0.12.196 — May 24, 2026

- **Updater recovers from OpenClaw size-drop rejection.** OpenClaw v2026.4.5+ refuses to write a config that would shrink the file by a large amount (data-loss guard). Users on a pre-v0.12.175 install carry ~175 entries in `models.providers.blockrun.models`; upgrading to a current ClawRouter legitimately trims that to ~38 (≈90 KB → 25 KB), tripping OpenClaw's guard. The updater previously surfaced this as a hard failure and rolled back, stranding users on the old version. Fix in `scripts/update.sh`: pipe the install output to a captured log, detect the `Config write rejected: …size-drop:` signature, validate the rejected payload against a conservative checklist (top-level keys unchanged, required sections present, model count actually shrank, curated count in [20, 100], non-model sections drift ≤ 2 KB, residual models section ≤ 4 KB, ≥ 65% of the drop comes from the model list), apply just the scoped model-list trim atomically (`tmp.PID` → rename), then fall through to a direct `npm pack` install of the latest version. The EXIT/INT/TERM rollback trap stays active across the fallback path so Ctrl+C still restores the previous install. Tested on a real VPS reproducing the 90728 → 25514 rejection.
- **Contributor credit.** PR [#170](https://github.com/BlockRunAI/ClawRouter/pull/170) by [@0xCheetah1](https://github.com/0xCheetah1).

---

## v0.12.195 — May 23, 2026

- **Seedance 720p + audio defaults aligned with blockrun re-enable.** Blockrun took the three Seedance entries offline on 2026-05-21 (`available:false`, returning `400 "not currently available"` on POST) after user reports of (1) 480p output without audio, visibly worse than JiMeng on the same prompt, and (2) the missing real-person enrollment flow. On 2026-05-22 (commit `e6dc1f1`) they re-enabled all three with `resolution=720p` + `generate_audio=true(t2v) / false(i2v)` defaults in the videos route, doubling the per-second token count from `10128` → `20256`. ClawRouter's `VIDEO_PRICING` table was sized for the 480p baseline, so the local `estimateVideoCost` was under-reporting wallet `logUsage` by ~2× for the past day (payment is fully server-dictated, so no overcharge — telemetry only, per `feedback_telemetry_vs_payment`). Updated `src/proxy.ts`:
  - 1.5 Pro: `$0.04375/sec` → `$0.0875/sec` (flat — no image discount; token360 prices text and image inputs at the same per-M rate).
  - 2.0 Fast: text `$0.11343/sec` → `$0.22687/sec`, image `$0.06684/sec` → `$0.13369/sec`.
  - 2.0 Pro: text `$0.14179/sec` → `$0.28358/sec`, image `$0.08710/sec` → `$0.17420/sec`.
  - Header comment refreshed to call out the 720p+audio default and the doubled tokens/sec.
- **5s default-call telemetry now lands at:** 1.5 Pro ~$0.46 (was $0.23), 2.0 Fast ~$1.19 text / ~$0.70 image (was $0.60 / $0.35), 2.0 Pro ~$1.49 text / ~$0.91 image (was $0.74 / $0.46). All within ~1% of blockrun's quote at the new 720p settings.
- **Discovery surfaces refreshed.** `src/partners/registry.ts` `video_generation` entry now advertises the 720p+audio defaults, declares `image_url` + `real_face_asset_id` as explicit params (both already worked via raw body passthrough — this just makes them discoverable to agents and the `/v1/partners` listing), and updates the pricing display to the new `$0.46–$2.98` range. `README.md` pricing table + explanatory paragraph and `skills/clawrouter/SKILL.md` headline rewritten in the same shape — the old "480p, ~10,128 tokens/sec, $0.23–$0.74 / 5s" copy from v0.12.194 is now stale on every surface.
- **No proxy whitelist or routing change.** Seedance was already in the video proxy path; the re-enable on blockrun's side restored POST without ClawRouter needing to flip any flag. Aliases (`seedance`, `seedance-1.5`, `seedance-2-fast`, `seedance-2`) and the `/videogen` slash command continue to work as before.

---

## v0.12.194 — May 18, 2026

- **Seedance video pricing aligned with blockrun's token-priced model.** Last week blockrun replaced the flat per-second Seedance pricing with `duration × tokens/sec × $/1M tokens × 1.05 margin` after a verification call against `bytedance/seedance-2.0-fast` measured 10,128 tokens/sec at 480p (token360's default, not the 720p we'd guessed). The old ClawRouter `VIDEO_PRICING` table was both wrong-shaped and ~3–4× off on the high side. Updated `src/proxy.ts`:
  - `VIDEO_PRICING` now stores base `$/sec` (no margin baked in — `estimateVideoCost` still applies the 5% margin to match server's `MARGIN_PERCENT`). Per-second values are derived from `10128 × $/1M tokens / 1e6`.
  - New optional `pricePerSecondImageInput` field per model. 2.0 Fast and 2.0 Pro charge ~40% less per token on image-to-video (token360's published image rate); 1.5 Pro stays flat because its audio-generation toggle isn't yet wired to a request param, and undercharging when audio is on by default would be silent loss.
  - `estimateVideoCost(model, durationSeconds, hasImageInput)` picks the cheaper image rate when the request body has `image_url`. The video route now parses `image_url` presence alongside `model` + `duration_seconds` and threads it into the cost callsite (`src/proxy.ts:2706, 2876`).
  - **Net effect** on the default 5s call telemetry: 1.5 Pro $0.16 → $0.23, 2.0 Fast $0.79 → $0.60 text / $0.35 image, 2.0 Pro $1.58 → $0.74 text / $0.46 image. Matches blockrun's quoted prices to within rounding. This is telemetry-only — payment is fully server-dictated via x402 (`feedback_telemetry_vs_payment`).
- **BytePlus RealFace passthrough documented (no code change needed).** blockrun added an optional `real_face_asset_id` body field (format `ta_xxxxxxxx`) on Seedance 2.0 variants for real-person character consistency across frames. The ClawRouter video route already forwards the raw request body to blockrun as-is, so RealFace works transparently — but the README + `skills/clawrouter/SKILL.md` headline didn't mention it. Updated both with usage notes, the per-1M-token pricing model, and the constraint that RealFace + `image_url` are mutually exclusive (both seed the first frame; pick one).
- **Surf skill refreshed against blockrun's real `/gateway/v1` catalog (83 endpoints).** The first Surf skill (v0.12.193) was drafted in parallel with blockrun's integration and ended up out of sync once blockrun:
  - Switched to `api.asksurf.ai/gateway/v1` (real public gateway, 82–83 real endpoints) and dropped 15 invented routes the skill had described.
  - Pre-validates required query params per endpoint **before settling payment** — call with a missing param and you get `400 { missing_params, all_required, docs }` and the wallet isn't charged. 56 of 83 endpoints have required params.
  - Dropped surf-1.5 chat (`/surf/chat/completions`) again pending per-token billing — calling it now returns 404 without taking payment.

  Updated `skills/surf/SKILL.md`:
  - Endpoint count 84 → 83, removed the Chat section, added the required-param pre-check note up front.
  - Fixed param names that the agent would otherwise feed incorrectly and trip the pre-check 400: `social/mindshare` is `q` + `interval` (not `project` + `window`), `search/*` family is `q` (not `query`), `token/holders` + `token/transfers` need `address` AND `chain`, `onchain/gas-price` needs `chain`, `onchain/tx` needs `hash` + `chain`, exchange family universally needs `pair`, market family uses `symbol`, prediction-market endpoints use their specific identifier params (`market_slug`, `event_slug`, `condition_id`, `market_ticker`, `event_ticker`, `ticker`, `address`), and `fund/ranking` + `project/defi/*` need `metric`.
  - Reworded the example flows that previously used wrong param names (`search/project?query=ethena` → `?q=ethena`, mindshare example fixed).

- **Phone skill — voice/call `from` is now optional with server-side auto-pick.** blockrun moved `from` from required → optional on `/v1/voice/call`. After payment verification the server picks a caller-ID from the wallet's owned numbers: 0 active → `403 no_active_number` with buy-first hint, exactly 1 → auto-used, 2+ → `400 ambiguous_from` listing all candidates. The prior skill said "Otherwise Bland picks one" — wrong, and would have made agents leave `from` off and confuse users with the 403/400 responses. Updated `skills/phone/SKILL.md` with the actual auto-pick rule table and the ownership-mismatch 403 behavior.
- **No code change for `real_face_asset_id`, no new partner tools, no proxy whitelist change.** Surf + Phone are both base+skill integrations (per the v0.12.193 rule). All blockrun upstream changes here flow through the existing `proxyPaidApiRequest` path transparently.

---

## v0.12.193 — May 17, 2026

- **Surf integration — first skill-only marketplace API.** BlockRun launched the Surf unified crypto data API ([blockrun.ai/marketplace/surf](https://blockrun.ai/marketplace/surf)) — 84 endpoints across 13 domains: CEX/DEX markets, on-chain SQL over 80+ ClickHouse tables (Ethereum, Base, Arbitrum, BSC, TRON, HyperEVM, Tempo), 100M+ labeled wallets, prediction markets (Polymarket + Kalshi), social/CT mindshare, news, project/DeFi metrics, token analytics, unified search, VC fund intelligence. Settles directly to Surf's Base treasury in USDC; no Surf account or API key required.
- **New release pattern: base whitelist + skill, no typed wrappers.** Earlier integrations (Predexon, Phone/Voice) wrote 200–400 lines of TypeScript per partner in `src/partners/registry.ts` — hand-authored summaries of each endpoint exposed as `blockrun_*` tools. That pattern doesn't scale: Surf alone has 84 endpoints, and the next BlockRun-marketplace API will have more. From this release forward, new partner APIs ship as a **skill** (markdown the agent reads on demand) plus a one-line addition to the proxy namespace whitelist. The agent reads `skills/<api>/SKILL.md`, crafts the HTTP call, and gets paid x402 settlement transparently. **Adding a new Surf endpoint requires zero ClawRouter release.** This matches the Anthropic Skills convention ([github.com/anthropics/skills](https://github.com/anthropics/skills)) and aligns with how Claude Code is designed to consume capability surfaces.
- **Proxy whitelist.** Extended the partner-route regex at `src/proxy.ts` to match `/v1/surf/*`. Requests flow through the existing `proxyPaidApiRequest` (x402 handled transparently). New `isSurf` branch in the telemetry hook emits `tier: "SURF"` with `model = "surf/<operation>"` so `clawrouter stats` and `clawrouter report` see Surf usage as a distinct line — distinct from LLM, generic Partner, and Phone tiers. Updated `proxyPaidApiRequest` JSDoc + the inline route comment to document the new namespace.
- **No registry entries — no `blockrun_surf_*` tools.** Deliberate. The agent reads `skills/surf/SKILL.md` for the endpoint catalog and crafts calls to `http://127.0.0.1:8402/v1/surf/...` directly. Skip the duplication.
- **`skills/surf/SKILL.md` (new).** Full endpoint reference grouped by domain (Exchange, Market Overview, News, On-Chain, Prediction Markets, Project + DeFi, Social/CT, Token Analytics, Unified Search, VC Fund, Wallet Intelligence, Web, Chat). Pricing tier table ($0.001 / $0.005 / $0.020). Four worked example flows (wallet ID, token concentration, custom on-chain SQL with schema-fetch pattern, project mindshare lookup). Frontmatter triggers cover the natural-language queries an agent would phrase to find this skill (`"onchain sql query"`, `"wallet labels api"`, `"crypto mindshare"`, etc.).
- **`skills/clawrouter/SKILL.md` headline update** — per the `feedback_skill_dual_layer` rule. Added "Crypto Data (Surf) — skill-only integration" section after Prediction Markets, explaining the new base+skill pattern and pointing at the dedicated `surf` skill. Frontmatter `description` and `triggers` extended to surface Surf capabilities. Without this headline update, agents reasoning about crypto-data tasks would skip ClawRouter even with the dedicated `surf` skill present.
- **README** — new "Crypto Data (Surf)" section between Phone & Voice and Models & Pricing, with the pricing table, three curl examples (price, batch wallet labels, on-chain SQL), and a link to `skills/surf/SKILL.md`. Notes that this is the new pattern for marketplace APIs.
- **`openclaw.plugin.json` description** — mentions Surf so the OpenClaw plugin browser surfaces the capability.
- **Tests** — new `src/proxy.surf-routing.test.ts` mirrors the partner-path regex literal and adds 10 assertions: positive matches for `/v1/surf/{market/price,onchain/sql,wallet/labels/batch,prediction-market/polymarket/markets,chat/completions}`, negative guards against `/v1/surfer/*`, `/v1/surfaces/*`, and bare `/v1/surf` (no trailing slash), plus regression guards for existing partner paths (`/v1/pm/*`, `/v1/exa/*`, `/v1/phone/*`, `/v1/voice/*`, `/v1/stocks/*`) and non-partner `/v1` routes (`/v1/chat/completions`, `/v1/models`, `/v1/images/generations`). Mirroring the regex literal here means any silent regex edit fails loudly in CI.
- **Aborted course-correction in the same session** (process note worth recording): the first pass of this integration also added 11 typed `blockrun_surf_*` tools to `src/partners/registry.ts` (~470 lines) and generalized the `__dynamic__` handler in `src/partners/tools.ts`. Reverted both before commit on user feedback — Surf doesn't belong in `registry.ts`, and generalizing the dynamic handler without a second user would have been speculative. **Lesson:** mirroring the Predexon/Phone pattern by reflex skips the question of whether the pattern itself still scales. With Surf at 84 endpoints, it doesn't. New rule: typed partner wrappers are reserved for narrow, high-leverage APIs (≤12 endpoints, agent-facing tools that benefit from JSON-schema validation in OpenClaw). Everything else is base + skill.

---

## v0.12.192 — May 16, 2026

- **Phone & Voice integration — BlockRun's phone capability stack is now first-class in ClawRouter.** BlockRun shipped 8 phone endpoints earlier this cycle (Twilio for number intelligence + provisioning, Bland.ai for AI-powered outbound voice calls), all x402-gated behind `blockrun.ai/api/v1/phone/*` and `blockrun.ai/api/v1/voice/*`. ClawRouter had **zero integration** — agents reasoning about phone tasks would skip ClawRouter entirely (per the `feedback_skill_dual_layer` rule: if `skills/clawrouter/SKILL.md` doesn't list a BlockRun capability, AI agents ignore the local proxy and hit the gateway directly, losing wallet/telemetry/local visibility). This release closes the gap on every surface.
- **Proxy paths.** Extended the partner-route regex at `src/proxy.ts:2782` to match `/v1/phone/*` and `/v1/voice/*`. Both flow through the existing `proxyPaidApiRequest` (x402 handled transparently). New `isPhone` branch in the telemetry hook emits `tier: "PHONE"` with model = `phone/<operation>` (so `clawrouter stats` and `clawrouter report` see phone usage as a distinct line). `PHONE_PRICING` table mirrors server-side `twilio.ts` + `bland.ts` pricing (longest-prefix match handles `/voice/call/{id}` poll URLs correctly) and is used only as the telemetry fallback when the x402 paymentStore is empty — actual settlement is always server-dictated.
- **Tool registry.** Eight new entries in `src/partners/registry.ts` (`PartnerCategory` union extended with `"Communications"`):
  - `blockrun_phone_lookup` ($0.01) — carrier + line type
  - `blockrun_phone_lookup_fraud` ($0.05) — SIM-swap + call-forwarding signals
  - `blockrun_phone_numbers_buy` ($5.00 / 30 days) — provision a US/CA number tied to the wallet
  - `blockrun_phone_numbers_renew` ($5.00 / +30 days) — extend lease
  - `blockrun_phone_numbers_list` ($0.001) — wallet's active numbers
  - `blockrun_phone_numbers_release` (free) — release a number back to the pool
  - `blockrun_voice_call` ($0.54 flat, ≤30 min) — outbound AI voice call via Bland.ai
  - `blockrun_voice_status` (free) — poll call status / transcript / recording
  - Voice-call tool description carries an explicit safety guardrail: "places a REAL outbound phone call to a real number — only invoke when the user has explicitly asked." Server enforces an emergency-number blocklist; ClawRouter trusts upstream rather than duplicating the list.
- **`/cr-call` slash command** in `src/index.ts`, registered alongside `/cr-imagegen` and `/videogen`. Syntax: `/cr-call +1<E.164> "<task>" [--voice nat] [--max-duration 5] [--from +1<owned-number>] [--language en-US]`. New `parseCallArgs` helper handles both `--key=value` and `--key value` flag forms, recognizes the first `+E.164`-shaped token as the destination, and packs the rest as the natural-language task. Mode is **fire-and-forget**: the command POSTs to `/v1/voice/call`, returns `call_id` + `poll_url` immediately, and tells the user to poll for transcript when the call completes. The `cr-` prefix is mandatory — `/call` and `/phone` are even more commonly reserved by chat platforms than `/imagegen` was when v0.12.190 had to rename it; we don't register either bare form.
- **`clawrouter phone` CLI subcommand** in `src/cli.ts` covers the wallet-resource operations that don't make sense as chat slash commands:
  - `clawrouter phone numbers list` — formatted table with E.164, country, expiry-in-days, `⚠ renew soon` flag for ≤2 days remaining
  - `clawrouter phone numbers buy <US|CA> [--area-code <code>]` — provision
  - `clawrouter phone numbers renew <+E.164>` — extend lease
  - `clawrouter phone numbers release <+E.164>` — release
  - `clawrouter phone lookup <+E.164>` — quick carrier check
  - `clawrouter phone fraud <+E.164>` — quick SIM-swap check
  - All subcommands POST to the running proxy at `127.0.0.1:8402`; payment flows through the existing wallet. 402 errors render with a friendly "fund your wallet" hint.
- **SKILL.md double-layer update**, per `feedback_skill_dual_layer` rule:
  - `skills/clawrouter/SKILL.md` — added "Phone & Voice (Twilio + Bland.ai)" section after Image & Video, with the full 8-tool table; updated frontmatter `description` and `triggers` to mention phone capabilities. Without this headline update, AI agents would route around ClawRouter when reasoning about phone tasks even with the partner registry populated — they need to see the capability surfaced where they're already looking.
  - `skills/phone/SKILL.md` (new) — dedicated reference: full HTTP API for each endpoint, parameter tables, fire-and-forget polling explanation, three example agentic flows (verify-before-text, appointment confirmation, acquire-caller-ID).
- **README** — new "Phone & Voice Calls" section between Image Editing and Models & Pricing, with the pricing table, slash command + CLI examples, raw `curl` HTTP usage, and the same safety guardrail surfaced in the tool description.
- **`openclaw.plugin.json` description bump** — mentions phone + voice capability so the OpenClaw plugin browser surfaces it.
- **Out of scope (deferred):** local recording/transcript download (recordings can be large; returning Bland.ai's hosted URL is sufficient for v1), auto-polling voice-call status to completion in the slash command (user opted for fire-and-forget so the chat experience returns immediately), SMS/MMS (BlockRun hasn't exposed yet), auto-renew on lease expiry (CLI surfaces the warning, user decides).
- **Two telemetry bugs surfaced and fixed during real-call smoke testing** (placed an actual $0.54 call to `+15707043521` via the patched dist; tx `0xfe6c6b5e...` settled on Base; wallet reconciliation correct: $84.49 → $83.95 = exactly one $0.54 debit). Both bugs were pure logging artifacts — wallet was never wrongly debited — but they would have given misleading numbers in `clawrouter stats` and `clawrouter report`. Both fixes consolidated into a new exported pure helper `resolvePhoneTelemetryCost` (in `src/proxy.ts`) with 8 unit tests locking down the gates:
  - **Bug 1 — phantom $0.54 charge on 4xx voice POST.** First smoke test POSTed `/v1/voice/call` with empty `{}` body to exercise routing without spending money. BlockRun returned 400 (Zod validation: "expected string, received undefined"). The wallet wasn't charged, but the telemetry hook saw `paymentStore.amountUsd = 0` and fell back to `estimatePhoneCost("/v1/voice/call") = $0.54`. Stats would record a phantom voice call. Fix: gate the fallback on `upstream.status`being 2xx — any 4xx/5xx skips the fallback and logs`$0`.
  - **Bug 2 — GET poll miscounted as another $0.54 voice call.** After placing a real call, polling `GET /v1/voice/call/{call_id}` for transcript status (free upstream) was being logged at $0.54 because the longest-prefix match on `voice/call/` triggered the same fallback row as the initiating POST. Every 30s poll would inflate stats by $0.54. Fix: also gate the fallback on `req.method === "POST"` — GET polls log `$0`.
  - **Refactor**: gate logic was originally inline inside `proxyPaidApiRequest`. Pulled it out into `resolvePhoneTelemetryCost(args)` so the rules are independently testable (the call site is now four lines passing an args bag through the helper). Adds 8 vitest cases covering: paid-amount-wins, 4xx phantom guard, GET poll guard, 5xx guard, missing-method guard, non-phone-passthrough, and the original "successful POST with empty paymentStore → fallback" path. Without the helper extraction, locking these gates in tests would have required a full integration test with a mocked upstream — too heavy for telemetry-only logic.
- **Tests** — new `src/proxy.phone-routing.test.ts` (regex matching for /v1/phone/\*, /v1/voice/\*, /v1/voice/call/{id} poll, plus negative case for /v1/phonebook), `src/proxy.phone-pricing.test.ts` (longest-prefix matching + the 8 `resolvePhoneTelemetryCost` gate cases above), `src/parse-call-args.test.ts` (both flag forms, quoted task spans, E.164 first-token detection). Total 31 new test cases; all 569 vitest tests green; typecheck + lint clean.
- **Smoke test record** (free-tier verification before the real call): list-numbers ($0.001) returned an existing wallet-owned number `+15707043521` (PA, expires 2026-06-15); lookup ($0.01) on that same number returned full Twilio carrier metadata (`type: nonFixedVoip`, `carrier_name: Twilio - SMS/MMS-SVR`); negative test `/v1/phonebook/test` correctly rejected by the partner regex (502 from chat-completion fallback rather than partner routing); CLI table formatting + expiry-warning logic verified by `clawrouter phone numbers list`.

---

## v0.12.191 — May 14, 2026

- **`free/deepseek-v4-pro` delisted from the model picker** — NVIDIA's V4 Pro deployment has been hung since 2026-04-30 (verified: connection hangs indefinitely, no bytes returned in 300s). The model was still showing in the OpenClaw picker as `[Free] DeepSeek V4 Pro`, misleading users who selected it into getting V4 Flash via BlockRun's server-side redirect. Fix: removed from `src/top-models.json` (picker) and `BLOCKRUN_MODELS` registry; all aliases that previously pointed at it (`free/deepseek-v4-pro`, `nvidia/deepseek-v4-pro`, `nvidia/deepseek-v3.2`, `free/deepseek-v3.2`, `deepseek-free`, `deepseek-v4-pro`, `v4-pro`) now redirect directly to `free/deepseek-v4-flash` at the ClawRouter level, skipping the double-hop through BlockRun's redirect. `free/deepseek-v4-flash` (1M context, MMLU-Pro 86.2) remains the active free DeepSeek option. The entry will be restored if and when NVIDIA brings the V4 Pro deployment back online.

---

## v0.12.190 — May 13, 2026

- **`/imagegen` slash command renamed to `/cr-imagegen` to resolve Telegram channel-command collision** ([#165](https://github.com/BlockRunAI/ClawRouter/issues/165)). Telegram bot integrations reserve `/imagegen` for their own image-gen bots (Hugging Face Spaces et al.), and OpenClaw's runtime emits `Plugin command "/imagegen" conflicts with an existing Telegram command` when ClawRouter registered the same name. The `api.registerCommand` at `src/index.ts:1768` now registers `cr-imagegen` so OpenClaw's command registry no longer fights the channel. Backward compatibility preserved: typing legacy `/imagegen <prompt>` in chat still works — the `src/proxy.ts` chat-prefix interceptor accepts both `/cr-imagegen` and `/imagegen` (slice length adjusts to whichever prefix matched). User-facing help text, partner-tool footer, README, `docs/image-generation.md`, and `skills/imagegen/SKILL.md` all updated to lead with the new name while noting the legacy form remains accepted. `/videogen` left untouched — no collision reported in the field yet, and unnecessary churn is unnecessary churn.

---

## v0.12.189 — May 12, 2026

- **Dependency refresh: x402 2.9 → 2.11, viem 2.47 → 2.48, openclaw devDep 2026.5.4 → 2026.5.7.** Routine in-range upgrade pass — no API breakage, all 531 tests green, typecheck + lint clean. Bumps via `npm update` (semver-safe) covered:
  - `@x402/core`, `@x402/evm`, `@x402/fetch`, `@x402/svm` → 2.11.0 (the payment-protocol stack; 2.10 + 2.11 are bugfix-only over the 2.9 line we shipped in v0.12.182).
  - `viem` → 2.48.11 (Ethereum RPC client used for Base USDC balance checks; the `mainnet.base.org` RPC failures visible in `~/.openclaw/logs/gateway.err.log` are external network reliability, not viem bugs — but staying on tip-of-2.x means we pick up any improved retry/timeout logic when it ships).
  - `openclaw` (devDep) → 2026.5.7 (no plugin API surface changes affecting us; we still declare `compat.minGatewayVersion = 2026.5.2` for the strict-validation regime we adapted to in v0.12.184/186).
  - `@scure/bip32` 2.0.1 → 2.2.0, `prettier` 3.8.1 → 3.8.3, `eslint` 10.2.0 → 10.3.0, `typescript-eslint` 8.58.1 → 8.59.3, `vitest` 4.1.3 → 4.1.6 — all in-range.
- **`@solana/kit` deliberately held at v5.5.1.** `npm view` shows v6.9.0 available, but `@x402/svm@2.11.0`'s nested transitive dependency tree still pins to `@solana/kit@5.5.1` (deduped to a single copy in `npm ls`). Bumping ClawRouter's top-level pin to v6 would re-introduce the dual-version split that caused `transaction_simulation_failed` on Solana payments (root-caused on 2026-03-06; see memory `feedback_solana_kit_version_split`). When `@x402/svm` updates its nested pin, we follow — not before.
- **Test fix for OpenClaw 2026.5.7 dist layout.** `test/integration/security-scanner.test.ts` was crashing with `Cannot read properties of undefined (reading 'length')` against the new openclaw build. Root cause: 2026.5.7 ships **two** `skill-scanner-*.js` chunks in `node_modules/openclaw/dist/` — one minified (with mangled exports `a, i, n, r, t`) and one with proper names (`scanDirectoryWithSummary` et al.). The test's `files.find((f) => f.startsWith("skill-scanner"))` picked the FIRST one alphabetically (`skill-scanner-DP5fYVFn.js`, the mangled one), found no `scanDirectoryWithSummary` named export, fell through to "first function export" — which returned the wrong function (something like `clearSkillScanCacheForTest`), returning `undefined`. Fixed by iterating **all** `skill-scanner-*` chunks and picking the one that actually exports `scanDirectoryWithSummary`. The pre-2026.5.4 "first function export" fallback path is preserved for older builds (Docker e2e harness still tests against the long tail).
- **No runtime changes; no shipped behavior changes.** Pure dependency hygiene + one test-harness fix. Existing users see identical proxy behavior; the upgrade matters mainly for users on bare `npm install -g` (who get the newer x402 client when they reinstall) and for Docker/CI environments running the e2e tests against fresh OpenClaw versions.

---

## v0.12.188 — May 9, 2026

- **`clawrouter share` — convert the most recent assistant response into IM-flavored markdown for paste-and-share.** The pain point: OpenClaw renders gorgeous markdown via Warp+SSH, but copy-paste to IM mangles tables / `###` headings / bold. This is a real community ask — upstream [openclaw#7909 "Add plain text copy option"](https://github.com/openclaw/openclaw/issues/7909) has been OPEN since 2026-02-03 with 4 comments and a volunteer (juliabush) but no merged fix; codex review on 2026-04-30 confirms maintainers haven't given UX direction. ClawRouter sits at a unique vantage point — it sees every response body the model emits — so we can ship a CLI-side fix in days while the upstream UI fix waits. Six IM presets, each tuned to the target dialect:
  - **`feishu`** — Lark / 飞书. The headline issue: Feishu desktop renders `**bold**`, tables, emoji, lists, code blocks correctly, but treats `### foo` as literal text. The `feishu` preset converts `# / ## / ###` headings to `**bold**` and strips `---` horizontal rules (which Feishu also doesn't render). Markdown tables stay intact (Feishu renders them natively).
  - **`slack`** — Slack mrkdwn dialect. Distinct from CommonMark: Slack uses `*single-star*` for **bold** (not `**double-star**`) and `_underscore_` for _italic_. Headings → `*bold*`. Markdown links `[text](url)` → Slack's `<url|text>` syntax. `&` `<` `>` get HTML-entity escaped but not inside the link tokens. Strikethrough `~~x~~` → `~x~`. Bullet `-` → `•` for visual polish. Tables → fixed-width text inside ` ``` ` code fences (Slack doesn't render markdown tables natively).
  - **`discord`** — CommonMark-compatible (Discord supports `# ## ###` headings since 2023, plus bold/italic/strike/link). The only conversion: tables → fixed-width fenced blocks (Discord doesn't render tables natively).
  - **`telegram`** — MarkdownV2. The strict one: any unescaped `_*[]()~``>#+-=|{}.!` in body text causes the Telegram bot API to reject the message with `Bad Request: can't parse entities`. The preset tokenizes the input, hard-escapes every reserved character in plain-text spans, preserves formatting tokens (`*bold*`, `_italic_`, `` `code` ``, `[text](url)`), and packs tables into ` ``` ` pre-blocks (where escaping is unnecessary). Headings → `*bold*`. Output >4096 chars is split at line boundaries with `(i/N)` continuation suffix via `transformForTelegramSplit()`.
  - **`whatsapp`** — Same single-star bold + underscore italic dialect as Slack/Telegram. Strikethrough `~~x~~` → `~x~`. Links `[text](url)` → `text\nurl` (lets WhatsApp auto-preview the URL on its own line). Tables → fenced fixed-width text.
  - **`plain`** — Strips all markdown for IMs that render text as-is (WeChat / QQ / iMessage / LINE / Signal). Headings: `# Foo` underlined with `===`, `## Foo` underlined with `---` (visible hierarchy that survives plaintext), `###`+ stripped to body. Bold/italic/strike markers removed. Tables converted to `label: value\nlabel: value` lines (multi-column tables produce header-prefixed blocks separated by blank lines). Links → `text (url)`. Inline code ticks stripped, content kept. Horizontal rules removed.
- **The hard parts that needed real care, not just regex sprawl:**
  - **Asterisk dialect collision (Slack/WhatsApp/Telegram).** Source has CommonMark `**bold** *italic*`, target wants `*bold* _italic_`. If you naively run "double-star → single-star" first, the next pass's "single-star → underscore" eats the just-converted bold. Fix: extract `**bold**` into placeholder strings (`__CR_PH_BOLD_0__`) before italic conversion, then restore as `*bold*` afterward. Same trick for converting markdown links to Slack's `<url|text>` so the angle brackets aren't HTML-entity-escaped in the next stage.
  - **Heading conversion ordering.** First implementation converted `### foo` directly to single-star `*foo*` (for Slack/WhatsApp), which then got eaten by the italic regex. Fix: heading regex always emits double-star `**foo**`, which gets scooped into the bold-protection placeholder along with naturally-occurring bold, and restored to single-star at the end.
  - **Code-fence protection.** Two passes around `splitByFences()`: first, run table-to-fence conversion only on prose segments (so existing code blocks with stray `|` characters aren't misparsed as tables); second, re-split the result (the table conversion just generated new fences) and apply per-preset text rules only to prose, never to fence content. Otherwise the bold/italic regex would eat across fence boundaries when tables happen to contain `**` or `*`.
  - **CJK column widths.** The user's actual content is Chinese — table headers like `指标` / `数值`. CJK characters take 2 monospace columns, not 1. The plain-text table renderer counts visible width by codepoint range (CJK Unified, Hangul, Fullwidth, etc) and pads accordingly so columns stay aligned in non-tabular IMs.
  - **Plain-text horizontal-rule order.** First implementation stripped HRs (`^-{3,}$`) AFTER adding `## foo` underlines — those underlines are themselves dashes, so longer headings (≥3 chars) were getting their underlines vaporized. Fix: strip HRs FIRST, add heading underlines second.
- **Persistence: `~/.openclaw/blockrun/responses/responses-YYYY-MM-DD.jsonl`.** Mirrors the existing usage-log path layout (`src/logger.ts`). Each JSONL entry: `{ id, timestamp, sessionId, model, requestSummary, responseText }`. The `id` is `resp_<ms>_<hex6>` so users can refer to specific responses in `clawrouter share <id>`. `requestSummary` is the user's last message truncated to 80 chars, surfaced in `share list` so people can identify which response is which. Persistence is fire-and-forget from the request handler — errors are swallowed inside `appendResponse` so they never affect the request flow. **Privacy opt-out**: set `BLOCKRUN_RESPONSE_STORE=off` to disable. (Default on; future v0.12.x release may add a TTL or auto-prune, deliberately deferred until usage signal arrives.)
- **Hooks into `src/proxy.ts`.** The chat-completion handler already accumulates the full assistant text into `accumulatedContent` for the session journal (lines 5219–5221 streaming, 5599 non-streaming). Both branches converge at the journal `record` call near line 5635 — the response-store append fires immediately after, gated on `accumulatedContent && isChatCompletion`. The user-prompt summary is captured up front into a new outer-scope `requestSummaryForStore` variable from `lastUserMsg.content` (handles both string and multimodal content arrays).
- **Four new HTTP routes on the proxy** (added next to `/v1/models`):
  - `GET /share/list?limit=20` — paginated metadata index (id, timestamp, model, sessionId, summary, responseLength).
  - `GET /share/last?as=<preset>&sessionId=<sid>` — most-recent entry, optionally pre-rendered for a preset; `sessionId` filter prefers entries from the same OpenClaw session.
  - `GET /share/:id` — fetch a specific entry by id.
  - `GET /share/:id/render?as=<preset>` — fetch + render in one call.
- **`clawrouter share` CLI subcommand**:
  - `clawrouter share last` — render most recent response (default preset = `feishu`, override with `BLOCKRUN_DEFAULT_SHARE_PRESET` env or `--as=<preset>`), print to stdout, copy to clipboard.
  - `clawrouter share list [--limit=20]` — recent entries with id, timestamp, model, prompt summary.
  - `clawrouter share <id> [--as=<preset>]` — render specific entry.
  - `clawrouter share last --all` — write all 6 preset variants to `/tmp/claw-share-<id>-<preset>.txt` and print paths (lets users compare side-by-side and pick).
- **Cross-platform clipboard** with zero new npm dependencies. Spawns the platform-native binary: macOS `pbcopy`, Linux `wl-copy` / `xclip` / `xsel` (probed in order), Windows `clip.exe`. If none work, prints a friendly hint and continues — the rendered text is still on stdout so the user can manually copy it.
- **Test coverage**: `src/share-formatters.test.ts` adds 58 tests grouped by preset plus integration tests against a real-world equivalent of the user's screenshot (semiconductor-bubble analysis with `### 1. 估值已进入极端区域` heading + a CJK-content table). Each preset's headline behavior is asserted: `feishu` converts `###`→`**`, `slack` does the asterisk-dialect dance without corrupting bold-when-italic-is-also-present, `discord` preserves `###` (Discord supports headings), `telegram` escapes `.` `-` `(` correctly and leaves pre-block content un-escaped, `whatsapp` uses single-star bold + underscore italic, `plain` strips everything and produces `key: value` table renderings. Edge cases: code-block protection (markdown patterns inside ` ``` ` aren't transformed), tables with escaped `|`, Telegram >4096 split with `(i/N)` suffix, CJK width calculation. Total test count 457 → 515 (+58), all green; typecheck + lint clean.
- **What we deliberately did NOT do.** No PNG render (would require puppeteer ≈150MB or satori+resvg ≈30MB; the `--all` flag plus future Phase 2 hosted share both cover that need without the install bloat). No hosted share-link endpoint (depends on BlockRun server-side `/v1/share` work; a future Phase 2). No automatic share-hint injection at the end of every response (would pollute every assistant message; release-notes communication is enough). No IM auto-detection (would require telemetry; user picks via `--as` or sets `BLOCKRUN_DEFAULT_SHARE_PRESET`). No upstream OpenClaw PR yet — the `share-formatters.ts` module is a strict superset of openclaw#7909's plain-text request and is portable; future PR opportunity once we have user signal.
- **Web search opt-out: `BLOCKRUN_WEB_SEARCH=off` env var or `tools.web.search.enabled = false` in `~/.openclaw/openclaw.json` now respected.** Two users (Mark, baconvalley) reported `blockrun-exa` keeps reappearing in their config after they edit it out. Root cause: `register()` called `registerWebSearchProvider()` unconditionally and `injectModelsConfig()` flipped `enabled` back to `true` on every plugin load — so any user opt-out got clobbered. Added `isBlockrunWebSearchDisabled()` helper consulted at both sites: when disabled, `register()` skips registration (so OpenClaw's auto-detect won't pick blockrun-exa as the active provider) and `injectModelsConfig()` leaves `enabled` untouched on disk. The legacy-`provider`-stripping migration from v0.12.186 still runs regardless — that's correctness against OpenClaw's known-providers validator, not opt-in. Log line `BlockRun web search disabled (BLOCKRUN_WEB_SEARCH=off or tools.web.search.enabled=false)` confirms the opt-out took effect. `docs/configuration.md` updated. 16 new unit tests in `src/web-search-disable.test.ts` covering env precedence over config, case-insensitive matching, defensive nesting against malformed `tools.web.search`; total test count 515 → 531.
- **Repository hygiene**: removed 5 stale root-level smoke scripts (`final-test.mjs`, `test-auto-connection.mjs`, `test-config-changes.mjs`, `test-profiles.mjs`, `test-routing-changes.mjs` — superseded by `src/**/*.test.ts` since v0.12.79) plus the long-dead `blockrun-clawrouter-0.8.25.tgz` package artifact. `AGENTS.md` (untracked, byte-identical to `CLAUDE.md`) also removed. Net −659 lines from the repo.

---

## v0.12.187 — May 7, 2026

- **Predexon v2 spec alignment.** BlockRun shipped Predexon v2 today (commit `ffa22d4 refactor(predexon): align endpoint registry with Predexon v2 spec`) — adds 9 new endpoints, changes the path shape of 3 wallet endpoints, and retires `polymarket/wallet/identities-batch` (the old GET-with-csv form falls through to the wildcard route, harmless if hit). Total endpoint count: 48 → 57. Confirmed live against prod via `curl https://blockrun.ai/api/v1/pm/{markets,markets/listings,sports/categories,sports/markets,polymarket/markets/keyset,polymarket/wallet/identity/0xabc,outcomes/abc}` — all return 402 ✓; `POST polymarket/wallet/identities` with `{addresses:[..]}` body also 402 ✓. **Trading API (a separate Predexon spec) intentionally not exposed** — confirmed with @1bcMax. Changes in ClawRouter:
  - **`blockrun_predexon_endpoint_call` description refreshed** in `src/partners/registry.ts`: full 57-endpoint catalog grouped as Polymarket Tier 1 / Polymarket Tier 2 wallet analytics / Polymarket Wallet Identity (v2 paths) / Cross-venue canonical (v2: `markets`, `markets/listings`, `outcomes/{predexon_id}`) / Sports (v2: `categories`, `markets`, `markets/{game_id}`, `outcomes/{predexon_id}`) / Kalshi / Limitless·Opinion·Predict.Fun / dFlow / Binance Futures / Matching. Keyset pagination variants (`polymarket/markets/keyset`, `polymarket/events/keyset`) and trade-activity (`polymarket/activity`, `polymarket/markets/{tokenId}/volume`, `polymarket/markets/{conditionId}/open_interest`) listed too.
  - **POST + body support** added to the tool runner (`src/partners/tools.ts`): two new optional params `method` ('GET' default, 'POST' for bulk identities) and `body` (JSON object as string, e.g. `'{"addresses":["0x1","0x2"]}'`). GET + query unchanged. POST defaults body to `{}` when unspecified. Method validated to `'GET'|'POST'` only. Body parses through JSON.parse with cause-attached error.
  - **Wallet identity v2 path shapes propagated** to the description: `/pm/polymarket/wallet/identity/{wallet}` (path param, was `?wallet=`), `POST /pm/polymarket/wallet/identities` (replaces `identities-batch`; body shape `{addresses:[..]}`, ≤200), `/pm/polymarket/wallet/{address}/cluster` (path param, was `?wallet=`).
  - **`skills/predexon/SKILL.md` Full Endpoint Reference rewritten**: 57 rows organized by category, marks POST endpoint, notes "Responses are raw upstream JSON (no `{ data: ... }` wrapper)" — the wrapper was removed in BlockRun commit `4530941` ("fix: remove { data } wrapper from Predexon proxy response, return raw upstream JSON"); our skill had been silently telling agents to read `response.data` even though prod stopped wrapping. Fixed.
  - **`skills/clawrouter/SKILL.md`** count refresh: "57 endpoints (Predexon v2)" + endpoint_call row updated to mention `method` + `body` params.
- **No Trading API exposure.** `polymarket/trades`, `kalshi/trades`, `dflow/trades`, `polymarket/orderbooks` etc. are historical/read-only data endpoints, not trading interfaces. No order placement, no signing, no transaction submission — confirmed with `grep` over the registry.
- **Unit-tested the new dynamic branch** with a mock-fetch harness: GET+query assembles URL params, POST+body sets request body, path-param substitution works on `/pm/polymarket/wallet/identity/{wallet}`, keyset paths route correctly, DELETE method rejected, malformed-JSON body rejected. 457 vitest tests pass; typecheck + lint clean.

---

## v0.12.186 — May 6, 2026

- **Predexon agent tool surface expanded from 8 → 9 tools, covering the full 48-endpoint catalog.** ClawRouter previously exposed only 8 named `predexon_*` tools to LLM agents (events, leaderboard, markets, smart_money, smart_activity, wallet, wallet_pnl, matching_markets) — but BlockRun's source-of-truth (`predexon.ts`) and the marketing site at `blockrun.ai/marketplace/predexon` already list 48 endpoints across Polymarket Tier 1 (markets/events/orderbooks/candlesticks/leaderboard/cohorts/top-holders/UMA oracle), Polymarket Tier 2 wallet analytics (PnL/positions/profiles/filter/smart-money/identity/cluster), Kalshi/Limitless/Opinion/Predict.Fun (markets + orderbooks each), dFlow (trades + wallet), Binance Futures (candles + ticks), and cross-platform matching/search. The existing 8 named tools stay (well-tuned for the most common paths); a new `blockrun_predexon_endpoint_call` is added as a catch-all with `path` + `query` params and the full endpoint directory in its description (LLMs read this as the schema's `description` field). Skill files (`skills/predexon/SKILL.md` + `skills/clawrouter/SKILL.md`) updated to point at the new tool — the 48-row reference table in the predexon skill was already complete.
- **Tool runner extended for dynamic-path services** (`src/partners/tools.ts`): when `service.proxyPath === "/pm/__dynamic__"` the runner reads `path` from args (validated to start with `/pm/` and reject `..` traversal), parses `query` as JSON, and assembles the URL. Existing fixed-path tools are unaffected.
- **OpenClaw devDep bumped `^2026.4.21` → `^2026.5.4`; `minGatewayVersion` bumped `2026.4.5` → `2026.5.2`.** This is the version where strict provider/baseHash validation shipped; we now declare compat with the regime we've adapted to instead of pretending to support older permissive runtimes.
- **Fixed the v0.12.185 deferred follow-up: ClawRouter no longer mutates `tools.web.search.{provider,enabled}` on `api.config` (runtime) or `~/.openclaw/openclaw.json` (disk) inside the plugin install path.** Root cause discovered via Docker e2e on a clean OpenClaw 2026.5.4 image: OpenClaw runs a strict known-providers validator on `tools.web.search.provider` at TWO points — (a) config-load time before `register()` runs, and (b) `replaceConfigFile` when the install commit persists the runtime config to disk. Both reject `blockrun-exa` because the validator's known-providers list is independent of plugin registrations, causing `unknown web_search provider: blockrun-exa` and install rollback. Fix:
  1. **Removed the disk write of `provider` in `injectModelsConfig`** (previously `src/index.ts:449–457`). Wrote a forward-migration in its place: when `provider === "blockrun-exa"` is found on disk, it's deleted on the next file write — picked up automatically by `clawrouter setup --forceWrite` or first gateway start.
  2. **Removed all runtime writes to `api.config.tools.web.search.*` inside `register()`.** Earlier attempts gated them on `typeof api.registerWebSearchProvider === "function"`, but OpenClaw 2026.5.4 still auto-injects the registered provider id during install commit. Net: ClawRouter's `register()` only calls `api.registerWebSearchProvider(blockrunExaWebSearchProvider)` and lets OpenClaw's auto-detection pick it up via "Auto-detected from available API keys if omitted" (per OpenClaw schema).
  3. **`tools.web.search.enabled = true`** is set only via the file-write path in `injectModelsConfig` (gated to gateway mode or `--forceWrite`), so it lands on disk without touching the validator-flagged `provider` field.
  4. **Migration in install scripts** (`scripts/update.sh`, `scripts/reinstall.sh`) strips legacy `provider: blockrun-exa` BEFORE running `openclaw plugins install`. Combined with the in-config migration, existing v0.12.185 users are cleaned up via either path.
  5. The deactivate hook (`src/index.ts:2043`) already removes the field on uninstall — kept as belt-and-suspenders.
- **Test fix**: `test/integration/security-scanner.test.ts` previously found the scanner via "first function export" heuristic, which worked when OpenClaw minified its names. The 2026.5.4 `skill-scanner-*.js` chunk re-exports under proper names, so the heuristic returned the wrong function (one of `clearSkillScanCacheForTest` / `isScannable` / `scanDirectory` / `scanSource`) and the test crashed on undefined fields. Test now prefers the `scanDirectoryWithSummary` named export, falling back to "first function" for older builds.
- **New Docker e2e harness**: `test/docker-install/Dockerfile.openclaw-2026.5` + `run-openclaw-e2e.sh` build a clean Debian + Node 22 + OpenClaw 2026.5.4 image and exercise the full install flow — fresh install on empty config, `clawrouter setup`, validator collision repro, migration + reinstall. All assertions pass on this fresh path. Run with `docker build` then `docker run --rm`.
- **Net behavior on OpenClaw 2026.5.4**: clean install with no validator failures; `clawrouter setup` no longer needs to work around the web_search collision (still useful for bare `npm install -g` users to sync allowlist). Existing v0.12.185 users with `provider: blockrun-exa` on disk get cleaned up automatically by `scripts/update.sh` / `scripts/reinstall.sh` before install runs.
- **Edge case noted (out of scope for this fix)**: re-running `openclaw plugins install --force` after a previously failed install on a setup-populated config triggers an OpenClaw 2026.5.4 internal auto-injection that re-emits `provider: blockrun-exa` and trips its own validator. The triggering log line `[plugins] Forced web_search provider to blockrun-exa` does not appear in any deployed file (verified via exhaustive `find / | xargs grep` in the Docker container) — it's emitted from somewhere inside the OpenClaw runtime not reachable from a clean filesystem search. Not a `scripts/update.sh` flow, no user impact in normal upgrades.

---

## v0.12.185 — May 4, 2026

- **`clawrouter setup` — new CLI command for users who installed via bare `npm install -g`.** A user reported `/models` in their Telegram bot showing only 7 entries despite having `@blockrun/clawrouter@0.12.184` installed and the gateway restarted. Investigation: bare `npm install -g @blockrun/clawrouter` puts the package on disk and adds the `clawrouter` binary to PATH but performs **zero** OpenClaw integration — no `plugins.entries.clawrouter` registration, no models allowlist sync, no auth profile injection. The user's bot showed OpenClaw's hardcoded fallback default models (which include `gpt-5-nano` and `gemini-2.5-flash` — neither in our `top-models.json`) instead of our 38-entry list. Confirmed by reproducing locally on OpenClaw 2026.5.2 (`8b2a6e5`): `npm install -g` alone leaves `models list` showing 1 default entry; only `openclaw plugins install @blockrun/clawrouter` triggers our `register()` callback.
- **Fix**: `clawrouter setup` runs the missing integration steps:
  1. Detect `openclaw` on PATH (refuse to proceed if missing).
  2. `openclaw plugins install --force @blockrun/clawrouter` to register the plugin.
  3. Direct call to `injectModelsConfig({ forceWrite: true })` and `injectAuthProfile()` to populate `agents.defaults.models` (the 38-entry allowlist), `models.providers.blockrun.models` (picker), `tools.web.search.provider = "blockrun-exa"`, and `agents/<id>/agent/auth-profiles.json` with the `blockrun:default` placeholder.
  4. Tell the user to `openclaw gateway restart` to pick up the new plugin code.
- **Resilient against OpenClaw 2026.5.2's stricter validation**: 2026.5.2 added a `tools.web.search.provider` validator that rejects `blockrun-exa` until that provider is actually registered (chicken-and-egg: we register it inside our plugin, but validation runs on the openclaw.json file before plugin code executes). When this trips, OpenClaw rolls back its install record. The setup command continues anyway and runs the manual config sync — even if registration didn't stick, the user's openclaw.json gets the full 38-entry allowlist, and the bot will see all models on next gateway start. A warning prints suggesting a manual `openclaw plugins install --force @blockrun/clawrouter` retry post-gateway-start if needed.
- **`injectModelsConfig` gained an `options.forceWrite` parameter** (`src/index.ts:214`). Default `false` preserves the v0.12.184 deferred-write behavior for plugin-activation hooks; `forceWrite: true` is only used by the new `setup` CLI command since it's an explicit user action outside any install transaction. Plugin lifecycle paths (the `register()` callback at `src/index.ts:1602`) keep the unconditional defer.
- **Both `injectModelsConfig` and `injectAuthProfile` are now exported** from the package entry (`src/index.ts:2074`) so the CLI can call them directly without re-implementing the logic.
- **README updated** with explicit guidance on the two install paths: A1 (`curl … clawrouter-install.sh | bash` — recommended) and A2 (`npm install -g … && clawrouter setup` — required two-step). The pure-npm path now has a prominent warning that skipping `setup` causes the 7-models symptom.
- **End-to-end verified locally**: `clawrouter setup` ran against my own `~/.openclaw` populated `agents.defaults.models` with 39 `blockrun/*` entries (vs the prior partial state); the `models.providers.blockrun.models` picker plane synced to 39 too; auth profile written. Hit OpenClaw 2026.5.2's web_search validation as expected, but the manual sync ran around it.

**Followup (deferred)**: OpenClaw 2026.5.2's `tools.web.search.provider` validator running before plugin activation is a structural mismatch — we register `blockrun-exa` inside our plugin, but validation expects the provider to be known statically. Either OpenClaw needs to relax this check post-plugin-load, or ClawRouter should declare the web_search provider via the plugin manifest rather than at runtime. Tracked separately; today's `setup` workaround unblocks users.

---

## v0.12.184 — May 4, 2026

- **Plugin install no longer crashes OpenClaw with `ConfigMutationConflictError`.** v0.12.183 fixed the install script so `openclaw plugins install --force @blockrun/clawrouter` actually executes instead of bouncing on "plugin already exists". But once the install proceeded, OpenClaw 2026.5.2 crashed inside `commitPluginInstallRecordsWithConfig` → `replaceConfigFile` → `assertBaseHashMatches`: ClawRouter's plugin activation hook (`injectModelsConfig`) reads `~/.openclaw/openclaw.json` directly from disk and writes it back atomically (via `tmp + rename`) during activation. OpenClaw's install flow holds a baseHash on that exact file from before activation; when our hook bumped the hash, OpenClaw's own commit step refused to write its install record, threw, and the install rolled back. Two fixes in two releases, same user, same Vultr box, same rollback banner — no progress.
- **Fix**: `injectModelsConfig` now skips the disk write when not in gateway mode (`isGatewayMode()` returns false during `openclaw plugins install`, `openclaw plugins list`, etc. — only true for `openclaw gateway start/restart/stop`). The in-memory mutations still compute, the info logs still print, but the `writeFileSync(tmpPath) + renameSync(configPath)` is deferred. The same hook re-runs on first `openclaw gateway start` (gateway mode = true, no install transaction in flight) and persists the changes cleanly there. New log line: `Deferring config write to first gateway start (outside gateway mode)`.
- **No regression on the gateway path.** The guard at `src/index.ts:477` only short-circuits when `process.argv` does not contain `gateway`. Sanity-tested locally: started clawrouter via `node dist/cli.js`, hit `/v1/chat/completions` with `free/gpt-oss-120b`, returned 200 in 0.6s — same as v0.12.183.
- **Why this didn't surface before today**: OpenClaw 2026.5.2 (commit `8b2a6e5`, the version on the field-reporting Vultr box) added the `assertBaseHashMatches` strict check inside `replaceConfigFile`. Earlier OpenClaw versions silently allowed plugin-side disk writes to clobber the install transaction; the conflict went unnoticed because the install record was lost but the plugin still appeared installed. With the new strict check, the conflict surfaces as a hard `ConfigMutationConflictError` and the install genuinely rolls back. The bug has been latent in `injectModelsConfig` since v0.12.176 (when active config writes from this hook were introduced); it only became user-visible with OpenClaw 2026.5.2.
- **No `scripts/` changes — no blockrun re-deploy required.** The fix is in `src/index.ts`, bundled into the v0.12.184 npm tarball. The install script at `blockrun.ai/clawrouter-install.sh` is already correct as of v0.12.183; running it again now pulls the new tarball, plugin activation skips the conflicting write, OpenClaw commits its install record, gateway starts cleanly.

---

## v0.12.183 — May 4, 2026

- **Install/update scripts no longer roll back when the plugin is already installed.** `scripts/update.sh:321` and `scripts/reinstall.sh:422` ran `openclaw plugins install @blockrun/clawrouter` without `--force`. On any machine where the plugin already lives at `~/.openclaw/npm/node_modules/@blockrun/clawrouter` (i.e. every existing user running an upgrade), OpenClaw rejects the install with `plugin already exists: ... (delete it first)` and a non-zero, non-124 exit code. The script's `|| { ... exit $exit_code; }` guard then fires, the EXIT trap rolls back to the prior install (`✗ Reinstall failed. Restoring previous ClawRouter install...`), and the user is silently stranded on the version they had — never reaching the new release.
- **Fix**: both shell scripts now invoke `openclaw plugins install --force @blockrun/clawrouter`. Per OpenClaw's own error message ("rerun install with `--force` to replace it"), `--force` is the documented and idempotent way to handle both fresh-install and upgrade flows. Applied at all four call sites (timeout-wrapped + non-timeout paths in each script).
- **PowerShell counterpart `scripts/update.ps1` already uses a different approach** — it manually `npm pack`s + `Remove-Item -Recurse -Force` the plugin dir + extracts (lines 112-129), bypassing `openclaw plugins install` entirely. No bug there, no change needed.
- **Field reproduction**: a Vultr-hosted user attempted to update to v0.12.182 and saw the rollback banner. Without the manual workaround `openclaw plugins update @blockrun/clawrouter`, they would have stayed on v0.12.181 indefinitely — defeating every prior fix in this session (image polling, predexon SKILL sync, reasoning-aware timeout).
- **Note for users currently stranded**: this fix lives on npm `@blockrun/clawrouter@0.12.183` but reaches users only via `npm install -g`, `openclaw plugins update`, or the self-hosted `blockrun.ai/clawrouter-install.sh`. The self-hosted install script copy at `blockrun/public/clawrouter-install.sh` should be re-synced from this release before the next user attempts an upgrade — until that sync, a user pulling the install script via curl from blockrun.ai will still hit the broken behavior.

---

## v0.12.182 — May 4, 2026

- **Reasoning models no longer get aborted before they emit their first token.** `PER_MODEL_TIMEOUT_MS` was hard-coded to 60s for every model. Reasoning/thinking-mode models (o-series, GPT-5 reasoning, Claude opus thinking, Gemini Pro, Grok reasoning, DeepSeek V4 Pro / reasoner, Kimi K2.x, Qwen3-thinking, etc. — 37 IDs total flagged with `reasoning: true` in `BLOCKRUN_MODELS`) routinely take 60–120s to produce the first token on a cold cache. ClawRouter was firing the per-attempt abort right at the moment the model was about to start streaming, so a hard-pinned reasoning model would 100% time out, and `auto`-routed reasoning fallbacks chained more reasoning timeouts back-to-back. End user surfaces this as `LLM request failed: network connection error` from the agent's HTTP client.
- **Fix**: per-attempt timeout is now model-aware:
  - `REASONING_MODEL_TIMEOUT_MS = 180_000` (3 min) for any model with `reasoning: true`
  - `PER_MODEL_TIMEOUT_MS = 60_000` (unchanged) for everything else
  - `timeoutForModel(id)` helper looks up the flag from `BLOCKRUN_MODELS` (computed once into a Set at module init for O(1) lookup)
  - All three AbortController setup sites updated: primary attempt loop (`src/proxy.ts:4694`), explicit-pin retry (`src/proxy.ts:4827`), and 429 backoff retry (`src/proxy.ts:4897`).
- **`DEFAULT_REQUEST_TIMEOUT_MS` 180s → 300s** (5 min). The global deadline now leaves headroom for one reasoning attempt (180s) + a non-reasoning fallback (60s) + on-chain settlement (~30s buffer). Was 180s, which would have collided exactly with a single reasoning attempt and starved fallback.
- **Heartbeat path unchanged.** Streaming requests already get an immediate `: heartbeat\n\n` followed by 2s-cadence keep-alive (`src/proxy.ts:4378-4389`). Non-streaming clients can't be helped by heartbeats over HTTP/1.1; they need to extend their own client-side HTTP timeouts (or switch to streaming).
- **Diagnosed in the field**: a Telegram bot user reported `LLM request failed: network connection error` after pinning their default model to `clawrouter/free/deepseek-v4-pro`. Reproduced locally on v0.12.181 with $36 balance: V4 Pro upstream took >30s for first token, client-side curl `--max-time 30` gave up, and ClawRouter's 60s per-model abort would have fired at 60s if the upstream hadn't returned by then. New 180s window covers normal V4 Pro cold-start. (Today V4 Pro is also experiencing an upstream NIM outage that's unrelated to this fix; `auto` profile correctly routes around it to other free models.)

---

## v0.12.181 — May 4, 2026

- **Main `clawrouter` SKILL caught up to multi-venue scope.** v0.12.180 expanded the dedicated `predexon` SKILL to BlockRun's 49-endpoint registry, but the **headline `clawrouter` SKILL** (the one OpenClaw and AI agents read first to decide whether ClawRouter is relevant) still said "Polymarket prediction market data" + "8 tools, Polymarket ↔ Kalshi". That description would have steered agents away from prediction-market questions about Kalshi/Limitless/Opinion/Predict.Fun, UMA resolution status, and wallet identity — even though the proxy and the predexon SKILL handle them.
- **Updates**:
  - Front-matter `description`: now lists Polymarket, Kalshi, Limitless, Opinion, Predict.Fun, dFlow + UMA oracle + wallet identity & clustering — so the discovery layer matches the actual capability.
  - Section `### Polymarket (Predexon)` → renamed `### Prediction Markets (Predexon)`. Body rewritten as a 4-bucket summary (Markets & trading, Leaderboard & smart money, Wallet analytics, UMA oracle + wallet identity) with 49-endpoint count and accurate pricing tiers. Pointer to the dedicated `predexon` skill for the full reference.
- **No code changes, no other SKILLs changed.** The `predexon` skill itself was already complete in v0.12.180. Pure visibility/triage fix on the headline SKILL.

---

## v0.12.180 — May 4, 2026

- **Predexon skill catches up to BlockRun's 49-endpoint registry.** BlockRun shipped 10 new prediction-market endpoints on 2026-05-03 (commits `9640528` + `a06c652`, prod revisions `00442-jqf` and `00443-45g`); ClawRouter's `/v1/pm/*` catch-all whitelist already proxied them silently, but `skills/predexon/SKILL.md` documented none — so OpenClaw users and AI agents using the skill couldn't discover them.
- **New endpoints documented**:
  - **Cross-venue search** — `markets/search?q=...` ($0.005) — single call across Polymarket, Kalshi, Limitless, Opinion, Predict.Fun
  - **Other venues markets list** — `limitless/markets`, `opinion/markets`, `predictfun/markets` ($0.001 each) — closes the prior gap where only orderbooks were exposed
  - **UMA oracle resolution** — `polymarket/uma/markets?state=...` and `polymarket/uma/market/{conditionId}` ($0.001 each) — track proposal/dispute/resolution lifecycle
  - **Wallet identity & clustering** — `polymarket/wallet/identity?wallet=...`, `polymarket/wallet/identities-batch?wallets=...` (GET, not POST — upstream docs are wrong), `polymarket/wallet/cluster?wallet=...` ($0.005 each)
  - **Per-token candlesticks** — `polymarket/candlesticks/token/{tokenId}` ($0.001) — OHLCV for a single outcome token (sibling to the existing market-level `candlesticks/{conditionId}`)
- SKILL.md additions: 4 new section blocks (Search Across All Venues, Other Venues, UMA Oracle Resolution Status, Wallet Identity & Clustering), 5 new example interactions, 10 new rows in the endpoint reference table (36 → 46 documented; 3 long-standing gaps from BlockRun's 49 — `polymarket/activity`, per-market volume, open_interest — deliberately left for a follow-up). Front-matter `description` and 8 new triggers for the new categories (limitless / opinion markets / predict.fun / uma oracle / wallet identity / wallet cluster / cross-venue search).
- **No code changes.** Proxy whitelist (`src/proxy.ts:2669`) already matches `/v1/pm/*`; no new path needed. Pure docs/skill release.

---

## v0.12.179 — May 3, 2026

- **Slow image generation no longer silently breaks.** `openai/gpt-image-2` (and any future model whose generation exceeds BlockRun's 30s inline window) returns `202 + { id, poll_url, poll_instructions }` from `POST /v1/images/generations`. ClawRouter previously took that 202 body and replied to the client with `200 OK` + the queued-job stub — no `data` array, no images, no error signal. The client (OpenClaw, SDK callers, curl) saw "success" with nothing usable.
- **Fix**: mirror the existing video polling loop into `/v1/images/generations`. After the initial `payFetch` POST, if the response is 202 with `poll_url`, ClawRouter now polls `GET /v1/images/generations/{id}` every 3s (after a 2s warmup) for up to 5 minutes — exactly the pattern used for `/v1/videos/generations` since 2026-04-23. On `status=completed` the response is rewritten to the final `{ data: [...] }` body and flows through the same image-saving / localhost-rewrite path as fast models. On `failed` → 502 with details. On 5min timeout → 504 (no payment settled — server only settles on first completed poll). Client still sees a single blocking POST.
- **`/v1/images/image2image` deliberately untouched.** BlockRun's `image2image` route has no `[id]` poll endpoint and no `INLINE_GEN_TIMEOUT` — it's fully synchronous server-side, so there's no 202 path to handle. Adding speculative polling there would be dead code.
- **No payment-flow change.** `payFetch` handles wallet signing for the initial POST and each subsequent poll GET; BlockRun's `[id]` route binds the job to the payer wallet and settles idempotently on the first completed poll, identical to the video flow. `paymentStore.amountUsd` still reflects the verified-then-settled amount for `logUsage`.

---

## v0.12.178 — May 3, 2026

- **DeepSeek V4 Pro added to REASONING fallbacks (auto + eco).** Backend shipped `deepseek/deepseek-v4-pro` (1.6T MoE / 49B active, 1M context — strongest open-weight reasoner; MMLU-Pro 87.5, GPQA 90.1, SWE-bench 80.6, LiveCodeBench 93.5) at **$0.50 in / $1.00 out per 1M under the 75% promo through 2026-05-31** (list $2.00/$4.00 after). Wired into `auto.tiers.REASONING.fallback` after `deepseek-reasoner`/`grok-4-fast-reasoning` and into `eco.REASONING.fallback` after `deepseek-reasoner`. V4 Flash thinking (`deepseek-reasoner`, $0.20/$0.40) stays primary because it's cheaper; V4 Pro is the harder-task escape hatch.
- **DeepSeek chat/reasoner now V4 Flash semantics.** `deepseek/deepseek-chat` and `deepseek/deepseek-reasoner` (already in tier configs) had their upstream rerouted to V4 Flash non-thinking / thinking modes — repriced from $0.28/$0.42 to $0.20/$0.40 with 1M context (was 128K). No SDK source change needed — pricing fetched from `/v1/models` at runtime; tier configs got comment refresh to note the V4 Flash repricing.
- **`deepseek/deepseek-v4-pro` added to `top-models.json`** so the OpenClaw `/model` picker surfaces the new flagship.
- **No `FREE_MODELS` changes.** `nvidia/gpt-oss-120b` and `nvidia/gpt-oss-20b` were briefly delisted 2026-04-28 but **re-enabled 2026-04-30** with `available: true` + `hidden: true` — they no longer appear in `/v1/models` (so the picker hides them) but ClawRouter's `FREE_MODELS` set still uses them as the historical free defaults; direct calls work.

---

## v0.12.177 — May 3, 2026

- **Picker actually filtered now via the right layer.** v0.12.175 + v0.12.176 both targeted `cfg.models.providers.blockrun.models`, but per v0.11.8's checked-in design (`src/index.ts:379`), the OpenClaw `/model` picker is whitelisted by `cfg.agents.defaults.models` — that's the canonical filter. The path-based-plugin install case (where users install ClawRouter from a local checkout via `installPath = sourcePath = ...`) never runs `scripts/update.sh` / `scripts/reinstall.sh`, so the install-script prune-and-add never fires. `injectModelsConfig` in `src/index.ts` only added entries — never pruned — so retired models accumulated forever in the allowlist.
- **Fix**: `injectModelsConfig` now actively syncs `blockrun/*` allowlist entries to TOP_MODELS exactly — adds missing AND removes stale. Mirrors the install-script behavior so plugin-load-only users (no install-script flow) get correct picker visibility on next OpenClaw restart. Non-`blockrun/*` entries (other providers like OpenRouter) are preserved.
- **`/v1/models` HTTP endpoint deliberately unchanged** — keeps the full ~175-entry list including aliases, so API-level discovery and `/model <alias>` resolution stay open. Filter only applies to picker UI.
- **v0.12.175 + v0.12.176 changes retained** as defense-in-depth: `buildProviderModels` still returns `VISIBLE_OPENCLAW_MODELS`, and `index.ts` still writes `VISIBLE_OPENCLAW_MODELS` to `cfg.models.providers.blockrun.models`. Even though the picker filter is allowlist-driven, keeping these aligned costs nothing.

---

## v0.12.176 — May 2, 2026

- **Picker filter v0.12.175 didn't actually take effect.** Root cause: `src/index.ts` independently writes `cfg.models.providers.blockrun.models` at plugin startup (lines 293, 331, 1582), and it referenced the **unfiltered** `OPENCLAW_MODELS` (~175 entries) — so on every plugin activate it overwrote any pruned array with the full list, completely bypassing the v0.12.175 fix at `buildProviderModels`. Users updating to v0.12.175 still saw 50–58+ entries because `index.ts` re-injected the full set right after my filter ran.
- **Fix**: `src/index.ts` now imports `VISIBLE_OPENCLAW_MODELS` and writes that to `cfg.models.providers.blockrun.models` at all three injection points (provider config injection, validation refresh, runtime port re-injection). The validation logic also gained a "stale superset" check — if the on-disk array contains IDs NOT in `VISIBLE_OPENCLAW_MODELS`, it triggers a rewrite to actively shrink the array (was previously additive-only). This means existing users with stale 159+ entry arrays get their picker auto-pruned on first plugin activate after upgrading.
- **No registry, alias, or routing changes.** `OPENCLAW_MODELS` (full set) remains the resolution layer for proxy routing and alias matching; only the picker-advertisement layer (`provider.models` getter + `index.ts` writes) is filtered.

---

## v0.12.175 — May 2, 2026

- **Picker filter actually works now.** v0.12.173's `top-models.json` trim was supposed to slim the OpenClaw `/model` picker but didn't, because the picker reads from `cfg.models.providers.blockrun.models` — populated by ClawRouter's `provider.models` getter (`src/provider.ts:43`) → `buildProviderModels()` (`src/models.ts:1163`) — which returned the FULL `OPENCLAW_MODELS` array (~175 entries: 68 BLOCKRUN_MODELS + 107 ALIAS_MODELS). `top-models.json` only drove `agents.defaults.models` (a separate allowlist that controls "which models can be set as default", NOT what shows in the picker). Net effect for users on v0.12.173/v0.12.174: their picker still showed 50–58+ entries including long-retired models (`gpt-5.2`, `gpt-4.1`, `o1`, `o1-mini`, `o3-mini`, `nvidia/kimi-k2.5`, `xai/grok-2-vision`, `free/nemotron-ultra-253b`, etc.).
- **Fix**: `buildProviderModels` now filters `OPENCLAW_MODELS` through a `TOP_MODELS_SET` derived from `src/top-models.json`. Picker drops to ~38 visible entries on next OpenClaw refresh of the provider models. New `VISIBLE_OPENCLAW_MODELS` export in `src/models.ts` is the canonical "what the picker advertises" list.
- **/v1/models HTTP endpoint deliberately unchanged** — still returns the full ~175-entry list for API-level discovery (per Your Majesty's original v0.12.173 intent: "hide from list, but still callable"). Direct ID + alias resolution unaffected; router fallbacks unaffected; proxy routing unaffected.
- **Migration note for existing users**: OpenClaw merges, never deletes, from `cfg.models.providers.blockrun.models`. So users who installed v0.12.174 or earlier still have their old 159-entry array on disk; they'll need either a fresh OpenClaw plugin re-install (which re-reads `provider.models`) or manual openclaw.json cleanup. Future install/update scripts should add a prune step here, similar to the existing `agents.defaults.models` prune — tracked as a follow-up.

---

## v0.12.174 — May 2, 2026

- **`profile=auto` and `profile=agentic` MEDIUM-tier primary swapped from Kimi K2.5 → K2.6.** Per-call cost on these MEDIUM routes goes from $0.60/$3.00 → $0.95/$4.00 — that's **+58% on input tokens, +33% on output tokens** for default-profile users whose classifier returns MEDIUM. The decision deliberately reverses v0.12.170's "tier primaries unchanged pending K2.6 retention/IQ data" stance. The trigger: BlockRun hid K2.5 from its public UI on 2026-04-28 (commit `bfbdedf`) and we hid it from ClawRouter's picker in v0.12.173, so the trajectory toward server-side K2.5 retirement is clear. Promoting K2.6 now is future-proofing — if BlockRun pulls K2.5 server-side later, every MEDIUM call would otherwise 400 → fallback-second-choice silently, which is harder to debug than a clean primary that is already on the still-supported model.
- **Cost-stability opt-out**: users who prefer K2.5's pricing can pin `model: "moonshot/kimi-k2.5"` directly (or use the `kimi-k2.5` alias). K2.5 stays in `BLOCKRUN_MODELS`, the alias map, and is now wired in as the **first fallback** in both `autoTiers.MEDIUM` and `agenticTiers.MEDIUM` chains — so even on the auto path, if K2.6 has an infra hiccup the next attempt is K2.5 (same model, same cost as the v0.12.173 default). Profiles `eco` and `premium` are unaffected (eco MEDIUM = `gemini-3.1-flash-lite`, premium SIMPLE was already K2.6).
- **Registry, picker, and other tier primaries unchanged.** Both Kimi versions remain in `src/models.ts`, `src/top-models.json` is identical to v0.12.173, and no other auto/agentic/eco/premium primaries moved. The two known "hidden but still primary" inconsistencies (`autoTiers.SIMPLE` = `google/gemini-2.5-flash`, `agenticTiers.SIMPLE` = `openai/gpt-4o-mini`) are tracked but deferred — they don't have the same urgency signal (BlockRun hasn't pulled them from its UI).

---

## v0.12.173 — May 2, 2026

- **Picker decluttered: 12 superseded long-tail models hidden from OpenClaw `/model` UI.** `src/top-models.json` trimmed from 50 → 38 entries. Hidden: `anthropic/claude-opus-4.5`, `openai/gpt-5.3`, `openai/gpt-5-mini`, `openai/gpt-5-nano`, `openai/gpt-4o`, `openai/gpt-4o-mini`, `openai/o3`, `openai/o4-mini`, `google/gemini-2.5-pro`, `google/gemini-2.5-flash`, `google/gemini-2.5-flash-lite`, `moonshot/kimi-k2.5`. Picker count drops from "55 available" to ~43 once users run `clawrouter update` or reinstall.
- **No callability regression and no fallback impact.** This is a UX-only change: `BLOCKRUN_MODELS` registry, `MODEL_ALIASES`, and `src/router/config.ts` fallback chains are all untouched. Direct calls (`model: "openai/gpt-4o"`) and aliases (`gpt`, `gpt4`, `mini`, `o3`, `gemini`, `flash`, `kimi-k2.5`, `nvidia/kimi-k2.5`, `anthropic/claude-opus-4-5`, `minimax-m2.5`) continue to resolve and route normally. The `/v1/models` HTTP endpoint still advertises all 175 entries (registry + aliases) for API-level model discovery — only the OpenClaw picker is filtered.
- **`openai/gpt-5.3-codex` deliberately kept visible.** The codex variant is treated as a distinct developer-targeted entry and stays in the picker.
- **`minimax/minimax-m2.5` already absent** from `top-models.json` (only `minimax/minimax-m2.7` was listed); no action needed and the `minimax-m2.5` alias still works.

---

## v0.12.171 — Apr 29, 2026

- **Three new free NVIDIA-hosted models added.** BlockRun refreshed the free catalog on 2026-04-29 with three additions, all wired into ClawRouter as `free/`-prefixed entries:
  - `free/deepseek-v4-pro` — 1.6T MoE / 49B active, 1M context, MMLU-Pro 87.5, GPQA 90.1, SWE-bench 80.6, LiveCodeBench 93.5. NIM ~150 tok/s on Blackwell. Strongest free reasoning model.
  - `free/deepseek-v4-flash` — 284B / 13B active MoE, 1M context, ~5x faster than v4-pro. Strong on chat/summarization (MMLU-Pro 86.2). Weaker factual recall (SimpleQA 34% vs Pro's 58%) — pick v4-pro for fact-heavy agentic loops.
  - `free/nemotron-3-nano-omni-30b-a3b-reasoning` — 31B / 3.2B active MoE, 256K context. First vision-capable free model in the catalog. Accepts text, images, video (up to 2min), audio (up to 1hr). ChartQA 90.3, DocVQA 95.6, MMMU 70.8.
- **`free/deepseek-v3.2` phased out** in favor of `free/deepseek-v4-pro` (strict-superset replacement: same family, larger context, higher benchmarks). Removed from `BLOCKRUN_MODELS`, `FREE_MODELS` set, `top-models.json` picker, README pricing table, and SKILL.md model list. Aliases kept and redirected: `nvidia/deepseek-v3.2`, `free/deepseek-v3.2`, and `deepseek-free` now all resolve to `free/deepseek-v4-pro` so existing pins continue to work and silently get the upgrade.
- **`gpt-oss-120b` / `gpt-oss-20b` deliberately kept as defaults** despite BlockRun's 2026-04-28 retirement (`available:false` server-side). Heavy user demand outweighs the source-of-truth alignment for these specific IDs — `free` / `nvidia` / `gpt-120b` / `gpt-20b` aliases all still resolve to `free/gpt-oss-120b` (or 20b), `FREE_MODEL` constant still points at `free/gpt-oss-120b`, and `ecoTiers.SIMPLE` primary stays unchanged. ClawRouter's existing fallback-chain logic handles any 400 ("Model not available") from BlockRun by trying the next chain entry, so failures degrade gracefully rather than break user workflows.
- **New shorthand aliases for the additions:** `deepseek-v4-pro`, `deepseek-v4-flash`, `v4-pro`, `v4-flash`, `nemotron-omni`, `nano-omni`, `vision-free` — chosen to mirror BlockRun's bare-name aliases at `route.ts:639-640` plus a `vision-free` discovery shortcut for the new vision-capable model.
- **`ecoTiers.SIMPLE` fallback chain extended** with the three new free models (mistral-small, deepseek-v4-flash, qwen3-next) inserted before the paid Gemini fallbacks, so eco-profile users get more all-free chain depth before paid models kick in. Primary is unchanged (`free/gpt-oss-120b`).
- **Provider routing safety note.** BlockRun's `NVIDIA_MODEL_MAP` in `src/lib/ai-providers.ts:2094-2111` does NOT have explicit entries for the 3 new models, but `callOpenAICompatible` falls through to the bare model name (`modelMap[k] || k`), so ClawRouter sending `nvidia/deepseek-v4-pro` reaches NVIDIA NIM as bare `deepseek-v4-pro` — which is what NIM expects. Documented in the BLOCKRUN_MODELS comment block in `src/models.ts`. If BlockRun later adds explicit map entries with different upstream names, this side needs no change.
- **Net free-model count: 8 → 10** (8 originals + 3 added - 1 phased out). README badge, tagline, "Quick Start" sections, and SKILL.md description all updated to reflect "10 free NVIDIA models". Pricing table in README adds three new rows in benchmark order.
- **Test fixtures.** `src/router/strategy.test.ts` `MODEL_PRICING` map gains entries for the 3 new free models. No assertion changes anywhere else — gpt-oss-120b stays the asserted default in `src/exclude-models.test.ts`, `src/models.test.ts`, `test/fallback.ts`, and `test/integration/exclude-models.test.ts`.

---

## v0.12.170 — Apr 29, 2026

- **Bare `kimi` / `moonshot` aliases now resolve to Kimi K2.6.** BlockRun hid Kimi K2.5 from its public model UI on 2026-04-28 (commit `bfbdedf`) and now features K2.6 as the Moonshot flagship. ClawRouter's local alias map followed the old direction and still pointed `kimi` and `moonshot` at K2.5, which created a quiet drift from the source-of-truth registry: agents asking for "kimi" got the previous-gen model while BlockRun's homepage advertised K2.6. The aliases now resolve to `moonshot/kimi-k2.6` and a new bare `kimi-k2` alias is added for the same target. Users who explicitly pinned `kimi-k2.5` continue to get K2.5 — the explicit pin is preserved as a cost-stability opt-in ($0.60/$3.00 vs K2.6's $0.95/$4.00). NVIDIA-hosted K2.5 (retired 2026-04-21) still redirects to `moonshot/kimi-k2.5`.
- **Routing tier primaries deliberately unchanged.** `autoTiers.MEDIUM` and `agenticTiers.MEDIUM` continue to anchor on `moonshot/kimi-k2.5`. Promoting them to K2.6 would silently raise per-call cost +58% on input / +33% on output for every default user — that's a separate decision tracked outside this release, ideally with measured retention/IQ data on K2.6 vs K2.5. `premiumTiers.SIMPLE` was already `moonshot/kimi-k2.6` and is unchanged. Net effect: behavior shift is opt-in via the `kimi` alias / `kimi-k2` shorthand, not forced through default routing.
- **Doc and test fixture refresh.** README's profile-overview table now shows `kimi-k2.6` in the PREMIUM column (matching `docs/routing-profiles.md` and `src/router/config.ts:1134`). `src/router/strategy.test.ts` gains a K2.6 pricing fixture so cost-calc tests stay honest if K2.6 ever appears in test scenarios. `src/proxy.models-endpoint.test.ts` now asserts both `kimi-k2.6` and `moonshot/kimi-k2.6` are discoverable through the `/models` endpoint. `test/fallback.ts`'s "Unknown model" example list leads with `moonshot/kimi-k2.6`.

---

## v0.12.169 — Apr 28, 2026

- **Synthesize structured `tool_calls` from XML/text formats some models emit in `content`.** Earlier tool-call hardening (v0.12.165, v0.12.166) handled the case where upstream returned a structured `tool_calls` array (or signaled `finish_reason: "tool_calls"`) and the model also leaked planning prose into `content`. This release closes a third gap where upstream returns _no_ structured tool calls at all and the model's actual tool invocations live as XML/text inside `content` — typical when a downstream client (OpenClaw is the visible offender) prompt-engineers tool instructions instead of sending a structured `tools[]` schema, so the model dutifully honors the prompt format and emits the call as text. Two formats observed in the wild are now recognized and converted to OpenAI-shaped `tool_calls`:
  - **OpenClaw-style** — `<tool_call>NAME<arg_key>K1</arg_key><arg_value>V1</arg_value>...<arg_key>Kn</arg_key><arg_value>Vn</arg_value></tool_call>`. Requires at least one `arg_key`/`arg_value` pair so prose like `<tool_call>name</tool_call>` in documentation does not mis-fire. Surfaced via a real ClawRouter→OpenClaw session where the agent emitted six identical `<tool_call>web_search<arg_key>...</arg_key>...` blocks in 60 seconds, none executed, then hallucinated "I need a Brave API key" as the failure explanation.
  - **Anthropic-style** — `<function_calls><invoke name="NAME"><parameter name="K">V</parameter>...</invoke></function_calls>`. Reproduction confirmed Moonshot Kimi K2.6 emits this format when given prompt-engineered tool instructions without a structured `tools[]` schema.
  - Values are best-effort coerced via `JSON.parse` so `<arg_value>5</arg_value>` becomes `5` (number) and `<arg_value>true</arg_value>` becomes `true` (boolean); strings that don't parse stay as strings. Synthesized IDs are OpenAI-shaped (`call_<base64url>`).
  - Wired into both response paths: the SSE conversion path (`src/proxy.ts:5081+`) and the non-streaming JSON path (`src/proxy.ts:5325+`). When extraction succeeds, `content` is blanked, `message.tool_calls` is populated, and `finish_reason` flips to `"tool_calls"` — matching exactly the shape downstream tool executors already handle from the v0.12.165/166 paths.
  - New module `src/textual-tool-calls.ts` plus `src/textual-tool-calls.test.ts` (13 unit tests) and four new integration tests in `src/proxy.tool-forwarding.test.ts` covering OpenClaw format / non-streaming, OpenClaw format / SSE, Anthropic format / non-streaming, and a negative test (plain prose passes through unchanged with `finish_reason: "stop"`).
- **`/model` picker allowlist now lives in `src/top-models.json`** (single source of truth, loaded by `src/top-models.ts`). Previously `injectModelsConfig()` in `src/index.ts` carried a literal array that drifted from the install scripts' `TOP_MODELS` (which carry their own copies in `scripts/reinstall.sh` + `scripts/update.sh`). The JSON file is the version anyone actually edits going forward; both runtime (`src/index.ts`) and the test suite (`src/top-models.test.ts`) read from it. The install scripts still carry their own embedded copies because they run before npm dependencies are resolved — but now there's one canonical list to copy from when adding a new model.
- **Alias adds.** `br-sonnet` → `anthropic/claude-sonnet-4.6` (matching the existing `br-` partner shorthand pattern), and `gpt5` now resolves to `openai/gpt-5.5` instead of `openai/gpt-5.4` (following v0.12.167's GPT-5.5 promotion as BlockRun's newest visible flagship).

---

## v0.12.168 — Apr 25, 2026

- **Propagate `openai/gpt-5.5` everywhere it should appear.** v0.12.167 added the model to `BLOCKRUN_MODELS`, the `gpt-5.5` alias, and the install-script `TOP_MODELS` allowlist — but every other place ClawRouter advertises a flagship still pointed at `gpt-5.4`. This release closes the gap so 5.5 is a first-class citizen across routing, the picker, marketing, and the OpenClaw skill page.
  - **`src/router/config.ts` — three fallback-chain insertions, no primary changes.** `openai/gpt-5.5` slots in immediately before `openai/gpt-5.4` in `auto.COMPLEX.fallback`, `premiumTiers.COMPLEX.fallback`, and `agenticTiers.COMPLEX.fallback`. Both stay reachable; 5.5 gets preference when the chain reaches OpenAI. Comments updated so 5.5 is "newest flagship — 1M+ ctx, native agent + computer use" and 5.4 is "previous flagship — benchmarked at 6,213ms, IQ 57". Tier primaries are unchanged: promoting 5.5 to a primary slot needs measured latency/IQ data, which we don't have yet — that's a separate decision tracked outside this release.
  - **`src/index.ts` — `/model` picker allowlist updated.** `src/index.ts` carries its own copy of `TOP_MODELS` (separate from the install scripts' identical-but-distinct list — both populate the OpenClaw allowlist depending on install path). Added `openai/gpt-5.5` and `anthropic/claude-opus-4.5` (also missed in v0.12.167's `BLOCKRUN_MODELS` add for opus-4.5), and replaced the now-deprecated `minimax/minimax-m2.5` with `minimax/minimax-m2.7` so the picker matches the deprecation we landed yesterday.
  - **`README.md` — Premium Models pricing table.** Added the `openai/gpt-5.5` row at $5.00/$30.00 per 1M tokens (~$0.0175 per 0.5K-in-0.5K-out request), 1M context, full feature set. Placed between `claude-opus-4.6` ($0.0150) and `o1` ($0.0375) so the table stays sorted by approximate $/request.
  - **`skills/clawrouter/SKILL.md` — model list line.** The "55+ models including..." line now leads `gpt-5.5, gpt-5.4, ...` and includes `claude-opus-4.5` alongside 4.7/4.6.
- **Files deliberately not touched:** `docs/smart-llm-router-14-dimension-classifier.md` and `docs/llm-router-benchmark-46-models-sub-1ms-routing.md` are frozen benchmark archives — adding 5.5 to a benchmark table without measured numbers would falsify the document. The `posts/*.md` marketing content is similarly point-in-time. Those will be refreshed if/when 5.5 gets benchmarked.

---

## v0.12.167 — Apr 24, 2026

- **Realign the model registry to BlockRun source-of-truth.** Audit found three drifts where ClawRouter's `BLOCKRUN_MODELS` table didn't match what `blockrun/src/lib/models.ts` actually exposes. The server is the source of truth for which models exist and what they cost; the proxy's local view should mirror that 1:1 so cost estimation, the `/model` picker, and routing tier selection all see the same world the server does.
  - **Add `openai/gpt-5.5`.** BlockRun's newest visible OpenAI flagship — first fully retrained base since GPT-4.5, 1M+ context, 128K output, native agent + computer use. Pricing $5/$30 per 1M tokens. Added to `BLOCKRUN_MODELS`, the `gpt-5.5` alias, and the `TOP_MODELS` allowlist in both install scripts. Routing tiers in `src/router/config.ts` continue to anchor on `gpt-5.4` because that's what's benchmarked; users can pin `5.5` explicitly. Routing change is a separate decision.
  - **Add `anthropic/claude-opus-4.5` as a distinct model.** Previously ClawRouter's `MODEL_ALIASES` silently rewrote `anthropic/claude-opus-4.5` to `4.7`, making 4.5 unreachable through ClawRouter even though BlockRun lists it as a separate visible model with its own pricing and 200K context (vs 4.6/4.7's 1M). Removed the alias, added 4.5 to `BLOCKRUN_MODELS` with its real 200K/32K shape, and added an `anthropic/claude-opus-4-5` (dashed) alias for the slug variant. Test in `src/models.test.ts` was codifying the old upgrade-to-4.7 behavior — flipped to assert the pin is preserved end-to-end.
  - **Mark `minimax/minimax-m2.5` deprecated → fallback `minimax/minimax-m2.7`.** BlockRun retired m2.5 entirely (only m2.7 is in their `MODELS` table). ClawRouter still listed both; m2.5 now flips to `deprecated: true` with the m2.7 fallback so existing pins keep working.
  - **`scripts/reinstall.sh` + `scripts/update.sh`:** drop `minimax/minimax-m2.5` from the `TOP_MODELS` picker allowlist (still reachable, just hidden from the picker) and add `openai/gpt-5.5` + `anthropic/claude-opus-4.5`.

---

## v0.12.166 — Apr 24, 2026

- **Tool-call planning prose suppressed even when `finish_reason` is the only signal (thanks @0xCheetah1, #162).** Follow-up to v0.12.165's #161 fix. Live Telegram/OpenClaw testing caught one more shape the planning-prose leak could wriggle through: some upstreams (Moonshot Kimi K2.6 again) mark a turn with `finish_reason: "tool_calls"` without exposing `message.tool_calls` / `delta.tool_calls` at the same inspection point. The #161 gate (`toolCalls.length > 0`) saw no array and let the prose through. The gate is now `endsWithToolCalls || toolCalls.length > 0` — applied consistently across the non-streaming JSON path and the SSE emission path, plus the finish-reason override in the SSE terminal chunk. Two new regression tests in `src/proxy.tool-forwarding.test.ts` — one per response shape — lock the behavior in: a response with `finish_reason: "tool_calls"` and no tool_calls array has its `content` blanked and the `tool_calls` finish_reason preserved. User-visible impact: fewer "I should look up X before replying" preambles sneaking into agent chat surfaces for turns that are supposed to be pure tool invocations.

---

## v0.12.165 — Apr 24, 2026

- **Tool-call planning prose no longer leaks to chat surfaces (thanks @0xCheetah1, #161).** Some OpenAI-compatible providers — Moonshot's Kimi K2.6 was the visible offender through OpenClaw Telegram — return `{ content: "The user wants the current time. I should call get_current_time with Chicago.", tool_calls: [...] }`. Tool execution only needs `tool_calls`; the `content` field is internal planning that the upstream should have hidden behind a `<think>` tag but didn't. ClawRouter now suppresses `content` whenever `tool_calls.length > 0`, in both the non-streaming JSON response path and the SSE-conversion path that clients like OpenClaw hit with `stream: true`. Tool execution is unaffected; only the user-visible planning prose goes away. Covered by two regression tests in `src/proxy.tool-forwarding.test.ts` (one per response shape).
- **Plugin restart loop killed.** `injectModelsConfig()` in `src/index.ts` writes ClawRouter-owned keys into `~/.openclaw/openclaw.json` on every plugin load. OpenClaw's config watcher has a catch-all rule — any change with no matching plugin-declared prefix triggers a full gateway restart — so `mcp.servers.blockrun` writes kept ping-ponging the gateway. The plugin definition now exposes `reload: { noopPrefixes: ["mcp.servers.blockrun"] }` (new optional field on `OpenClawPluginDefinition`) to tell OpenClaw's loader that ClawRouter self-manages that prefix. Silently ignored on OpenClaw runtimes that predate the `reload` field.
- **Dedup + response cache now isolate streaming and non-streaming callers.** Discovered while adding the SSE regression test for the tool-call fix: a `stream: true` request that followed an identical-body `stream: false` request was getting `content-type: application/json` instead of `text/event-stream`. Two compounding bugs. ClawRouter rewrites `parsed.stream = false` before the upstream call (BlockRun API doesn't support streaming), and both `RequestDeduplicator.hash(body)` and `ResponseCache.generateKey(body)` ran AFTER that rewrite — so a `stream:true` and `stream:false` request hashed identically. Worse, `response-cache.ts`'s `normalizeForCache` explicitly stripped `stream` from the key with the comment "we handle streaming separately" (it never did). Fix: (1) prefix both `dedupKey` and `cacheKey` in `src/proxy.ts` with the original `isStreaming` intent (`"sse:"` vs `"json:"`), so the two shapes never share a cache slot; (2) stop stripping `stream` in `normalizeForCache`. Latent bug — real-world impact was small because the exact scenario (identical body, different stream flag, within 30s/10min TTL) is rare in practice — but a correctness bug nonetheless. Regression test added (`isolates dedup cache between streaming and non-streaming requests with identical bodies`); the existing `response-cache.test.ts` expectation was inverted (it was codifying the broken behavior).

---

## v0.12.164 — Apr 23, 2026

- **Video generation switched to async submit + poll (tracks BlockRun server commit 654cd35).** The server-side `/v1/videos/generations` endpoint no longer blocks for the full 60–180s upstream generation — POST now returns `202 { id, poll_url }` in ~3–20s, and a separate GET on the `poll_url` (same x-payment header) returns `202` while the job is queued/in_progress and `200` with the final video on completion. Server settles only on the first completed poll, so upstream failure or caller disconnect = zero USDC charged. ClawRouter's proxy handler in `src/proxy.ts` now collapses this back into a single blocking POST for the client: submit upstream, poll the `poll_url` every 5s (initial 3s grace) up to a 5-min deadline, then backup + serve locally as before. Legacy sync-shaped server responses still work — the handler checks for `poll_url` before switching to the poll loop. Client-side timeouts bumped: `buildVideoGenerationProvider.timeoutMs` 200s → 330s; `/videogen` slash 200s → 330s; both sit above the 5-min internal poll deadline so the last `data[0].url` finishes streaming back. User-facing impact: same blocking POST as before, but Cloudflare's 100s edge timeout no longer kills long-running Seedance 2.0 jobs.

- **Image/video plumbing parity — four exposure surfaces now match the backend.** The BlockRun server has supported 8 image models (DALL-E 3, GPT Image 1, Nano Banana / Pro, Flux 1.1 Pro, Grok Imagine / Pro, CogView-4) and 4 video models (Grok Imagine, Seedance 1.5 Pro / 2.0 Fast / 2.0) since v0.12.162, but the ClawRouter client exposed them inconsistently:
  - **`buildImageGenerationProvider` in `src/index.ts` only advertised 4 image models.** OpenClaw's native image picker couldn't see Flux, Grok Imagine (×2), or CogView-4 — the only way to hit them was raw curl with an explicit `model` field. The `models` array now lists all 8; defaultModel switched from `openai/gpt-image-1` to `google/nano-banana` (cheapest general-purpose default); `capabilities.geometry.sizes` adds CogView-4's 512x512, 768x768, 768x1344, 1344x768, 1440x1440 sizes; `capabilities.edit.enabled` flipped to `true` so OpenClaw's edit UI surfaces gpt-image-1's `/v1/images/image2image` path.
  - **`MODEL_ALIASES` in `src/models.ts` had zero image/video shortcuts.** All 140+ aliases were LLM chat models. Added 17 new aliases so `resolveModelAlias("dalle")` → `openai/dall-e-3`, `"flux"` → `black-forest/flux-1.1-pro`, `"seedance"` → `bytedance/seedance-1.5-pro`, plus `banana`, `banana-pro`, `nano-banana-pro`, `gpt-image`, `flux-pro`, `grok-imagine` / `-pro`, `grok-video`, `cogview`, `seedance-1.5`, `seedance-2`, `seedance-2-fast`.
  - **`/imagegen` and `/videogen` slash commands now actually exist.** README documented `/imagegen a dog dancing on the beach` as if it worked, but no such command was ever registered — it was silent drift from the aspirational README. Both commands now register via `api.registerCommand`, accept `--model=<alias>`, `--size=WxH`, `--n=<int>`, `--duration=<5|8|10>` flags (parsed by a shared `parseGenArgs` helper), resolve aliases through `resolveModelAlias`, POST to the proxy's `/v1/images/generations` and `/v1/videos/generations` endpoints, and return inline markdown (`![image](http://localhost:8402/images/...)`) or video URLs. 402 responses surface as "top up with `/wallet`" hints; video timeout is 200s to cover upstream polling. `/img2img` remains README-only for now — will land in a follow-up.
  - **Partner framework now includes image/video as LLM-callable tools.** Added three new `PartnerServiceDefinition` entries in `src/partners/registry.ts` — `image_generation`, `image_edit`, `video_generation` — so the existing `buildPartnerTools` → `api.registerTool` pipeline surfaces them as `blockrun_image_generation`, `blockrun_image_edit`, `blockrun_video_generation` tools. Agents can now tool-call image/video from chat without the skill layer guessing at raw HTTP shapes.
- **Dropped the Twitter/X user-lookup partner.** We no longer run X data as a product surface. Removed `x_users_lookup` from `PARTNER_SERVICES`, deleted the `skills/x-api/` skill directory, and stripped `x|` from the `/v1/(?:x|partner|pm|...)/` paid-route regex in `src/proxy.ts` (so `/v1/x/*` no longer short-circuits to the partner proxy — it now falls through to the usual chat-completion path or 404s cleanly). Server-side `/v1/x/*` endpoints are still live at `blockrun.ai/api` for any existing integrations; only the client wiring is retired.
- **`/partners` + `clawrouter partners` CLI output compressed ~4×.** Previously 6 lines per service (name, full agent-facing description, tool name, method, pricing block, blank) × 17 services ≈ 100 lines of wall-of-text, which is what @vicky was calling out as "读不了" (unreadable). `PartnerServiceDefinition` gained two fields — `category` ("Prediction markets" / "Market data" / "Image & Video") and `shortDescription` (≤ 40 chars) — driving a new grouped, column-aligned one-liner per tool. The long `description` field stays intact for the LLM-facing JSON Schema (agents still see "Call this ONLY when..." guidance). Output is now ~25 lines, one screen.

---

## v0.12.163 — Apr 23, 2026

- **README leads with the free tier.** Post-v0.12.160 the product story changed — 8 NVIDIA models free forever, no wallet required to start — but the README still opened "fund your wallet" as step 2 of Quick Start and buried the free tier in a single line at the bottom. Rewrites so the free tier is the hook, not a footnote: hero tagline adds "8 models free, no crypto required. No signup. No API key. No credit card." plus a 🆓 shields.io badge; the "Why ClawRouter exists" list opens with "Starts at $0"; the comparison-vs-others table adds a "Free tier" row showing ClawRouter's "8 models, no signup" against OpenRouter's rate limits and LiteLLM/Martian/Portkey's "no"; Quick Start gets a "No wallet? 8 models work free out of the box" callout and reframes step 2 as optional; routing-profiles table adds `/model free` at 100% savings; the Costs section lists the current 8 free model IDs by name (was a stale 11-model list referencing the retired Nemotron Ultra / Mistral Large / Devstral). This release is README-only — code is identical to v0.12.162 — version bump exists so the updated marketing reaches the npmjs.com package page and the clawhub marketplace listing.

---

## v0.12.162 — Apr 23, 2026

- **ByteDance Seedance video models wired into the client.** BlockRun server has exposed three Seedance models since late April — `bytedance/seedance-1.5-pro` ($0.03/sec), `bytedance/seedance-2.0-fast` ($0.15/sec, ~60–80s gen time), and `bytedance/seedance-2.0` Pro ($0.30/sec) — all 720p, text-to-video + image-to-video, 5s default and up to 10s. The `/v1/videos/generations` proxy passthrough in `src/proxy.ts` already forwarded any `model` value untouched, so **actual USDC charges were always correct** (server dictates the amount in its 402 response and `payment-preauth.ts` caches the server-sent `PaymentRequired`, not a local estimate — charges never depended on ClawRouter's local pricing table). Three client-side gaps were fixed anyway:
  - **Usage telemetry was wrong for Seedance.** `estimateVideoCost` in `src/proxy.ts` only knew `xai/grok-imagine-video`, so every Seedance request logged `$0.42/clip` to `logUsage` regardless of what the user was actually billed — skewing `/usage` output, savings %, and journal cost fields. `VIDEO_PRICING` now carries all four models at real server rates.
  - **OpenClaw's native video UI only saw one model.** `buildVideoGenerationProvider` in `src/index.ts` advertised `models: ["xai/grok-imagine-video"]`, so users of the UI picker couldn't pick Seedance at all; the only path was raw curl with an explicit `model` field. The `models` array now lists all four, and provider capabilities widen to `maxDurationSeconds: 10` / `supportedDurationSeconds: [5, 8, 10]` to cover both vendors' ranges (server still validates per-model `maxDurationSeconds`, so invalid combos return a clean 400).
  - **README docs only mentioned Grok.** Video-generation section now lists all four models in the table, swaps the curl example to `bytedance/seedance-2.0-fast` (sweet-spot price/quality), and makes the upstream-polling note vendor-neutral instead of xAI-specific.
- **Docs: fixed proxy port in free-models guide.** Thanks to @Bortlesboat (#160) for catching `4402` → `8402` typos in `docs/11-free-ai-models-zero-cost-blockrun.md`. The rest of the repo, `src/config.ts` (`DEFAULT_PORT = 8402`), and all other docs have always said 8402; that one guide was sending new users at the wrong local port.

---

## v0.12.161 — Apr 22, 2026

- **De-Gemini the Anthropic-primary fallback chains.** When Anthropic hiccups (503s, capacity), Gemini's own "high demand" 503s correlate with the same events — agents fall back from Claude to Gemini together, both overloaded. Reordered `src/router/config.ts` fallback arrays in the two places Anthropic sits primary: `premiumTiers.COMPLEX` (claude-opus-4.7 primary) and `agenticTiers.COMPLEX` (claude-sonnet-4.6 primary). New order: in-family Anthropic hot swap (opus-4.6 / sonnet-4.6) → xAI Grok (independent infra, strong on complex + tool use) → Moonshot Kimi K2.6 / K2.5 (separate Moonshot infra) → OpenAI flagship (slow but reliable) → DeepSeek (cheap reliable) → `free/qwen3-coder-480b` (NVIDIA free ultimate backstop). Gemini removed entirely from both chains. Other Anthropic-primary tiers (`premiumTiers.REASONING`, `agenticTiers.REASONING`) already had no Gemini and were not touched.

---

## v0.12.160 — Apr 21, 2026

- **Free-tier catalog realigned with BlockRun server (13 → 8 NVIDIA free models).** BlockRun retired five NVIDIA free models on 2026-04-21 (`nemotron-ultra-253b`, `nemotron-3-super-120b`, `nemotron-super-49b`, `mistral-large-3-675b`, `devstral-2-123b`) and introduced two new ones benchmark-validated at 114–116 tok/s (`qwen3-next-80b-a3b-thinking` — fastest free reasoning; `mistral-small-4-119b` — fastest free chat). ClawRouter now exposes the same 8 visible free models: `gpt-oss-120b`, `gpt-oss-20b`, `deepseek-v3.2`, `qwen3-coder-480b`, `glm-4.7`, `llama-4-maverick`, `qwen3-next-80b-a3b-thinking`, `mistral-small-4-119b`. Retired IDs still resolve locally via `MODEL_ALIASES` redirects to successors (`free/nemotron-*` → `free/qwen3-next-80b-a3b-thinking`, `free/mistral-large-3-675b` → `free/mistral-small-4-119b`, `free/devstral-2-123b` → `free/qwen3-coder-480b`), matching server-side behavior so stale user configs keep working. Touched: `BLOCKRUN_MODELS` + `MODEL_ALIASES` in `src/models.ts`, `FREE_MODELS` set in `src/proxy.ts`, free-model list in `src/index.ts` picker, `MODEL_PRICING` fixture in `src/router/strategy.test.ts`, `scripts/update.sh` + `scripts/reinstall.sh` `TOP_MODELS` + slash-command help, README Budget Models pricing table + Free tier note, skills/clawrouter/SKILL.md description + Available Models section.
- **Kimi K2.5 routing inverted: Moonshot direct is now primary.** NVIDIA-hosted `nvidia/kimi-k2.5` was retired 2026-04-21 (slow throughput) and redirects server-side to `moonshot/kimi-k2.5`. ClawRouter mirrors this: `moonshot/kimi-k2.5` is the primary entry (no deprecation flag, full 16K output), `nvidia/kimi-k2.5` retained but marked `deprecated: true` with `fallbackModel: "moonshot/kimi-k2.5"`. Aliases `kimi` / `moonshot` / `kimi-k2.5` / `nvidia/kimi-k2.5` all resolve to `moonshot/kimi-k2.5`. Router tier configs in `src/router/config.ts` (auto + premium + agentic profiles, 7 occurrences) updated to point at the Moonshot variant.

---

## v0.12.159 — Apr 21, 2026

- **Market data tools** — BlockRun gateway now exposes realtime and historical market data; ClawRouter wires them into OpenClaw as 6 first-class agent tools so the model stops scraping finance sites. Paid ($0.001 via x402, same wallet as LLM calls): `blockrun_stock_price` and `blockrun_stock_history` across **12 global equity markets** (US, HK, JP, KR, UK, DE, FR, NL, IE, LU, CN, CA). Free (no x402 charge): `blockrun_stock_list` (ticker lookup / company-name search), `blockrun_crypto_price` (BTC-USD, ETH-USD, SOL-USD, …), `blockrun_fx_price` (EUR-USD, GBP-USD, JPY-USD, …), `blockrun_commodity_price` (XAU-USD gold, XAG-USD silver, XPT-USD platinum). Tool schemas advertise market codes, session hints (pre/post/on), and bar resolutions (1/5/15/60/240/D/W/M). Path routing extended: the partner-proxy whitelist in `src/proxy.ts` now matches `/v1/(?:x|partner|pm|exa|modal|stocks|usstock|crypto|fx|commodity)/`, routing all new paths through `proxyPaidApiRequest` (payFetch handles 402 when present, passes through 200 for free categories). Tool definitions added in `src/partners/registry.ts`; `skills/clawrouter/SKILL.md` gains a "Built-in Agent Tools" section listing market data + X intelligence + Polymarket alongside the LLM router.

---

## v0.12.158 — Apr 20, 2026

- **SKILL.md data-flow + key-storage transparency** — second-pass fix for the OpenClaw scanner on clawhub.ai. After v0.12.157 cleared the original scanner concerns (opaque credentials, implied multi-provider keys, no install artifact), a deeper rescan surfaced three new, more nuanced flags: (1) prompts go to blockrun.ai as a data-privacy risk not obvious from a "local router" framing, (2) wallet private-key storage location/encryption undocumented, (3) users may expect strictly-local routing. All three addressed: (a) description frontmatter and body lead reframed as "Hosted-gateway LLM router" + "This is not a local-inference tool" with explicit Ollama pointer for users who need local-only, (b) new **Data Flow** section with ASCII diagram + enumerated sent/not-sent lists + link to https://blockrun.ai/privacy, (c) new **Credentials & Local Key Storage** section documenting config file locations per OS (`~/.config/openclaw`, `~/Library/Application Support/openclaw`, `%APPDATA%\openclaw`), `0600` POSIX permissions, plaintext storage parity with other OpenClaw provider keys, encryption guidance (FileVault/LUKS/BitLocker or burner wallet), and a `src/wallet.ts` source pointer for key-derivation auditing, (d) new **Supply-Chain Integrity** section with `npm pack` verification instructions and tagged-release invariant from the release checklist.

---

## v0.12.157 — Apr 20, 2026

- **SKILL.md credential transparency** — rewrote `skills/clawrouter/SKILL.md` to clear the OpenClaw scanner's medium-confidence suspicious verdict on clawhub.ai. Frontmatter now declares `repository: https://github.com/BlockRunAI/ClawRouter`, `license: MIT`, and a structured `metadata.openclaw.install` array (`kind: node`, `package: @blockrun/clawrouter`, `bins: [clawrouter]`) so the registry entry has an auditable install artifact instead of a bare bash block. Body adds a **Credentials & Data Handling** section fully enumerating what `models.providers.blockrun` stores (`walletKey` / `solanaKey` — auto-generated locally, never transmitted; `gateway` / `routing` — non-sensitive), and explicitly states the plugin does not collect or forward third-party provider API keys (OpenAI/Anthropic/Google/DeepSeek/xAI/NVIDIA) — the blockrun.ai gateway owns those relationships and routes on the server side. Addresses the three scanner flags (opaque credential declaration, implied multi-provider credential collection, no install artifact for review) raised against v0.12.156 on https://clawhub.ai/1bcmax/clawrouter.

---

## v0.12.156 — Apr 20, 2026

- **Kimi K2.6 added** — Moonshot's new flagship (`moonshot/kimi-k2.6`, 256K context, vision + reasoning, $0.95 in / $4.00 out per 1M) registered in `BLOCKRUN_MODELS` with `kimi-k2.6` alias. Added to the curated `/model` picker list (`src/index.ts`, `scripts/update.sh`, `scripts/reinstall.sh`), the README pricing table, `docs/routing-profiles.md`, and the AI-agent-facing model catalog in `skills/clawrouter/SKILL.md`. Premium routing tier (`blockrun/premium`) now uses K2.6 as the SIMPLE primary and as a fallback in MEDIUM/COMPLEX, with `nvidia/kimi-k2.5` retained as the first fallback for reliability. The generic `kimi`/`moonshot` aliases still resolve to `nvidia/kimi-k2.5` (matches BlockRun server's `blockrun/kimi` stance); users opt in to K2.6 explicitly via `kimi-k2.6` or `blockrun/premium`.
- **GitHub restored as canonical source** — BlockRunAI GitHub org is back. `package.json` `repository.url`, README badges, CONTRIBUTING clone URL, `openclaw.security.json`, all docs (`anthropic-*`, `clawrouter-cuts-*`, `clawrouter-vs-openrouter`, `11-free-ai-models`, `llm-router-benchmark-*`, `smart-llm-router-14-dimension-classifier`, `subscription-failover`, `troubleshooting`), `skills/release/SKILL.md`, and the `sse-error-format` regression-test comment now point at `github.com/BlockRunAI/ClawRouter`. GitLab mirror (`gitlab.com/blockrunai/ClawRouter`) is kept as a secondary remote for redundancy but is no longer advertised. Metadata + docs only; no runtime/code changes.

---

## v0.12.155 — Apr 18, 2026

- **Docs: video generation endpoint** — README now documents `POST /v1/videos/generations` with `xai/grok-imagine-video` ($0.05/sec, 8s default). The proxy handler, cost estimator (`estimateVideoCost`), and local-file download path were already in place in `proxy.ts`; only the README was missing.
- **Docs: Grok Imagine image models** — README image table now includes `xai/grok-imagine-image` ($0.02) and `xai/grok-imagine-image-pro` ($0.07), already wired into the image pricing map.

---

## v0.12.153 — Apr 16, 2026

- **Claude Opus 4.7 flagship** — BlockRun API has promoted `anthropic/claude-opus-4.7` to flagship (1M context, 128K output, adaptive thinking; $5/$25 per 1M tokens). Added to `BLOCKRUN_MODELS`, now the primary for the `COMPLEX` routing tier across default/premium profiles and the new cost-savings `BASELINE_MODEL_ID`. Aliases: `opus`, `opus-4`, `anthropic/opus`, `anthropic/claude-opus-4`, and `anthropic/claude-opus-4.5` now resolve to 4.7. Explicit 4.6 pins (`opus-4.6`, `anthropic/claude-opus-4-6`) still route to 4.6, which the server keeps available. Opus 4.7 is also added to the curated `TOP_MODELS` picker list and `doctor` command. Opus 4.6 ClawRouter metadata updated to match server specs (1M/128K, was stale at 200K/32K).

---

## v0.12.152 — Apr 16, 2026

- **Repository URL fixed** — `package.json` `repository.url` now points at `gitlab.com/blockrunai/ClawRouter`. The previous value (`github.com/BlockRunAI/ClawRouter`) has been dead since the GitHub org was banned 2026-04-15. Metadata-only bump; no code changes.

---

## v0.12.151 — Apr 16, 2026

- **Stop bundling blockrun-mcp** — ClawRouter no longer auto-injects `mcp.servers.blockrun` into `~/.openclaw/openclaw.json`. The `npx -y @blockrun/mcp@latest` spawns were leaking shell-wrapper + node grandchildren processes on the host (see reports of 70+ orphaned processes accumulating). Removal of the injection call is matched by a one-shot migration that strips any previously managed `mcp.servers.blockrun` entry the next time the gateway starts. User-defined `blockrun` MCP entries are preserved. **Restart your gateway after upgrading** to free any already-leaked processes. Users who still want the MCP bridge can opt in manually: `openclaw mcp add blockrun npx -y @blockrun/mcp@latest`.

---

## v0.12.89 — Mar 30, 2026

- **Predexon tools registered** — 8 Predexon endpoints now registered as real OpenClaw tools (`blockrun_predexon_events`, `blockrun_predexon_leaderboard`, `blockrun_predexon_markets`, `blockrun_predexon_smart_money`, `blockrun_predexon_smart_activity`, `blockrun_predexon_wallet`, `blockrun_predexon_wallet_pnl`, `blockrun_predexon_matching_markets`). Agent will now call these directly instead of falling back to browser scraping.
- **Partner tools GET support** — `tools.ts` execute function now handles GET endpoints with query params and path param substitution (`:wallet`, `:condition_id`, etc.).

---

## v0.12.88 — Mar 30, 2026

- **Skill priority fix** — `predexon` and `x-api` skills now explicitly instruct the agent not to use browser/web_fetch for these data sources, ensuring the structured API is always used over scraping.

---

## v0.12.87 — Mar 30, 2026

- **Predexon skill** — New vendor skill ships with ClawRouter: 39 prediction market endpoints (Polymarket, Kalshi, dFlow, Binance, cross-market matching, wallet analytics, smart money). OpenClaw agents now auto-invoke this skill when users ask about prediction markets, market odds, or smart money positioning.
- **Partner proxy extended** — `/v1/pm/*` paths now route through ClawRouter's partner proxy (same as `/v1/x/*`), enabling automatic x402 payment for all Predexon endpoints via `localhost:8402`.

---

## v0.12.86 — Mar 29, 2026

### Fixed

- **Free model cost logging** — Usage stats incorrectly showed non-zero cost for free models (e.g. `free/gpt-oss-120b` showed $0.001 per request due to the `MIN_PAYMENT_USD` floor in `calculateModelCost`). Free models now log `cost: $0.00`and`savings: 100%`, accurately reflecting that no payment is made.

---

## v0.12.84 — Mar 26, 2026

### Fixed

- **`/doctor` checks correct chain balance** — Previously always checked Base (EVM), showing $0.00 for Solana-funded wallets. Now calls `resolvePaymentChain()` and uses `SolanaBalanceMonitor` when on Solana. Shows active chain label and hints to run `/wallet solana` if balance is empty on Base.
- **Strip thinking tokens from non-streaming responses** — Free models leaked `<think>...</think>` blocks in non-streaming responses. `stripThinkingTokens()` was only applied in the streaming path — now also runs on non-streaming JSON responses.
- **Preserve OpenClaw channels on install/update** — `reinstall.sh` and `update.sh` now backup `~/.openclaw/credentials/` before `openclaw plugins install` and always restore after, preventing WhatsApp/Telegram channel disappearance.

### Added

- **Blog section in README** — 6 blog posts linked from the repo, including "11 Free AI Models, Zero Cost".
- **BRCC ecosystem block** — Replaced SocialClaw with BRCC (BlockRun for Claude Code) in the README ecosystem section.
- **`blockrun.ai/brcc-install` short link** — Redirect for BRCC install script.

---

## v0.12.81 — Mar 25, 2026

### Added

- **11 free models** — GPT-OSS 20B/120B, Nemotron Ultra 253B, Nemotron Super 49B/120B, DeepSeek V3.2, Mistral Large 3, Qwen3 Coder 480B, Devstral 2 123B, GLM 4.7, Llama 4 Maverick. All free, no wallet balance needed.
- **`/model free` alias** — Points to nemotron-ultra-253b (strongest free model). All 11 free models individually selectable via `/model` picker.
- **New model aliases** — `nemotron`, `devstral`, `qwen-coder`, `maverick`, `deepseek-free`, `mistral-free`, `glm-free`, `llama-free`, and more (16 total).

### Fixed

- **Skills not found by OpenClaw agents** — Auto-copies bundled skills (imagegen, x-api, clawrouter) to `~/.openclaw/workspace/skills/` on plugin registration. Fixes `ENOENT` errors when agents invoke `/imagegen`.
- **Internal `release` skill excluded** — No longer installed to user workspaces.
- **Sync package-lock.json**

---

## v0.12.73 — Mar 24, 2026

### Fixed

- **Skills not found by OpenClaw agents** — Agents tried to read skill files (imagegen, x-api, etc.) from `~/.openclaw/workspace/skills/` but ClawRouter only bundled them inside the npm package. Now auto-copies all user-facing bundled skills into the workspace directory on plugin registration. Supports `OPENCLAW_PROFILE` for multi-profile setups. Only updates when content changes. Fixes `ENOENT: no such file or directory` errors when agents invoke `/imagegen`.
- **Internal `release` skill excluded** — The release checklist skill is for ClawRouter maintainers only and is no longer installed to user workspaces.
- **Sync package-lock.json** — Lock file was stuck at v0.12.69, now matches package.json.

---

## v0.12.70 — Mar 24, 2026

### Fixed

- **Plugin crash on string model config** — ClawRouter crashed during OpenClaw plugin registration with `TypeError: Cannot create property 'primary' on string 'blockrun/auto'`. This happened when `agents.defaults.model` in the OpenClaw config was a plain string (e.g. `"blockrun/auto"`) instead of the expected object `{ primary: "blockrun/auto" }`. Now auto-converts string/array/non-object model values to the correct object form.

---

## v0.12.67 — Mar 22, 2026

### Fixed

- **Config duplication on update** — `update.sh` and `reinstall.sh` accumulated stale `blockrun/*` model entries in `openclaw.json` on every update because only 2 hardcoded deprecated models were removed. Now performs a full reconciliation: removes any `blockrun/*` entries not in the current `TOP_MODELS` list before adding new ones. Non-blockrun entries are untouched.

---

## v0.12.30 — Mar 9, 2026

- **OpenClaw skills registration** — added `"skills": ["./skills"]` to `openclaw.plugin.json` so OpenClaw actually loads bundled skills (was missing, skills were never active)
- **imagegen skill** — new `skills/imagegen/SKILL.md`: teaches Claude to generate images via `POST /v1/images/generations`, model selection table (nano-banana, banana-pro, dall-e-3, flux), size options, example interactions
- **x-api skill** — new `skills/x-api/SKILL.md`: teaches Claude to look up X/Twitter user profiles via `POST /v1/x/users/lookup`, with pricing table, response schema, and example interactions

---

## v0.12.25 — Mar 8, 2026

- **Image generation docs** — new `docs/image-generation.md` with API reference, curl/TypeScript/Python/OpenAI SDK examples, model pricing table, and `/imagegen` command reference
- **Comprehensive docs refresh** — architecture updated for dual-chain (Base + Solana), configuration updated with all env vars (`CLAWROUTER_SOLANA_RPC_URL`, `CLAWROUTER_WORKER`), troubleshooting updated for USDC-on-Solana funding, CHANGELOG backfilled for v0.11.14–v0.12.24

---

## v0.12.24 — Mar 8, 2026

- **Preserve user-defined blockrun/\* allowlist entries** — `injectModelsConfig()` no longer removes user-added `blockrun/*` allowlist entries on gateway restarts

---

## v0.12.14 — Mar 6, 2026

- **`/chain` command** — persist payment chain selection (Base or Solana) across restarts via `/chain solana` or `/chain base`
- **Update nudge improved** — now shows `npx @blockrun/clawrouter@latest` instead of `curl | bash`
- **Zero balance cache fix** — funded wallets are detected immediately (zero balance never cached)
- **`wallet recover` command** — restore `wallet.key` from BIP-39 mnemonic on a new machine
- **Solana balance retry** — retries once on empty to handle flaky public RPC endpoints
- **Balance cache invalidated at startup** — prevents false free-model fallback after fresh install

---

## v0.12.13 — Mar 5, 2026

- **openai/ prefix routing fix** — virtual profiles (`blockrun/auto`, etc.) now handle `openai/` prefix injected by some clients
- **Body-read timeout increased** — 5-minute timeout for slow reasoning models prevents proxy hangs

---

## v0.12.11 — Mar 5, 2026

- **Server-side update nudge** — 429 responses from BlockRun now surface update hints when running an outdated ClawRouter version
- **Body-read timeout** — prevents proxy from hanging on stalled upstream streams
- **@solana/kit version fix** — pinned to `^5.0.0` to resolve cross-version signing bug causing `transaction_simulation_failed` (#74)
- **`/stats clear` command** — reset usage statistics
- **Gemini 3 models excluded from tool-heavy routing** (#73)
- **GPT-5.4 and GPT-5.4 Pro** — added to model catalog

---

## v0.12.5 — Mar 4, 2026

- **Force agentic tiers on tool presence** — requests with `tools` array always route to agentic-capable models

---

## v0.12.4 — Mar 4, 2026

- **Solana sweep fix** — correctly attaches signers to sweep transaction message (#70)

---

## v0.12.3 — Mar 4, 2026

- **Multi-account sweep** — correctly handles partial reads and JSONL resilience in sweep migration
- **SPL Token Program ID fix** — corrected in Solana sweep transaction

---

## v0.12.0 — Mar 3, 2026

### Solana USDC Payments

Full Solana chain support. Pay with **USDC on Solana** (not SOL) alongside Base (EVM).

- **SLIP-10 Ed25519 derivation** — Solana wallet uses BIP-44 path `m/44'/501'/0'/0'`, compatible with Phantom and other wallets (#69)
- **`SolanaBalanceMonitor`** — reads SPL Token USDC balance; `proxy.ts` selects EVM or Solana monitor based on active chain
- **Solana address shown in `/wallet`** — displays both EVM (`0x...`) and Solana (base58) addresses
- **Health endpoint** — returns Solana address alongside EVM address
- **Pre-auth cache skipped for Solana** — prevents double payment on Solana chain
- **Startup balance uses chain-aware monitor** — fixes EVM-only startup log when Solana is active
- **Chain-aware proxy reuse** — validates payment chain matches on EADDRINUSE path
- **`ethers` peer dep** — added for `@x402/evm` via SIWE compatibility

---

## v0.11.14 — Mar 2, 2026

- **Free model fallback notification** — notifies user when routing to `gpt-oss-120b` due to insufficient USDC balance

---

## v0.11.11 — Mar 2, 2026

- **Input token logging** — usage logs now include `inputTokens` from provider responses

## v0.11.10 — Mar 2, 2026

- **Gemini 3.x in allowlist** — replaced Gemini 2.5 with Gemini 3.1 Pro and Gemini 3 Flash Preview

## v0.11.9 — Mar 2, 2026

- **Top 16 model allowlist** — trimmed from 88 to 16 curated models in `/model` picker (4 routing profiles + 12 popular models)

## v0.11.8 — Mar 2, 2026

- **Populate model allowlist** — populate `agents.defaults.models` with BlockRun models so they appear in `/model` picker

## v0.11.7 — Mar 1, 2026

- **Auto-fix broken allowlist** — `injectModelsConfig()` detects and removes blockrun-only allowlist on every gateway start

## v0.11.6 — Mar 1, 2026

- **Allowlist cleanup in reinstall.sh** — detect and remove blockrun-only allowlist that hid all other models

## v0.11.5 — Mar 1, 2026

- **`clawrouter report` command** — daily/weekly/monthly usage reports via `npx @blockrun/clawrouter report`
- **`clawrouter doctor` command** — AI diagnostics for troubleshooting

## v0.11.4 — Mar 1, 2026

- **catbox.moe image hosting** — `/imagegen` uploads base64 data URIs to catbox.moe (replaces broken telegra.ph)

## v0.11.3 — Mar 1, 2026

- **Image upload for Telegram** — base64 data URIs from Google image models converted to hosted URLs

## v0.11.2 — Feb 28, 2026

- **Output raw image URL** — `/imagegen` returns plain URL instead of markdown syntax for Telegram compatibility

---

## v0.11.0 / v0.11.1 — Feb 28, 2026

### Three-Strike Escalation

Session-level repetition detection: 3 consecutive identical request hashes auto-escalate to the next tier (SIMPLE → MEDIUM → COMPLEX → REASONING). Fixes Kimi K2.5 agentic loop problem without manual model switching.

### `/imagegen` command

Generate images from chat. Calls BlockRun's image generation API with x402 micropayments.

```
/imagegen a cat wearing sunglasses
/imagegen --model dall-e-3 a futuristic city
/imagegen --model banana-pro --size 2048x2048 landscape
```

| Model                        | Shorthand     | Price                  |
| ---------------------------- | ------------- | ---------------------- |
| Google Nano Banana (default) | `nano-banana` | $0.05/image            |
| Google Nano Banana Pro       | `banana-pro`  | $0.10/image (up to 4K) |
| OpenAI DALL-E 3              | `dall-e-3`    | $0.04/image            |
| OpenAI GPT Image 1           | `gpt-image`   | $0.02/image            |
| Black Forest Flux 1.1 Pro    | `flux`        | $0.04/image            |

---

## v0.10.20 / v0.10.21 — Feb 27, 2026

- **Stop hijacking model picker** — removed allowlist injection that hid non-BlockRun models from `/model` picker
- **Silent fallback to free model** — insufficient funds now skips remaining paid models and jumps to the free tier instead of showing payment errors

---

## v0.10.19 — Feb 27, 2026

- **Anthropic array content extraction** — routing now handles `[{type:"text", text:"..."}]` content format (was extracting empty string)
- **Session startup bias fix** — never-downgrade logic: sessions can upgrade tiers but won't lock to the low-complexity startup message tier

---

## v0.10.18 — Feb 26, 2026

- **Session re-pins to fallback** — after provider failure, session updates to the actual model that responded instead of retrying the failing primary every turn

---

## v0.10.16 / v0.10.17 — Feb 26, 2026

- **`/debug` command** — type `/debug <prompt>` to see routing diagnostics (tier, model, scores, session state) with zero API cost
- **Tool-calling model filter** — requests with tool schemas skip incompatible models automatically
- **Session persistence enabled by default** — `deriveSessionId()` hashes first user message; model stays pinned 30 min without client headers
- **baselineCost fix** — hardcoded Opus 4.6 fallback pricing so savings metric always calculates correctly

---

## v0.10.12 – v0.10.15 — Feb 26, 2026

- **Tool call leaking fix** — removed `grok-code-fast-1` from all routing paths (was outputting tool invocations as plain text)
- **Systematic tool-calling guard** — `toolCalling` flag on models; incompatible models filtered from fallback chains
- **Async plugin fix** — `register()` made synchronous; OpenClaw was silently skipping initialization

---

## v0.10.9 — Feb 24, 2026

- **Agentic mode false trigger** — `agenticScore` now scores user prompt only, not system prompt. Coding assistant system prompts no longer force all requests to Sonnet.

---

## v0.10.8 — Feb 24, 2026

- **OpenClaw tool API contract** — fixed `inputSchema` → `parameters`, `execute(args)` → `execute(toolCallId, params)`, and return format

---

## v0.10.7 — Feb 24, 2026

- **Partner tool trigger reliability** — directive tool description so AI calls the tool instead of answering from memory
- **Baseline cost fix** — `BASELINE_MODEL_ID` corrected from `claude-opus-4-5` to `claude-opus-4.6`
- **Wallet corruption safety** — corrupted wallet files throw with recovery instructions instead of silently generating new wallet

---

## v0.10.5 — Feb 22, 2026

- **9-language router** — added ES, PT, KO, AR keywords across all 12 scoring dimensions (was 5 languages)

---

## v0.10.0 — Feb 21, 2026

- **Claude 4.6** — all Claude models updated to newest Sonnet 4.6 / Opus 4.6
- **7 new models** — total 41 (Gemini 3.1 Pro Preview, Gemini 2.5 Flash Lite, o1, o1-mini, gpt-4.1-nano, grok-2-vision)
- **5 pricing fixes** — 15-30% better routing from corrected model costs
- **67% cheaper ECO tier** — Flash Lite for MEDIUM/COMPLEX
