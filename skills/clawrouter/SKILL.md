---
name: clawrouter
description: Hosted-gateway LLM router — save 67% on inference costs. A local proxy that forwards each request to the blockrun.ai gateway, which routes to the cheapest capable model across 55+ models from OpenAI, Anthropic, Google, DeepSeek, xAI, NVIDIA, and more. 7 free NVIDIA models included. Also exposes realtime market data (global stocks, crypto, FX, commodities), Twitter/X intelligence, prediction-market data across Polymarket, Kalshi, Limitless, Opinion, Predict.Fun, dFlow + UMA oracle resolution + wallet identity & clustering, phone-number intelligence (carrier + SIM-swap fraud detection) plus AI-powered outbound voice calls (Twilio + Bland.ai), AND the Surf unified crypto data API (84 endpoints — CEX/DEX, on-chain SQL over 80+ ClickHouse tables, 100M+ labeled wallets, prediction markets, social/CT mindshare, news, VC fund intel) as built-in agent tools. Not a local-inference tool — prompts are sent to the blockrun.ai gateway.
triggers:
  - "clawrouter"
  - "claw router"
  - "@blockrun/clawrouter"
  - "blockrun gateway"
  - "blockrun llm router"
  - "blockrun ai gateway"
  - "blockrun.ai inference"
  - "save on llm costs blockrun"
  - "cheapest model blockrun"
  - "free nvidia models blockrun"
  - "x402 llm payment"
  - "usdc llm gateway"
  - "openrouter alternative"
  - "blockrun phone"
  - "blockrun voice call"
  - "ai phone call"
  - "phone number verification"
  - "sim swap detection"
  - "outbound ai call"
  - "blockrun surf"
  - "surf crypto api"
  - "on-chain sql query"
  - "clickhouse onchain"
  - "wallet labels api"
  - "crypto mindshare"
  - "crypto news api"
homepage: https://blockrun.ai/clawrouter.md
repository: https://github.com/BlockRunAI/ClawRouter
license: MIT
metadata:
  {
    "openclaw":
      {
        "emoji": "🦀",
        "requires": { "config": ["models.providers.blockrun"] },
        "install":
          [
            {
              "id": "node",
              "kind": "node",
              "package": "@blockrun/clawrouter",
              "bins": ["clawrouter"],
              "label": "Install ClawRouter (npm)",
            },
          ],
      },
  }
---

# ClawRouter

Hosted-gateway LLM router that saves 67% on inference costs by forwarding each request to the blockrun.ai gateway, which picks the cheapest model capable of handling it across 55+ models from 9 providers (7 free NVIDIA models). All billing flows through one USDC wallet; you do not hold provider API keys.

**This is not a local-inference tool.** ClawRouter is a thin local proxy. Your prompts are sent over HTTPS to the blockrun.ai gateway for model execution. If your workload requires inference that never leaves your machine, use a local runtime like Ollama — ClawRouter is not the right tool for that use case.

Source: https://github.com/BlockRunAI/ClawRouter · npm: https://www.npmjs.com/package/@blockrun/clawrouter · License: MIT.

## Data Flow

```
Your app → localhost proxy (ClawRouter) → https://blockrun.ai/api  (or sol.blockrun.ai/api)
                                              ↓
                                        OpenAI / Anthropic / Google / etc.
                                              ↓
                                        Response → back through proxy → your app
```

**Sent to blockrun.ai on every request:** the model name, the full prompt/messages body, sampling params (temperature, max_tokens, tools, etc.), and an `X-PAYMENT` header containing a signed x402 USDC micropayment.

**Not sent:** your wallet private key (only the detached payment signature is sent), any other local files, environment variables, or OpenClaw config beyond what's needed for this request.

**Blockrun's privacy stance:** https://blockrun.ai/privacy. Treat prompts the same way you'd treat prompts sent to any hosted LLM API (OpenAI, Anthropic, etc.) — do not send data you would not share with a third-party API provider.

## Credentials & Local Key Storage

ClawRouter does **not** collect or forward third-party provider API keys. You do not supply OpenAI, Anthropic, Google, DeepSeek, xAI, or NVIDIA credentials — the blockrun.ai gateway owns those relationships.

**What `models.providers.blockrun` stores (fully enumerated):**

