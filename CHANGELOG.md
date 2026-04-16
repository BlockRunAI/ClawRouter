# Changelog

All notable changes to ClawRouter.

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
