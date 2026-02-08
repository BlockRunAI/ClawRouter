<div align="center">

# ClawRouter

**Save 78% on LLM costs. Automatically.**

Route every request to the cheapest model that can handle it.
One wallet, 30+ models, zero API keys.

[![npm](https://img.shields.io/npm/v/@blockrun/clawrouter.svg)](https://npmjs.com/package/@blockrun/clawrouter)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://typescriptlang.org)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](https://nodejs.org)

[Docs](https://blockrun.ai/docs) &middot; [Models](https://blockrun.ai/models) &middot; [Configuration](docs/configuration.md) &middot; [Architecture](docs/architecture.md) &middot; [Telegram](https://t.me/blockrunAI) &middot; [X](https://x.com/BlockRunAI)

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

- **100% local routing** — 14-dimension weighted scoring runs on your machine in <1ms
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
Request → Weighted Scorer (14 dimensions)
              │
              ├── High confidence → Pick model from tier → Done
              │
              └── Low confidence → Default to MEDIUM tier → Done
```

No external classifier calls. Ambiguous queries default to the MEDIUM tier (DeepSeek/GPT-4o-mini) — fast, cheap, and good enough for most tasks.

### 14-Dimension Weighted Scoring

| Dimension            | Weight | What It Detects                          |
| -------------------- | ------ | ---------------------------------------- |
| Reasoning markers    | 0.18   | "prove", "theorem", "step by step"       |
| Code presence        | 0.15   | "function", "async", "import", "```"     |
| Simple indicators    | 0.12   | "what is", "define", "translate"         |
| Multi-step patterns  | 0.12   | "first...then", "step 1", numbered lists |
| Technical terms      | 0.10   | "algorithm", "kubernetes", "distributed" |
| Token count          | 0.08   | short (<50) vs long (>500) prompts       |
| Creative markers     | 0.05   | "story", "poem", "brainstorm"            |
| Question complexity  | 0.05   | Multiple question marks                  |
| Constraint count     | 0.04   | "at most", "O(n)", "maximum"             |
| Imperative verbs     | 0.03   | "build", "create", "implement"           |
| Output format        | 0.03   | "json", "yaml", "schema"                 |
| Domain specificity   | 0.02   | "quantum", "fpga", "genomics"            |
| Reference complexity | 0.02   | "the docs", "the api", "above"           |
| Negation complexity  | 0.01   | "don't", "avoid", "without"              |

Weighted sum → sigmoid confidence calibration → tier selection.

### Supported Languages

ClawRouter's keyword-based routing works with prompts in:

| Language              | Script       | Examples                       |
| --------------------- | ------------ | ------------------------------ |
| **English**           | Latin        | Full support (default)         |
| **Chinese (中文)**    | Han/CJK      | 证明, 定理, 你好, 什么是       |
| **Japanese (日本語)** | Kanji + Kana | 証明, こんにちは, アルゴリズム |
| **Russian (Русский)** | Cyrillic     | доказать, привет, алгоритм     |

Mixed-language prompts are supported — keywords from all languages are checked simultaneously.

### Tier → Model Mapping

| Tier      | Primary Model     | Cost/M | Savings vs Opus |
| --------- | ----------------- | ------ | --------------- |
| SIMPLE    | gemini-2.5-flash  | $0.60  | **99.2%**       |
| MEDIUM    | deepseek-chat     | $0.42  | **99.4%**       |
| COMPLEX   | claude-opus-4     | $75.00 | baseline        |
| REASONING | deepseek-reasoner | $0.42  | **99.4%**       |

Special rule: 2+ reasoning markers → REASONING at 0.97 confidence.

### Cost Savings (Real Numbers)

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

| Model             | Input $/M | Output $/M | Context | Reasoning |
| ----------------- | --------- | ---------- | ------- | :-------: |
| **OpenAI**        |           |            |         |           |
| gpt-5.2           | $1.75     | $14.00     | 400K    |    \*     |
| gpt-4o            | $2.50     | $10.00     | 128K    |           |
| gpt-4o-mini       | $0.15     | $0.60      | 128K    |           |
| o3                | $2.00     | $8.00      | 200K    |    \*     |
| o3-mini           | $1.10     | $4.40      | 128K    |    \*     |
| **Anthropic**     |           |            |         |           |
| claude-opus-4.5   | $5.00     | $25.00     | 200K    |    \*     |
| claude-sonnet-4   | $3.00     | $15.00     | 200K    |    \*     |
| claude-haiku-4.5  | $1.00     | $5.00      | 200K    |           |
| **Google**        |           |            |         |           |
| gemini-2.5-pro    | $1.25     | $10.00     | 1M      |    \*     |
| gemini-2.5-flash  | $0.15     | $0.60      | 1M      |           |
| **DeepSeek**      |           |            |         |           |
| deepseek-chat     | $0.14     | $0.28      | 128K    |           |
| deepseek-reasoner | $0.55     | $2.19      | 128K    |    \*     |
| **xAI**           |           |            |         |           |
| grok-3            | $3.00     | $15.00     | 131K    |    \*     |
| grok-3-mini       | $0.30     | $0.50      | 131K    |           |
| **Moonshot**      |           |            |         |           |
| kimi-k2.5         | $0.50     | $2.40      | 128K    |    \*     |

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

ClawRouter uses one environment variable: `BLOCKRUN_WALLET_KEY`

### Resolution Order

| Priority | Source                                         | Behavior                          |
| -------- | ---------------------------------------------- | --------------------------------- |
| 1st      | Saved file (`~/.openclaw/blockrun/wallet.key`) | Used if exists                    |
| 2nd      | `BLOCKRUN_WALLET_KEY` env var                  | Used if no saved file             |
| 3rd      | Auto-generate                                  | Creates new wallet, saves to file |

**Important:** The saved file takes priority over the environment variable. If you have both, the env var is ignored.

### Common Scenarios

```bash
# Check if a saved wallet exists
ls -la ~/.openclaw/blockrun/wallet.key

# Use your own wallet (only works if no saved file exists)
export BLOCKRUN_WALLET_KEY=0x...

# Force use of a different wallet
rm ~/.openclaw/blockrun/wallet.key
export BLOCKRUN_WALLET_KEY=0x...
openclaw restart

# See which wallet is active
curl http://localhost:8402/health | jq .wallet
```

### Why This Order?

The saved file is checked first to ensure wallet persistence across sessions. Once a wallet is generated and funded, you don't want an accidentally-set env var to switch wallets and leave your funds inaccessible.

If you explicitly want to use a different wallet:

1. Delete `~/.openclaw/blockrun/wallet.key`
2. Set `BLOCKRUN_WALLET_KEY=0x...`
3. Restart OpenClaw

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
│  │  (14 dimensions)│  │ (cheapest tier) │  │   (USDC)    │ │
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

For basic usage, no configuration is needed. For advanced options:

| Setting               | Default  | Description                  |
| --------------------- | -------- | ---------------------------- |
| `BLOCKRUN_PROXY_PORT` | `8402`   | Proxy port (env var)         |
| `BLOCKRUN_WALLET_KEY` | auto     | Wallet private key (env var) |
| `routing.tiers`       | see docs | Override tier→model mappings |
| `routing.scoring`     | see docs | Custom keyword weights       |

**Quick example:**

```bash
# Use different port
export BLOCKRUN_PROXY_PORT=8403
openclaw gateway restart
```

```yaml
# openclaw.yaml — override models
plugins:
  - id: "@blockrun/clawrouter"
    config:
      routing:
        tiers:
          COMPLEX:
            primary: "openai/gpt-4o"
```

**Full reference:** [docs/configuration.md](docs/configuration.md)

---

## Programmatic Usage

Use without OpenClaw:

```typescript
import { startProxy } from "@blockrun/clawrouter";

const proxy = await startProxy({
  walletKey: process.env.BLOCKRUN_WALLET_KEY!,
  onReady: (port) => console.log(`Proxy on port ${port}`),
  onRouted: (d) => console.log(`${d.model} saved ${(d.savings * 100).toFixed(0)}%`),
});

// Any OpenAI-compatible client works
const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "blockrun/auto",
    messages: [{ role: "user", content: "What is 2+2?" }],
  }),
});

await proxy.close();
```

Or use the router directly:

```typescript
import { route, DEFAULT_ROUTING_CONFIG, BLOCKRUN_MODELS } from "@blockrun/clawrouter";

// Build pricing map
const modelPricing = new Map();
for (const m of BLOCKRUN_MODELS) {
  modelPricing.set(m.id, { inputPrice: m.inputPrice, outputPrice: m.outputPrice });
}

const decision = route("Prove sqrt(2) is irrational", undefined, 4096, {
  config: DEFAULT_ROUTING_CONFIG,
  modelPricing,
});

console.log(decision);
// {
//   model: "deepseek/deepseek-reasoner",
//   tier: "REASONING",
//   confidence: 0.97,
//   method: "rules",
//   savings: 0.994,
//   costEstimate: 0.002,
// }
```

---

## Performance Optimizations (v0.3)

- **SSE heartbeat**: Sends headers + heartbeat immediately, preventing upstream timeouts
- **Response dedup**: SHA-256 hash → 30s cache, prevents double-charge on retries
- **Payment pre-auth**: Caches 402 params, pre-signs USDC, skips 402 round trip (~200ms saved)

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

> 💬 **Need help?** [Open a Discussion](https://github.com/BlockRunAI/ClawRouter/discussions) or check [existing issues](https://github.com/BlockRunAI/ClawRouter/issues).

### Quick Checklist

```bash
# 1. Check your version (should be 0.3.21+)
cat ~/.openclaw/extensions/clawrouter/package.json | grep version

# 2. Check proxy is running
curl http://localhost:8402/health

# 3. Watch routing in action
openclaw logs --follow
# Should see: gemini-2.5-flash $0.0012 (saved 99%)
```

### "Unknown model: blockrun/auto" or "Unknown model: auto"

Plugin isn't loaded or outdated. **Don't change the model name** — `blockrun/auto` is correct.

**Fix:** Update to v0.3.21+ which handles both `blockrun/auto` and `auto` (OpenClaw strips provider prefix). See [How to Update ClawRouter](#how-to-update-clawrouter).

### "No API key found for provider blockrun"

Auth profile is missing or wasn't created properly.

**Fix:** See [How to Update ClawRouter](#how-to-update-clawrouter) — the reinstall script automatically injects the auth profile.

### "Config validation failed: plugin not found: clawrouter"

Plugin directory was removed but config still references it. This blocks all OpenClaw commands until fixed.

**Fix:** See [How to Update ClawRouter](#how-to-update-clawrouter) for complete cleanup steps.

### "No USDC balance" / "Insufficient funds"

Wallet needs funding.

**Fix:**

1. Find your wallet address (printed during install)
2. Send USDC on **Base network** to that address
3. $1-5 is enough for hundreds of requests
4. Restart OpenClaw

### Security Scanner Warning: "env-harvesting"

OpenClaw's security scanner may flag ClawRouter with:

```
[env-harvesting] Environment variable access combined with network send
```

**This is a false positive.** ClawRouter reads `BLOCKRUN_WALLET_KEY` to sign x402 payment transactions — this is required and intentional:

- The wallet key is used **locally** for cryptographic signing (EIP-712)
- The **signature** is transmitted, not the private key itself
- This is standard x402 payment protocol behavior
- Source code is [MIT licensed and fully auditable](https://github.com/BlockRunAI/ClawRouter)

See [`openclaw.security.json`](openclaw.security.json) for detailed security documentation.

### Port 8402 already in use

As of v0.4.1, ClawRouter automatically detects and reuses an existing proxy on the configured port instead of failing with `EADDRINUSE`. You should no longer see this error.

If you need to use a different port:

```bash
# Set custom port via environment variable
export BLOCKRUN_PROXY_PORT=8403
openclaw gateway restart
```

To manually check/kill the process:

```bash
lsof -i :8402
# Kill the process or restart OpenClaw
```

### How to Update ClawRouter

```bash
curl -fsSL https://raw.githubusercontent.com/BlockRunAI/ClawRouter/main/scripts/reinstall.sh | bash
openclaw gateway restart
```

This removes the old version, installs the latest, and restarts the gateway.

### Verify Routing is Working

```bash
openclaw logs --follow
```

You should see model selection for each request:

```
[plugins] [SIMPLE] google/gemini-2.5-flash $0.0012 (saved 99%)
[plugins] [MEDIUM] deepseek/deepseek-chat $0.0003 (saved 99%)
[plugins] [REASONING] deepseek/deepseek-reasoner $0.0005 (saved 99%)
```

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

- [x] Smart routing — 14-dimension weighted scoring, 4-tier model selection
- [x] x402 payments — per-request USDC micropayments, non-custodial
- [x] Response dedup — prevents double-charge on retries
- [x] Payment pre-auth — skips 402 round trip
- [x] SSE heartbeat — prevents upstream timeouts
- [ ] Cascade routing — try cheap model first, escalate on low quality
- [ ] Spend controls — daily/monthly budgets
- [ ] Analytics dashboard — cost tracking at blockrun.ai

---

## License

MIT

---

<div align="center">

**[BlockRun](https://blockrun.ai)** — Pay-per-request AI infrastructure

If ClawRouter saves you money, consider starring the repo.

</div>
