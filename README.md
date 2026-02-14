![ClawRouter Banner](assets/banner.png)

<div align="center">

Route every request to the cheapest model that can handle it.
One wallet, 30+ models, zero API keys.

[![npm](https://img.shields.io/npm/v/@blockrun/clawrouter.svg)](https://npmjs.com/package/@blockrun/clawrouter)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://typescriptlang.org)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](https://nodejs.org)
[![USDC Hackathon Winner](https://img.shields.io/badge/🏆_USDC_Hackathon-Agentic_Commerce_Winner-gold)](https://x.com/USDC/status/2021625822294216977)

[Docs](https://blockrun.ai/docs) &middot; [Models](https://blockrun.ai/models) &middot; [vs OpenRouter](docs/vs-openrouter.md) &middot; [Configuration](docs/configuration.md) &middot; [Features](docs/features.md) &middot; [Troubleshooting](docs/troubleshooting.md) &middot; [Telegram](https://t.me/blockrunAI) &middot; [X](https://x.com/BlockRunAI)

**Winner — Agentic Commerce Track** at the [USDC AI Agent Hackathon](https://x.com/USDC/status/2021625822294216977)<br>
_The world's first hackathon run entirely by AI agents, powered by USDC_

</div>

---

```
"What is 2+2?"            → NVIDIA Kimi     $0.001/M   saved ~100%
"Summarize this article"  → Grok Code Fast  $1.50/M    saved 94%
"Build a React component" → Gemini 2.5 Pro  $10.00/M   best balance
"Prove this theorem"      → Grok 4.1 Fast   $0.50/M    reasoning
"Run 50 parallel searches"→ Kimi K2.5       $2.40/M    agentic swarm
```

## Why ClawRouter?

- **4 routing profiles** — auto (balanced), eco (95.9-100% savings), premium (best quality), free (zero cost)
- **100% local routing** — 15-dimension weighted scoring runs on your machine in <1ms
- **Zero external calls** — no API calls for routing decisions, ever
- **30+ models** — OpenAI, Anthropic, Google, DeepSeek, xAI, Moonshot through one wallet
- **x402 micropayments** — pay per request with USDC on Base, no API keys
- **Open source** — MIT licensed, fully inspectable routing logic

### Ask Your OpenClaw How ClawRouter Saves You Money

<img src="docs/clawrouter-savings.png" alt="ClawRouter savings explanation" width="600">

---

## Quick Start (2 mins)

**Inspired by Andreas** — we've updated our installation script:

```bash
# 1. Install with smart routing enabled by default
curl -fsSL https://blockrun.ai/ClawRouter-update | bash
openclaw gateway restart

# 2. Fund your wallet with USDC on Base (address printed on install)
# $5 is enough for thousands of requests
```

Done! Smart routing (`blockrun/auto`) is now your default model.

### Routing Profiles

Choose your routing strategy with `/model <profile>`:

| Profile          | Strategy           | Savings   | Use Case                |
| ---------------- | ------------------ | --------- | ----------------------- |
| `/model auto`    | Balanced (default) | 74-100%   | Best overall balance    |
| `/model eco`     | Cost optimized     | 95.9-100% | Maximum savings         |
| `/model premium` | Quality focused    | 0%        | Best quality (Opus 4.5) |
| `/model free`    | Free tier only     | 100%      | Zero cost               |

**Other shortcuts:**

- **Model aliases:** `/model sonnet`, `/model grok`, `/model gpt5`, `/model o3`
- **Specific models:** `blockrun/openai/gpt-4o` or `blockrun/anthropic/claude-sonnet-4`
- **Bring your wallet:** `export BLOCKRUN_WALLET_KEY=0x...`

---

## See It In Action

<div align="center">
<img src="assets/telegram-demo.png" alt="ClawRouter in action via Telegram" width="500"/>
</div>

**The flow:**

1. **Wallet auto-generated** on Base (L2) — saved securely at `~/.openclaw/blockrun/wallet.key`
2. **Fund with $1 USDC** — enough for hundreds of requests
3. **Request any model** — "help me call Grok to check @hosseeb's opinion on AI agents"
4. **ClawRouter routes it** — spawns a Grok sub-agent via `xai/grok-3`, pays per-request

No API keys. No accounts. Just fund and go.

---

## How Routing Works

**100% local, <1ms, zero API calls.**

```
Request → Weighted Scorer (15 dimensions)
              │
              ├── High confidence → Pick model from tier → Done
              │
              └── Low confidence → Default to MEDIUM tier → Done
```

No external classifier calls. Ambiguous queries default to the MEDIUM tier (Grok Code Fast) — fast, cheap, and good enough for most tasks.

**Deep dive:** [15-dimension scoring weights](docs/configuration.md#scoring-weights) | [Architecture](docs/architecture.md)

### Routing Profiles (NEW in v0.8.21)

ClawRouter now offers 4 routing profiles to match different priorities:

| Profile            | Strategy                | Savings vs Opus 4.5 | When to Use                   |
| ------------------ | ----------------------- | ------------------- | ----------------------------- |
| **auto** (default) | Balanced quality + cost | 74-100%             | General use, best overall     |
| **eco**            | Maximum cost savings    | 95.9-100%           | Budget-conscious, high volume |
| **premium**        | Best quality only       | 0%                  | Mission-critical tasks        |
| **free**           | Free tier only          | 100%                | Testing, empty wallet         |

Switch profiles anytime: `/model eco`, `/model premium`, `/model auto`

**Example:**

```
/model eco                    # Switch to cost-optimized routing
"Write a React component"     # Routes to DeepSeek ($0.28/$0.42)
                              # vs Auto → Grok ($0.20/$1.50)
                              # 98.3% savings vs Opus 4.5
```

### Tier → Model Mapping

| Tier      | Primary Model           | Cost/M | Savings vs Opus |
| --------- | ----------------------- | ------ | --------------- |
| SIMPLE    | nvidia/kimi-k2.5        | $0.001 | **~100%**       |
| MEDIUM    | grok-code-fast-1        | $1.50  | **94.0%**       |
| COMPLEX   | gemini-2.5-pro          | $10.00 | **60.0%**       |
| REASONING | grok-4-1-fast-reasoning | $0.50  | **98.0%**       |

Special rule: 2+ reasoning markers → REASONING at 0.97 confidence.

### Advanced Features

ClawRouter v0.5+ includes intelligent features that work automatically:

- **Agentic auto-detect** — routes multi-step tasks to Kimi K2.5
- **Tool detection** — auto-switches when `tools` array present
- **Context-aware** — filters models that can't handle your context size
- **Model aliases** — `/model free`, `/model sonnet`, `/model grok`
- **Session persistence** — pins model for multi-turn conversations
- **Free tier fallback** — keeps working when wallet is empty
- **Auto-update check** — notifies you when a new version is available

**Full details:** [docs/features.md](docs/features.md)

### Cost Savings

| Tier                | % of Traffic | Cost/M      |
| ------------------- | ------------ | ----------- |
| SIMPLE              | ~45%         | $0.001      |
| MEDIUM              | ~35%         | $1.50       |
| COMPLEX             | ~15%         | $10.00      |
| REASONING           | ~5%          | $0.50       |
| **Blended average** |              | **$2.05/M** |

Compared to **$25/M** for Claude Opus = **92% savings** on a typical workload.

---

## Models

30+ models across 6 providers, one wallet:

| Model                 | Input $/M | Output $/M | Context | Reasoning |
| --------------------- | --------- | ---------- | ------- | :-------: |
| **OpenAI**            |           |            |         |           |
| gpt-5.2               | $1.75     | $14.00     | 400K    |    \*     |
| gpt-4o                | $2.50     | $10.00     | 128K    |           |
| gpt-4o-mini           | $0.15     | $0.60      | 128K    |           |
| gpt-oss-120b          | **$0**    | **$0**     | 128K    |           |
| o3                    | $2.00     | $8.00      | 200K    |    \*     |
| o3-mini               | $1.10     | $4.40      | 128K    |    \*     |
| **Anthropic**         |           |            |         |           |
| claude-opus-4.5       | $5.00     | $25.00     | 200K    |    \*     |
| claude-sonnet-4       | $3.00     | $15.00     | 200K    |    \*     |
| claude-haiku-4.5      | $1.00     | $5.00      | 200K    |           |
| **Google**            |           |            |         |           |
| gemini-2.5-pro        | $1.25     | $10.00     | 1M      |    \*     |
| gemini-2.5-flash      | $0.15     | $0.60      | 1M      |           |
| **DeepSeek**          |           |            |         |           |
| deepseek-chat         | $0.14     | $0.28      | 128K    |           |
| deepseek-reasoner     | $0.55     | $2.19      | 128K    |    \*     |
| **xAI**               |           |            |         |           |
| grok-3                | $3.00     | $15.00     | 131K    |    \*     |
| grok-3-mini           | $0.30     | $0.50      | 131K    |           |
| grok-4-fast-reasoning | $0.20     | $0.50      | 131K    |    \*     |
| grok-4-fast           | $0.20     | $0.50      | 131K    |           |
| grok-code-fast-1      | $0.20     | $1.50      | 131K    |           |
| **Moonshot**          |           |            |         |           |
| kimi-k2.5             | $0.50     | $2.40      | 262K    |    \*     |

> **Free tier:** `gpt-oss-120b` costs nothing and serves as automatic fallback when wallet is empty.

Full list: [`src/models.ts`](src/models.ts)

### Kimi K2.5: Agentic Workflows

[Kimi K2.5](https://kimi.ai) from Moonshot AI is optimized for agent swarm and multi-step workflows:

- **Agent Swarm** — Coordinates up to 100 parallel agents, 4.5x faster execution
- **Extended Tool Chains** — Stable across 200-300 sequential tool calls without drift
- **Vision-to-Code** — Generates production React from UI mockups and videos
- **Cost Efficient** — 76% cheaper than Claude Opus on agentic benchmarks

Best for: parallel web research, multi-agent orchestration, long-running automation tasks.

---

## Payment

No account. No API key. **Payment IS authentication** via [x402](https://x402.org).

```
Request → 402 (price: $0.003) → wallet signs USDC → retry → response
```

USDC stays in your wallet until spent — non-custodial. Price is visible in the 402 header before signing.

**Fund your wallet:**

- Coinbase: Buy USDC, send to Base
- Bridge: Move USDC from any chain to Base
- CEX: Withdraw USDC to Base network

---

## Wallet Configuration

ClawRouter auto-generates and saves a wallet at `~/.openclaw/blockrun/wallet.key`.

```bash
# Check wallet status
/wallet

# Use your own wallet
export BLOCKRUN_WALLET_KEY=0x...
```

**Full reference:** [Wallet configuration](docs/configuration.md#wallet-configuration) | [Backup & recovery](docs/configuration.md#wallet-backup--recovery)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Your Application                         │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   ClawRouter (localhost)                     │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐ │
│  │ Weighted Scorer │→ │ Model Selector  │→ │ x402 Signer │ │
│  │  (15 dimensions)│  │ (cheapest tier) │  │   (USDC)    │ │
│  └─────────────────┘  └─────────────────┘  └─────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      BlockRun API                            │
│    → OpenAI | Anthropic | Google | DeepSeek | xAI | Moonshot│
└─────────────────────────────────────────────────────────────┘
```

Routing is **client-side** — open source and inspectable.

**Deep dive:** [docs/architecture.md](docs/architecture.md) — request flow, payment system, optimizations

---

## Configuration

For basic usage, no configuration needed. For advanced options:

| Setting               | Default | Description           |
| --------------------- | ------- | --------------------- |
| `CLAWROUTER_DISABLED` | `false` | Disable smart routing |
| `BLOCKRUN_PROXY_PORT` | `8402`  | Proxy port            |
| `BLOCKRUN_WALLET_KEY` | auto    | Wallet private key    |

**Full reference:** [docs/configuration.md](docs/configuration.md)

---

## Programmatic Usage

Use ClawRouter directly in your code:

```typescript
import { startProxy, route } from "@blockrun/clawrouter";

// Start proxy server
const proxy = await startProxy({ walletKey: "0x..." });

// Or use router directly (no proxy)
const decision = route("Prove sqrt(2) is irrational", ...);
```

**Full examples:** [docs/configuration.md#programmatic-usage](docs/configuration.md#programmatic-usage)

---

## Performance Optimizations (v0.3)

- **SSE heartbeat**: Sends headers + heartbeat immediately, preventing upstream timeouts
- **Response dedup**: SHA-256 hash → 30s cache, prevents double-charge on retries
- **Payment pre-auth**: Caches 402 params, pre-signs USDC, skips 402 round trip (~200ms saved)

---

## Cost Tracking

Track your savings with `/stats` in any OpenClaw conversation.

**Full details:** [docs/features.md#cost-tracking-with-stats](docs/features.md#cost-tracking-with-stats)

---

## Why Not OpenRouter / LiteLLM?

They're built for developers. ClawRouter is built for **agents**.

|             | OpenRouter / LiteLLM        | ClawRouter                       |
| ----------- | --------------------------- | -------------------------------- |
| **Setup**   | Human creates account       | Agent generates wallet           |
| **Auth**    | API key (shared secret)     | Wallet signature (cryptographic) |
| **Payment** | Prepaid balance (custodial) | Per-request (non-custodial)      |
| **Routing** | Proprietary / closed        | Open source, client-side         |
| **Rate limits** | Per-key quotas          | None (your wallet, your limits)  |
| **Cost**    | $25/M (Opus equivalent)     | $2.05/M blended average          |

Agents shouldn't need a human to paste API keys. They should generate a wallet, receive funds, and pay per request — programmatically.

### Real Problems with OpenRouter

Based on [50+ OpenClaw issues](https://github.com/openclaw/openclaw/issues?q=openrouter):

| Issue | Problem | ClawRouter |
|-------|---------|------------|
| [#11202](https://github.com/openclaw/openclaw/issues/11202) | API keys leaked in every LLM prompt | No API keys to leak |
| [#2373](https://github.com/openclaw/openclaw/issues/2373) | `openrouter/auto` path broken | `blockrun/auto` just works |
| [#8615](https://github.com/openclaw/openclaw/issues/8615) | Single API key rate limit hell | Non-custodial, no limits |
| [#2963](https://github.com/openclaw/openclaw/issues/2963) | Tool calling fails silently | Full tool support |
| [#10687](https://github.com/openclaw/openclaw/issues/10687) | "Unknown model" errors | 30+ models, auto-update |

**[Full comparison →](docs/vs-openrouter.md)**

---

## Troubleshooting

Quick checklist:

```bash
# Check version (should be 0.8.21+)
cat ~/.openclaw/extensions/clawrouter/package.json | grep version

# Check proxy running
curl http://localhost:8402/health

# Update to latest version
curl -fsSL https://blockrun.ai/ClawRouter-update | bash
openclaw gateway restart
```

ClawRouter automatically checks for updates on startup and shows a notification if a newer version is available.

**Full guide:** [docs/troubleshooting.md](docs/troubleshooting.md)

---

## Development

```bash
git clone https://github.com/BlockRunAI/ClawRouter.git
cd ClawRouter
npm install
npm run build
npm run typecheck

# End-to-end tests (requires funded wallet)
BLOCKRUN_WALLET_KEY=0x... npx tsx test-e2e.ts
```

---

## Uninstall

```bash
openclaw plugins uninstall clawrouter
openclaw gateway restart
```

Your wallet key remains at `~/.openclaw/blockrun/wallet.key` — back it up before deleting if you have funds.

---

## Roadmap

- [x] Smart routing — 15-dimension weighted scoring, 4-tier model selection
- [x] x402 payments — per-request USDC micropayments, non-custodial
- [x] Response dedup — prevents double-charge on retries
- [x] Payment pre-auth — skips 402 round trip
- [x] SSE heartbeat — prevents upstream timeouts
- [x] Agentic auto-detect — auto-switch to agentic models for multi-step tasks
- [x] Tool detection — auto-switch to agentic mode when tools array present
- [x] Context-aware routing — filter out models that can't handle context size
- [x] Session persistence — pin model for multi-turn conversations
- [x] Cost tracking — /stats command with savings dashboard
- [x] Model aliases — `/model free`, `/model sonnet`, `/model grok`, etc.
- [x] Free tier — gpt-oss-120b for $0 when wallet is empty
- [x] Auto-update — startup version check with one-command update
- [ ] Cascade routing — try cheap model first, escalate on low quality
- [ ] Spend controls — daily/monthly budgets
- [ ] Remote analytics — cost tracking at blockrun.ai

---

## License

MIT

---

<div align="center">

**[BlockRun](https://blockrun.ai)** — Pay-per-request AI infrastructure

If ClawRouter saves you money, consider starring the repo.

</div>
