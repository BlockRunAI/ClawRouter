![ClawRouter Banner](assets/banner.png)

<div align="center">

Route every request to the cheapest model that can handle it.
One wallet, 30+ models, zero API keys.

[![npm](https://img.shields.io/npm/v/@blockrun/clawrouter.svg)](https://npmjs.com/package/@blockrun/clawrouter)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://typescriptlang.org)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](https://nodejs.org)

[Docs](https://blockrun.ai/docs) &middot; [Models](https://blockrun.ai/models) &middot; [Configuration](docs/configuration.md) &middot; [Features](docs/features.md) &middot; [Troubleshooting](docs/troubleshooting.md) &middot; [Telegram](https://t.me/blockrunAI) &middot; [X](https://x.com/BlockRunAI)

</div>

---

```
"What is 2+2?"            → DeepSeek        $0.27/M    saved 99%
"Summarize this article"  → GPT-4o-mini     $0.60/M    saved 99%
"Build a React component" → Claude Sonnet   $15.00/M   best balance
"Prove this theorem"      → DeepSeek-R      $0.42/M    reasoning
"Run 50 parallel searches"→ Kimi K2.5       $2.40/M    agentic swarm
```

## Why ClawRouter?

- **100% local routing** — 15-dimension weighted scoring runs on your machine in <1ms
- **Zero external calls** — no API calls for routing decisions, ever
- **30+ models** — OpenAI, Anthropic, Google, DeepSeek, xAI, Moonshot through one wallet
- **x402 micropayments** — pay per request with USDC on Base, no API keys
- **Open source** — MIT licensed, fully inspectable routing logic

### Ask Your OpenClaw How ClawRouter Saves You Money

<img src="docs/clawrouter-savings.png" alt="ClawRouter savings explanation" width="600">

---

## Quick Start (2 mins)

```bash
# 1. Install with smart routing enabled by default
curl -fsSL https://raw.githubusercontent.com/BlockRunAI/ClawRouter/main/scripts/reinstall.sh | bash

# 2. Fund your wallet with USDC on Base (address printed on install)
# $5 is enough for thousands of requests

# 3. Restart OpenClaw gateway
openclaw gateway restart
```

Done! Smart routing (`blockrun/auto`) is now your default model.

### Tips

- **Use `/model blockrun/auto`** in any conversation to switch on the fly
- **Free tier?** Use `/model free` — routes to gpt-oss-120b at $0
- **Model aliases:** `/model sonnet`, `/model grok`, `/model deepseek`, `/model kimi`
- **Want a specific model?** Use `blockrun/openai/gpt-4o` or `blockrun/anthropic/claude-sonnet-4`
- **Already have a funded wallet?** `export BLOCKRUN_WALLET_KEY=0x...`

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

No external classifier calls. Ambiguous queries default to the MEDIUM tier (DeepSeek/GPT-4o-mini) — fast, cheap, and good enough for most tasks.

**Deep dive:** [15-dimension scoring weights](docs/configuration.md#scoring-weights) | [Architecture](docs/architecture.md)

### Tier → Model Mapping

| Tier      | Primary Model         | Cost/M | Savings vs Opus |
| --------- | --------------------- | ------ | --------------- |
| SIMPLE    | gemini-2.5-flash      | $0.60  | **99.2%**       |
| MEDIUM    | grok-code-fast-1      | $1.50  | **98.0%**       |
| COMPLEX   | gemini-2.5-pro        | $10.00 | **86.7%**       |
| REASONING | grok-4-fast-reasoning | $0.50  | **99.3%**       |

Special rule: 2+ reasoning markers → REASONING at 0.97 confidence.

### Advanced Features

ClawRouter v0.5+ includes intelligent features that work automatically:

- **Agentic auto-detect** — routes multi-step tasks to Kimi K2.5
- **Tool detection** — auto-switches when `tools` array present
- **Context-aware** — filters models that can't handle your context size
- **Model aliases** — `/model free`, `/model sonnet`, `/model grok`
- **Session persistence** — pins model for multi-turn conversations
- **Free tier fallback** — keeps working when wallet is empty

**Full details:** [docs/features.md](docs/features.md)

### Cost Savings

| Tier                | % of Traffic | Cost/M      |
| ------------------- | ------------ | ----------- |
| SIMPLE              | ~45%         | $0.27       |
| MEDIUM              | ~35%         | $0.60       |
| COMPLEX             | ~15%         | $15.00      |
| REASONING           | ~5%          | $10.00      |
| **Blended average** |              | **$3.17/M** |

Compared to **$75/M** for Claude Opus = **96% savings** on a typical workload.

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

### Local Backend Support (Claude CLI)

Have a Claude Pro/Max subscription? Route Anthropic models to your local Claude CLI instead of x402:

```json
{
  "plugins": {
    "entries": {
      "clawrouter": {
        "localBackends": {
          "claude": {
            "enabled": true,
            "command": "/path/to/claude",
            "args": ["--output-format", "json"]
          }
        }
      }
    }
  }
}
```

When enabled, requests to `anthropic/*`, `sonnet`, `opus`, or `haiku` models are routed to your local Claude CLI, bypassing x402 payments. Other models (GPT, Gemini, Grok, etc.) continue through ClawRouter.

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

Agents shouldn't need a human to paste API keys. They should generate a wallet, receive funds, and pay per request — programmatically.

---

## Troubleshooting

Quick checklist:

```bash
# Check version (should be 0.5.7+)
cat ~/.openclaw/extensions/clawrouter/package.json | grep version

# Check proxy running
curl http://localhost:8402/health
```

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
