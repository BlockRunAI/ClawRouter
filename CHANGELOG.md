# Changelog

All notable changes to ClawRouter.

---

## v0.12.172 — May 2, 2026

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

- **Synthesize structured `tool_calls` from XML/text formats some models emit in `content`.** Earlier tool-call hardening (v0.12.165, v0.12.166) handled the case where upstream returned a structured `tool_calls` array (or signaled `finish_reason: "tool_calls"`) and the model also leaked planning prose into `content`. This release closes a third gap where upstream returns *no* structured tool calls at all and the model's actual tool invocations live as XML/text inside `content` — typical when a downstream client (OpenClaw is the visible offender) prompt-engineers tool instructions instead of sending a structured `tools[]` schema, so the model dutifully honors the prompt format and emits the call as text. Two formats observed in the wild are now recognized and converted to OpenAI-shaped `tool_calls`:
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

- **Free model cost logging** — Usage stats incorrectly showed non-zero cost for free models (e.g. `free/gpt-oss-120b` showed $0.001 per request due to the `MIN_PAYMENT_USD` floor in `calculateModelCost`). Free models now log `cost: $0.00` and `savings: 100%`, accurately reflecting that no payment is made.

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