| Field       | Sensitive | Purpose                                                                                                                                                                                                    |
| ----------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `walletKey` | Yes       | EVM private key used to sign USDC micropayments via x402. **Auto-generated locally on first run** — no user input required. Never transmitted over the network; only detached payment signatures are sent. |
| `solanaKey` | Yes       | Solana keypair (BIP-44 `m/44'/501'/0'/0'`). Auto-derived from the same local mnemonic via `@scure/bip32` + `@scure/bip39`.                                                                                 |
| `gateway`   | No        | Gateway URL. Defaults: `https://blockrun.ai/api` (Base) · `https://sol.blockrun.ai/api` (Solana).                                                                                                          |
| `routing`   | No        | Optional override of the default four-tier router.                                                                                                                                                         |

**How and where keys are stored:**

- Keys live in the OpenClaw user config file — typically `~/.config/openclaw/config.json` on Linux, `~/Library/Application Support/openclaw/config.json` on macOS, `%APPDATA%\openclaw\config.json` on Windows — under the `models.providers.blockrun` path.
- Written by OpenClaw's standard config writer with `0600` permissions on POSIX systems (owner read/write only).
- **Stored in plaintext**, the same way every OpenClaw provider's API key is stored. ClawRouter does not add an extra encryption layer; your filesystem permissions are the security boundary. If you require an encrypted keystore, run OpenClaw on an encrypted volume (FileVault, LUKS, BitLocker) or use a dedicated burner wallet funded only with what you intend to spend.
- Auto-generation uses `@scure/bip39` to produce a 24-word mnemonic, then BIP-44 derivation for both chains. Source: [`src/wallet.ts`](https://github.com/BlockRunAI/ClawRouter/blob/main/src/wallet.ts).

**Operational guidance:** treat the wallet as a spending account with a small top-up, not a long-term store of value. Fund it with what you expect to spend on LLM calls. If the host machine is compromised, the wallet key is compromised — rotate and refund.

## Supply-Chain Integrity

- Every release is tagged on GitHub: https://github.com/BlockRunAI/ClawRouter/releases
- Every release publishes to npm with a matching version: https://www.npmjs.com/package/@blockrun/clawrouter?activeTab=versions
- The `skills/release/SKILL.md` mandatory checklist enforces: same version in `package.json`, matching git tag, matching GitHub release, and matching npm publish.
- To verify locally: `npm pack @blockrun/clawrouter@<version>` and compare the tarball contents to the tagged commit.

## Install

```bash
openclaw plugins install @blockrun/clawrouter
```

The structured `install` block above tells OpenClaw to install the auditable npm package `@blockrun/clawrouter`. Source for every version is on GitHub; every release is tagged.

## Setup

```bash
# Enable smart routing (auto-picks cheapest model per request)
openclaw models set blockrun/auto

# Or pin a specific model
openclaw models set openai/gpt-4o
```

## How Routing Works

ClawRouter classifies each request into one of four tiers:

- **SIMPLE** (40% of traffic) — factual lookups, greetings, translations → Gemini Flash ($0.60/M, 99% savings)
- **MEDIUM** (30%) — summaries, explanations, data extraction → DeepSeek Chat ($0.42/M, 99% savings)
- **COMPLEX** (20%) — code generation, multi-step analysis → Claude Opus ($75/M, best quality)
- **REASONING** (10%) — proofs, formal logic, multi-step math → o3 ($8/M, 89% savings)

Rules handle ~~80% of requests in <1ms. Only ambiguous queries hit the LLM classifier (~~$0.00003 per classification).

## Available Models

55+ models including: gpt-5.5, gpt-5.4, gpt-4o, o3, claude-opus-4.8, claude-opus-4.7, claude-opus-4.6, claude-opus-4.5, claude-sonnet-4.6, gemini-3.1-pro, gemini-2.5-flash, deepseek-v4-pro, deepseek-chat, grok-4.3, grok-build-0.1, kimi-k2.7, kimi-k2.6, and 8 free NVIDIA models (gpt-oss-120b [default], gpt-oss-20b, mistral-large-3-675b, qwen3.5-122b-a10b, qwen3-next-80b-a3b-instruct, llama-4-maverick, seed-oss-36b [coding], nemotron-3-nano-omni-30b-a3b-reasoning [vision]).

## Built-in Agent Tools

In addition to LLM routing, ClawRouter exposes BlockRun's x402-gated data APIs as ready-to-use OpenClaw tools. Every tool is paid from the same USDC wallet — no extra setup, no extra API keys.

### Market Data

Realtime prices and historical OHLC across every asset class. The agent should call these directly instead of scraping finance sites.

| Tool                       | Coverage                                                                        | Price         |
| -------------------------- | ------------------------------------------------------------------------------- | ------------- |
| `blockrun_stock_price`     | 12 global markets: US (NYSE/Nasdaq), HK, JP, KR, UK, DE, FR, NL, IE, LU, CN, CA | $0.001 / call |
| `blockrun_stock_history`   | OHLC bars at 1/5/15/60/240-min or D/W/M resolution                              | $0.001 / call |
| `blockrun_stock_list`      | Ticker lookup / company-name search per market                                  | Free          |
| `blockrun_crypto_price`    | BTC-USD, ETH-USD, SOL-USD, and more                                             | Free          |
| `blockrun_fx_price`        | EUR-USD, GBP-USD, JPY-USD, and more                                             | Free          |
| `blockrun_commodity_price` | XAU-USD (gold), XAG-USD (silver), XPT-USD (platinum)                            | Free          |

### Image & Video Generation

| Tool                        | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Price                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `blockrun_image_generation` | 8 image models — DALL-E 3, Nano Banana / Pro, Flux, Grok Imagine, CogView-4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | $0.015–$0.15 / image                                                |
| `blockrun_image_edit`       | Edit / inpaint existing image (openai/gpt-image-1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | $0.02–$0.04 / image                                                 |
| `blockrun_video_generation` | Grok Imagine + ByteDance Seedance (1.5-pro / 2.0-fast / 2.0) at 720p with synced audio (t2v default), 5–10s, + OpenAI Sora 2 via Azure (`azure/sora-2`, 4/8/12s, t2v + i2v, rejects human faces in reference images). Seedance is token-priced upstream (~20,256 tokens/sec at the 720p+audio default — 2× the prior 480p rate); `image_url` (image-to-video) costs the same as t2v since 2026-06-01. Seedance 2.0 variants accept optional `real_face_asset_id` (`ta_…`) for BytePlus RealFace character-consistency — mutually exclusive with `image_url`. | $0.05/s (Grok); $0.10/s (Sora 2); Seedance ~$0.46–$1.49 per 5s clip |

### Phone & Voice (Twilio + Bland.ai)

Verify phone numbers and place AI-powered outbound voice calls. **Real-world side effects** — only call `blockrun_voice_call` when the user has explicitly asked to place a call. Server enforces an emergency-number blocklist; ClawRouter does not.

| Tool                             | Purpose                                                              | Price      |
| -------------------------------- | -------------------------------------------------------------------- | ---------- |
| `blockrun_phone_lookup`          | Carrier + line type (mobile/landline/voip) for any E.164 number      | $0.01      |
| `blockrun_phone_lookup_fraud`    | SIM-swap + call-forwarding fraud signals (use before SMS-code flows) | $0.05      |
| `blockrun_phone_numbers_buy`     | Provision a US/CA number bound to this wallet (30-day lease)         | $5.00      |
| `blockrun_phone_numbers_renew`   | Extend a wallet-owned number's lease 30 days                         | $5.00      |
| `blockrun_phone_numbers_list`    | List numbers the wallet currently owns + expiry timestamps           | $0.001     |
| `blockrun_phone_numbers_release` | Release a wallet-owned number back to the pool                       | free       |
| `blockrun_voice_call`            | AI outbound call via Bland.ai — up to 30 min, transcript + recording | $0.54 flat |
| `blockrun_voice_status`          | Poll a call's status / transcript / recording                        | free       |

Voice calls are **fire-and-forget**: the POST returns a `call_id` + `poll_url` immediately, the call itself runs in the cloud for up to 30 minutes. Poll `blockrun_voice_status` every 10–30s while in_progress to retrieve the transcript. Slash command: `/cr-call +1<E.164> "<task>" [--voice nat] [--max-duration 5]`. CLI: `clawrouter phone numbers list/buy/renew/release` and `clawrouter phone lookup/fraud <+E.164>`. See the `phone` skill for the full call-flow reference.

### Prediction Markets (Predexon)

Full prediction-market toolbox spanning **Polymarket, Kalshi, Limitless, Opinion, Predict.Fun, dFlow** + Binance for crypto candles. **57 endpoints (Predexon v2) exposed as 9 agent tools** (8 named ergonomic wrappers + 1 catch-all):

- **Markets & trading** — events, markets list per venue, cross-venue search (`markets/search`), orderbooks, candlesticks (per-market and per-token), trades, positions, volume charts.
- **Leaderboard & smart money** — global + per-market leaderboards, smart-money positioning, top holders, smart-activity feed.
- **Wallet analytics** — full wallet profile, P&L time series, per-market breakdown, similar-wallet discovery, batch profiles, AND/OR filters.
- **UMA oracle + wallet identity** — UMA optimistic-oracle resolution status (`uma/markets`, `uma/market/{conditionId}`); wallet identity labels (ENS / Lens / exchange / risk tags), bulk identity, on-chain cluster discovery.

| Tool                                 | Coverage                                                                                                                                                                                                                                                                             | Price                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| `blockrun_predexon_events`           | Live Polymarket events with current odds                                                                                                                                                                                                                                             | $0.001 / call          |
| `blockrun_predexon_markets`          | Search Polymarket markets by keyword                                                                                                                                                                                                                                                 | $0.001 / call          |
| `blockrun_predexon_leaderboard`      | Top Polymarket traders ranked by profit                                                                                                                                                                                                                                              | $0.001 / call          |
| `blockrun_predexon_smart_money`      | Smart-money positions on a specific market                                                                                                                                                                                                                                           | $0.005 / call          |
| `blockrun_predexon_smart_activity`   | Markets where smart money is currently active                                                                                                                                                                                                                                        | $0.005 / call          |
| `blockrun_predexon_wallet`           | Polymarket wallet profile (PnL, winrate, positions)                                                                                                                                                                                                                                  | $0.005 / call          |
| `blockrun_predexon_wallet_pnl`       | Wallet P&L time series                                                                                                                                                                                                                                                               | $0.005 / call          |
| `blockrun_predexon_matching_markets` | Polymarket ↔ Kalshi market pairs (arb compare)                                                                                                                                                                                                                                       | $0.005 / call          |
| `blockrun_predexon_endpoint_call`    | Catch-all for the remaining 49 endpoints — orderbooks, candlesticks, top-holders, UMA oracle, wallet identity/cluster, Kalshi/Limitless/Opinion/Predict.Fun, dFlow, Binance Futures, cross-venue search, sports, canonical markets. Takes `path` + optional `method`/`query`/`body`. | $0.001 / $0.005 / call |

Pricing: `$0.001` per market-data call, `$0.005` per analytics / search / wallet call. See the `predexon` skill for the full endpoint reference.

### Crypto Data (Surf) — skill-only integration

Surf is a unified crypto data API with **84 endpoints across 13 domains**: CEX/DEX markets, on-chain SQL over 80+ ClickHouse tables (Ethereum, Base, Arbitrum, BSC, TRON, HyperEVM, Tempo), 100M+ labeled wallets, prediction markets (Polymarket + Kalshi), social/CT mindshare, news, project/DeFi metrics, token analytics, unified search, VC fund intelligence. The killer feature is `POST /surf/onchain/sql` — ad-hoc SELECT against the warehouse, no indexer required.

**ClawRouter ships Surf as a skill, not as typed wrappers.** The base proxy whitelists `/v1/surf/*` so any call through `http://127.0.0.1:8402/v1/surf/...` flows through the same x402 wallet that pays for LLM calls. The endpoint catalog, parameter shapes, and example flows live in the dedicated **`surf` skill** — Claude Code (or any agent) reads that skill on demand and crafts the HTTP call itself. No `blockrun_surf_*` tool definitions to maintain, no release of ClawRouter when Surf adds endpoint #85.

Pricing tiers (per call, settled in USDC directly to Surf's Base treasury): **$0.001** prices/rankings/lists/news · **$0.005** orderbooks/candles/search/wallet details/social · **$0.02** on-chain SQL/query/schema, chat completions. No monthly minimums, no Surf account, no API key. See the `surf` skill for the full endpoint reference.

This is the pattern for new BlockRun-marketplace APIs going forward: base proxy whitelists the namespace, a dedicated skill documents the surface — no hand-coded tool wrappers per endpoint.

## Example Output

```
[ClawRouter] google/gemini-2.5-flash (SIMPLE, rules, confidence=0.92)
             Cost: $0.0025 | Baseline: $0.308 | Saved: 99.2%
```
