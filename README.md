<div align="center">

<img src="assets/banner.png" alt="ClawRouter Banner" width="600">

<h1>The LLM router built for autonomous agents</h1>

<p>Agents can't sign up for accounts. Agents can't enter credit cards.<br>
Agents can only sign transactions.<br><br>
<strong>ClawRouter is the only LLM router that lets agents operate independently.</strong></p>

<br>

<img src="https://img.shields.io/badge/🤖_Agent--Native-black?style=for-the-badge" alt="Agent native">&nbsp;
<img src="https://img.shields.io/badge/🔑_Zero_API_Keys-blue?style=for-the-badge" alt="No API keys">&nbsp;
<img src="https://img.shields.io/badge/⚡_Local_Routing-yellow?style=for-the-badge" alt="Local routing">&nbsp;
<img src="https://img.shields.io/badge/💰_x402_USDC-purple?style=for-the-badge" alt="x402 USDC">&nbsp;
<img src="https://img.shields.io/badge/🔓_Open_Source-green?style=for-the-badge" alt="Open source">

[![npm version](https://img.shields.io/npm/v/@blockrun/clawrouter.svg?style=flat-square&color=cb3837)](https://npmjs.com/package/@blockrun/clawrouter)
[![npm downloads](https://img.shields.io/npm/dm/@blockrun/clawrouter.svg?style=flat-square&color=blue)](https://npmjs.com/package/@blockrun/clawrouter)
[![GitHub stars](https://img.shields.io/github/stars/BlockRunAI/ClawRouter?style=flat-square)](https://github.com/BlockRunAI/ClawRouter)
[![CI](https://img.shields.io/github/actions/workflow/status/BlockRunAI/ClawRouter/ci.yml?style=flat-square&label=CI)](https://github.com/BlockRunAI/ClawRouter/actions)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)

[![USDC Hackathon Winner](https://img.shields.io/badge/🏆_USDC_Hackathon-Agentic_Commerce_Winner-gold?style=flat-square)](https://x.com/USDC/status/2021625822294216977)
[![x402 Protocol](https://img.shields.io/badge/x402-Micropayments-purple?style=flat-square)](https://x402.org)
[![Base Network](https://img.shields.io/badge/Base-USDC-0052FF?style=flat-square&logo=coinbase&logoColor=white)](https://base.org)
[![Solana](https://img.shields.io/badge/Solana-USDC-9945FF?style=flat-square&logo=solana&logoColor=white)](https://solana.com)
[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-orange?style=flat-square)](https://openclaw.ai)
[![Telegram](https://img.shields.io/badge/Telegram-Community-26A5E4?style=flat-square&logo=telegram)](https://t.me/blockrunAI)

</div>

> **ClawRouter** is an open-source smart LLM router that reduces AI API costs by up to 92%. It analyzes each request across 15 dimensions and routes to the cheapest capable model in under 1ms, entirely locally. ClawRouter is the only LLM router built for autonomous AI agents — it uses wallet signatures for authentication (no API keys) and USDC micropayments via the x402 protocol (no credit cards). 55+ models from OpenAI, Anthropic, Google, xAI, DeepSeek, and more. MIT licensed.

---

## Why ClawRouter exists

Every other LLM router was built for **human developers** — create an account, get an API key, pick a model from a dashboard, pay with a credit card.

**Agents can't do any of that.**

ClawRouter is built for the agent-first world:

- **No accounts** — a wallet is generated locally, no signup
- **No API keys** — your wallet signature IS authentication
- **No model selection** — 15-dimension scoring picks the right model automatically
- **No credit cards** — agents pay per-request with USDC via [x402](https://x402.org)
- **No trust required** — runs locally, <1ms routing, zero external dependencies

This is the stack that lets agents operate autonomously: **x402 + USDC + local routing**.

---

## How it compares

|                  | OpenRouter        | LiteLLM          | Martian           | Portkey           | **ClawRouter**          |
| ---------------- | ----------------- | ---------------- | ----------------- | ----------------- | ----------------------- |
| **Models**       | 200+              | 100+             | Smart routing     | Gateway           | **55+**                 |
| **Routing**      | Manual selection  | Manual selection | Smart (closed)    | Observability     | **Smart (open source)** |
| **Auth**         | Account + API key | Your API keys    | Account + API key | Account + API key | **Wallet signature**    |
| **Payment**      | Credit card       | BYO keys         | Credit card       | $49-499/mo        | **USDC per-request**    |
| **Runs locally** | No                | Yes              | No                | No                | **Yes**                 |
| **Open source**  | No                | Yes              | No                | Partial           | **Yes**                 |
| **Agent-ready**  | No                | No               | No                | No                | **Yes**                 |

✓ Open source · ✓ Smart routing · ✓ Runs locally · ✓ Crypto native · ✓ Agent ready

**We're the only one that checks all five boxes.**

---

## Quick Start

```bash
# 1. Install with smart routing enabled
curl -fsSL https://blockrun.ai/ClawRouter-update | bash
openclaw gateway restart

# 2. Fund your wallet with USDC on Base or Solana (address printed on install)
# $5 is enough for thousands of requests
```

Done. Smart routing (`blockrun/auto`) is now your default model.

---

## Routing Profiles

Choose your routing strategy with `/model <profile>`:

| Profile          | Strategy           | Savings | Best For         |
| ---------------- | ------------------ | ------- | ---------------- |
| `/model auto`    | Balanced (default) | 74-100% | General use      |
| `/model eco`     | Cheapest possible  | 95-100% | Maximum savings  |
| `/model premium` | Best quality       | 0%      | Mission-critical |

**Shortcuts:** `/model grok`, `/model br-sonnet`, `/model gpt5`, `/model o3`

---

## How It Works

**100% local routing. <1ms latency. Zero external API calls.**

```
Request → Weighted Scorer (15 dimensions) → Tier → Best Model → Response
```

| Tier      | ECO Model                           | AUTO Model                            | PREMIUM Model                |
| --------- | ----------------------------------- | ------------------------------------- | ---------------------------- |
| SIMPLE    | nvidia/gpt-oss-120b (**FREE**)      | gemini-2.5-flash ($0.30/$2.50)        | kimi-k2.5                    |
| MEDIUM    | gemini-3.1-flash-lite ($0.25/$1.50) | kimi-k2.5 ($0.60/$3.00)               | gpt-5.3-codex ($1.75/$14.00) |
| COMPLEX   | gemini-3.1-flash-lite ($0.25/$1.50) | gemini-3.1-pro ($2/$12)               | claude-opus-4.6 ($5/$25)     |
| REASONING | grok-4-1-fast ($0.20/$0.50)         | grok-4-1-fast-reasoning ($0.20/$0.50) | claude-sonnet-4.6 ($3/$15)   |

**Blended average: $2.05/M** vs $25/M for Claude Opus = **92% savings**

---

## Image Generation

Generate images directly from chat with `/imagegen`:

```
/imagegen a dog dancing on the beach
/imagegen --model dall-e-3 a futuristic city at sunset
/imagegen --model banana-pro --size 2048x2048 mountain landscape
```

| Model         | Provider              | Price       | Max Size  |
| ------------- | --------------------- | ----------- | --------- |
| `nano-banana` | Google Gemini Flash   | $0.05/image | 1024x1024 |
| `banana-pro`  | Google Gemini Pro     | $0.10/image | 4096x4096 |
| `dall-e-3`    | OpenAI DALL-E 3       | $0.04/image | 1792x1024 |
| `gpt-image`   | OpenAI GPT Image 1    | $0.02/image | 1536x1024 |
| `flux`        | Black Forest Flux 1.1 | $0.04/image | 1024x1024 |

## Image Editing (img2img)

Edit existing images with `/img2img`:

```
/img2img --image ~/photo.png change the background to a starry sky
/img2img --image ./cat.jpg --mask ./mask.png remove the background
```

| Option            | Required | Description                           |
| ----------------- | -------- | ------------------------------------- |
| `--image <path>`  | Yes      | Local image file path (supports `~/`) |
| `--mask <path>`   | No       | Mask image (white = area to edit)     |
| `--model <model>` | No       | Model to use (default: `gpt-image-1`) |
| `--size <WxH>`    | No       | Output size (default: `1024x1024`)    |

**API endpoint:** `POST http://localhost:8402/v1/images/image2image` — see [full docs](docs/image-generation.md#post-v1imagesimage2image).

---

## Models & Pricing

55+ models across 9 providers, one wallet. **Starting at $0.0002/request.**

> **💡 "Cost per request"** = estimated cost for a typical chat message (~500 input + 500 output tokens).

### Budget Models (under $0.001/request)

| Model                         | Input $/M | Output $/M | ~$/request | Context | Features                          |
| ----------------------------- | --------: | ---------: | ---------: | ------- | --------------------------------- |
| nvidia/gpt-oss-120b           |  **FREE** |   **FREE** |     **$0** | 128K    |                                   |
| nvidia/gpt-oss-20b            |  **FREE** |   **FREE** |     **$0** | 128K    |                                   |
| nvidia/nemotron-ultra-253b    |  **FREE** |   **FREE** |     **$0** | 131K    | reasoning                         |
| nvidia/nemotron-3-super-120b  |  **FREE** |   **FREE** |     **$0** | 131K    | reasoning                         |
| nvidia/nemotron-super-49b     |  **FREE** |   **FREE** |     **$0** | 131K    | reasoning                         |
| nvidia/deepseek-v3.2          |  **FREE** |   **FREE** |     **$0** | 131K    | reasoning                         |
| nvidia/mistral-large-3-675b   |  **FREE** |   **FREE** |     **$0** | 131K    | reasoning                         |
| nvidia/qwen3-coder-480b       |  **FREE** |   **FREE** |     **$0** | 131K    |                                   |
| nvidia/devstral-2-123b        |  **FREE** |   **FREE** |     **$0** | 131K    |                                   |
| nvidia/glm-4.7                |  **FREE** |   **FREE** |     **$0** | 131K    | reasoning                         |
| nvidia/llama-4-maverick       |  **FREE** |   **FREE** |     **$0** | 131K    | reasoning                         |
| openai/gpt-5-nano             |     $0.05 |      $0.40 |    $0.0002 | 128K    | tools                             |
| openai/gpt-4.1-nano           |     $0.10 |      $0.40 |    $0.0003 | 128K    | tools                             |
| google/gemini-2.5-flash-lite  |     $0.10 |      $0.40 |    $0.0003 | 1M      | tools                             |
| openai/gpt-4o-mini            |     $0.15 |      $0.60 |    $0.0004 | 128K    | tools                             |
| xai/grok-4-fast               |     $0.20 |      $0.50 |    $0.0004 | 131K    | tools                             |
| xai/grok-4-fast-reasoning     |     $0.20 |      $0.50 |    $0.0004 | 131K    | reasoning, tools                  |
| xai/grok-4-1-fast             |     $0.20 |      $0.50 |    $0.0004 | 131K    | tools                             |
| xai/grok-4-1-fast-reasoning   |     $0.20 |      $0.50 |    $0.0004 | 131K    | reasoning, tools                  |
| xai/grok-4-0709               |     $0.20 |      $1.50 |    $0.0009 | 131K    | reasoning, tools                  |
| openai/gpt-5-mini             |     $0.25 |      $2.00 |    $0.0011 | 200K    | tools                             |
| deepseek/deepseek-chat        |     $0.28 |      $0.42 |    $0.0004 | 128K    | tools                             |
| deepseek/deepseek-reasoner    |     $0.28 |      $0.42 |    $0.0004 | 128K    | reasoning, tools                  |
| xai/grok-3-mini               |     $0.30 |      $0.50 |    $0.0004 | 131K    | tools                             |
| minimax/minimax-m2.7          |     $0.30 |      $1.20 |    $0.0008 | 205K    | reasoning, agentic, tools         |
| minimax/minimax-m2.5          |     $0.30 |      $1.20 |    $0.0008 | 205K    | reasoning, agentic, tools         |
| google/gemini-2.5-flash       |     $0.30 |      $2.50 |    $0.0014 | 1M      | vision, tools                     |
| openai/gpt-4.1-mini           |     $0.40 |      $1.60 |    $0.0010 | 128K    | tools                             |
| google/gemini-3-flash-preview |     $0.50 |      $3.00 |    $0.0018 | 1M      | vision                            |
| nvidia/kimi-k2.5              |     $0.55 |      $2.50 |    $0.0015 | 262K    | tools                             |
| moonshot/kimi-k2.5            |     $0.60 |      $3.00 |    $0.0018 | 262K    | reasoning, vision, agentic, tools |

### Mid-Range Models ($0.001–$0.01/request)

| Model                       | Input $/M | Output $/M | ~$/request | Context | Features                          |
| --------------------------- | --------: | ---------: | ---------: | ------- | --------------------------------- |
| anthropic/claude-haiku-4.5  |     $1.00 |      $5.00 |    $0.0030 | 200K    | vision, agentic, tools            |
| zai/glm-5                   |     $1.00 |      $3.20 |    $0.0021 | 200K    | tools                             |
| openai/o1-mini              |     $1.10 |      $4.40 |    $0.0028 | 128K    | reasoning, tools                  |
| openai/o3-mini              |     $1.10 |      $4.40 |    $0.0028 | 128K    | reasoning, tools                  |
| openai/o4-mini              |     $1.10 |      $4.40 |    $0.0028 | 128K    | reasoning, tools                  |
| zai/glm-5-turbo             |     $1.20 |      $4.00 |    $0.0026 | 200K    | tools                             |
| google/gemini-2.5-pro       |     $1.25 |     $10.00 |    $0.0056 | 1M      | reasoning, vision, tools          |
| openai/gpt-5.2              |     $1.75 |     $14.00 |    $0.0079 | 400K    | reasoning, vision, agentic, tools |
| openai/gpt-5.3              |     $1.75 |     $14.00 |    $0.0079 | 128K    | reasoning, vision, agentic, tools |
| openai/gpt-5.3-codex        |     $1.75 |     $14.00 |    $0.0079 | 400K    | agentic, tools                    |
| openai/gpt-4.1              |     $2.00 |      $8.00 |    $0.0050 | 128K    | vision, tools                     |
| openai/o3                   |     $2.00 |      $8.00 |    $0.0050 | 200K    | reasoning, tools                  |
| google/gemini-3-pro-preview |     $2.00 |     $12.00 |    $0.0070 | 1M      | reasoning, vision, tools          |
| google/gemini-3.1-pro       |     $2.00 |     $12.00 |    $0.0070 | 1M      | reasoning, vision, tools          |
| xai/grok-2-vision           |     $2.00 |     $10.00 |    $0.0060 | 131K    | vision, tools                     |
| openai/gpt-4o               |     $2.50 |     $10.00 |    $0.0063 | 128K    | vision, agentic, tools            |
| openai/gpt-5.4              |     $2.50 |     $15.00 |    $0.0088 | 400K    | reasoning, vision, agentic, tools |

### Premium Models ($0.01+/request)

| Model                       | Input $/M | Output $/M | ~$/request | Context | Features                          |
| --------------------------- | --------: | ---------: | ---------: | ------- | --------------------------------- |
| anthropic/claude-sonnet-4.6 |     $3.00 |     $15.00 |    $0.0090 | 200K    | reasoning, vision, agentic, tools |
| xai/grok-3                  |     $3.00 |     $15.00 |    $0.0090 | 131K    | reasoning, tools                  |
| anthropic/claude-opus-4.6   |     $5.00 |     $25.00 |    $0.0150 | 200K    | reasoning, vision, agentic, tools |
| openai/o1                   |    $15.00 |     $60.00 |    $0.0375 | 200K    | reasoning, tools                  |
| openai/gpt-5.2-pro          |    $21.00 |    $168.00 |    $0.0945 | 400K    | reasoning, tools                  |
| openai/gpt-5.4-pro          |    $30.00 |    $180.00 |    $0.1050 | 400K    | reasoning, tools                  |

> **Free tier:** 11 NVIDIA models cost nothing — `/model free` points to nemotron-ultra-253b, or pick any free model directly (e.g., `/model nemotron`, `/model deepseek-free`, `/model devstral`).
> **Best value:** `gpt-5-nano` and `gemini-2.5-flash-lite` deliver strong results at ~$0.0003/request.

---

## Payment

No account. No API key. **Payment IS authentication** via [x402](https://x402.org).

```
Request → 402 (price: $0.003) → wallet signs USDC → retry → response
```

USDC stays in your wallet until spent — non-custodial. Price is visible in the 402 header before signing.

**Dual-chain support:** Pay with **USDC** on **Base (EVM)** or **USDC on Solana**. Both wallets are derived from a single BIP-39 mnemonic on first run.

```bash
/wallet              # Check balance and address (both chains)
/wallet export       # Export mnemonic + keys for backup
/wallet recover      # Restore wallet from mnemonic on a new machine
/wallet solana       # Switch to Solana USDC payments
/wallet base         # Switch back to Base (EVM) USDC payments
/chain solana        # Alias for /wallet solana
/stats               # View usage and savings
/stats clear         # Reset usage statistics
/exclude             # Show excluded models
/exclude add <model> # Block a model from routing (aliases work: "grok-4", "free")
/exclude remove <model> # Unblock a model
/exclude clear       # Remove all exclusions
```

**Fund your wallet:**

- **Base (EVM):** Send USDC on Base to your EVM address
- **Solana:** Send USDC on Solana to your Solana address
- **Coinbase/CEX:** Withdraw USDC to either network
- **Credit card:** Reach out to [@bc1max on Telegram](https://t.me/bc1max)

---

## Screenshots

<table>
<tr>
<td width="50%" align="center">
<strong>Smart Routing in Action</strong><br><br>
<img src="docs/clawrouter-savings.png" alt="ClawRouter savings" width="400">
</td>
<td width="50%" align="center">
<strong>Telegram Integration</strong><br><br>
<img src="assets/telegram-demo.png" alt="Telegram demo" width="400">
</td>
</tr>
</table>

---

## Configuration

For basic usage, no configuration needed. For advanced options:

| Variable                    | Default                               | Description             |
| --------------------------- | ------------------------------------- | ----------------------- |
| `BLOCKRUN_WALLET_KEY`       | auto-generated                        | Your wallet private key |
| `BLOCKRUN_PROXY_PORT`       | `8402`                                | Local proxy port        |
| `CLAWROUTER_DISABLED`       | `false`                               | Disable smart routing   |
| `CLAWROUTER_SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | Solana RPC endpoint     |

**Full reference:** [docs/configuration.md](docs/configuration.md)

### Model Exclusion

Block specific models from being routed to. Useful if a model doesn't follow your agent instructions or you want to control costs.

```bash
/exclude add nvidia/gpt-oss-120b   # Block the free model
/exclude add grok-4                # Aliases work — blocks all grok-4 variants
/exclude add gpt-5.4               # Skip expensive models
/exclude                           # Show current exclusions
/exclude remove grok-4             # Unblock a model
/exclude clear                     # Remove all exclusions
```

Exclusions persist across restarts (`~/.openclaw/blockrun/exclude-models.json`). If all models in a tier are excluded, the safety net ignores the filter so routing never breaks.

---

## Troubleshooting

**When things go wrong, run the doctor:**

```bash
npx @blockrun/clawrouter doctor
```

This collects diagnostics and sends them to Claude Sonnet for AI-powered analysis:

```
🩺 BlockRun Doctor v0.12.24

System
  ✓ OS: darwin arm64
  ✓ Node: v20.11.0

Wallet
  ✓ Address: 0x1234...abcd
  ✓ Balance: $12.50

Network
  ✓ BlockRun API: reachable (142ms)
  ✗ Local proxy: not running on :8402

📤 Sending to Claude Sonnet 4.6 (~$0.003)...

🤖 AI Analysis:
The local proxy isn't running. Run `openclaw gateway restart` to fix.
```

**Use Opus for complex issues:**

```bash
npx @blockrun/clawrouter doctor opus
```

**Ask a specific question:**

```bash
npx @blockrun/clawrouter doctor "why is my request failing?"
npx @blockrun/clawrouter doctor opus "深度分析我的配置"
```

**Cost:** Sonnet ~$0.003 (default) | Opus ~$0.01

---

## Development

```bash
git clone https://github.com/BlockRunAI/ClawRouter.git
cd ClawRouter
npm install
npm run build
npm test
```

---

## Support

| Channel               | Link                                                               |
| --------------------- | ------------------------------------------------------------------ |
| 📅 Schedule Demo      | [calendly.com/vickyfu9/30min](https://calendly.com/vickyfu9/30min) |
| 💬 Community Telegram | [t.me/blockrunAI](https://t.me/blockrunAI)                         |
| 🐦 X / Twitter        | [x.com/blockrunai](https://x.com/blockrunai)                       |
| 📱 Founder Telegram   | [@bc1max](https://t.me/bc1max)                                     |
| ✉️ Email              | vicky@blockrun.ai                                                  |

---

## From the BlockRun Ecosystem

<table>
<tr>
<td width="50%">

### ⚡ ClawRouter

**The LLM router built for autonomous agents**

You're here. 55+ models, local smart routing, x402 USDC payments — the only stack that lets agents operate independently.

`curl -fsSL https://blockrun.ai/ClawRouter-update | bash`

</td>
<td width="50%">

### 🤖 [BRCC](https://github.com/BlockRunAI/brcc)

**BlockRun for Claude Code**

Run Claude Code with 50+ models, no rate limits, no Anthropic account, no phone verification. Pay per request with USDC — your wallet is your identity.

`curl -fsSL https://blockrun.ai/brcc-install | bash`

[![GitHub](https://img.shields.io/github/stars/BlockRunAI/brcc?style=flat-square)](https://github.com/BlockRunAI/brcc)

</td>
</tr>
</table>

---

## More Resources

| Resource                                               | Description              |
| ------------------------------------------------------ | ------------------------ |
| [Documentation](https://blockrun.ai/docs)              | Full docs                |
| [Model Pricing](https://blockrun.ai/models)            | All models & prices      |
| [Image Generation & Editing](docs/image-generation.md) | API examples, 5 models   |
| [Routing Profiles](docs/routing-profiles.md)           | ECO/AUTO/PREMIUM details |
| [Architecture](docs/architecture.md)                   | Technical deep dive      |
| [Configuration](docs/configuration.md)                 | Environment variables    |
| [Troubleshooting](docs/troubleshooting.md)             | Common issues            |

### Blog

| Article | Topic |
| ------- | ----- |
| [11 Free AI Models, Zero Cost](docs/11-free-ai-models-zero-cost-blockrun.md) | How BlockRun gives developers top-tier LLMs for nothing |
| [ClawRouter Cuts LLM API Costs 500×](docs/clawrouter-cuts-llm-api-costs-500x.md) | Deep dive into cost savings |
| [ClawRouter vs OpenRouter](docs/clawrouter-vs-openrouter-llm-routing-comparison.md) | Head-to-head comparison |
| [Smart LLM Router: 14-Dimension Classifier](docs/smart-llm-router-14-dimension-classifier.md) | How the routing engine works |
| [LLM Router Benchmark: 46 Models, Sub-1ms](docs/llm-router-benchmark-46-models-sub-1ms-routing.md) | Performance benchmarks |
| [Anthropic Cost Savings](docs/anthropic-cost-savings.md) | Reducing Claude API spend |

---

## Frequently Asked Questions

### What is ClawRouter?

ClawRouter is an open-source (MIT licensed) smart LLM router built for autonomous AI agents. It analyzes each request across 15 dimensions and routes to the cheapest capable model in under 1ms, entirely locally — no external API calls needed for routing decisions.

### How much can ClawRouter save on LLM costs?

ClawRouter's blended average cost is $2.05 per million tokens compared to $25/M for Claude Opus, representing 92% savings. Actual savings depend on your workload — simple queries are routed to budget models (as low as $0/request with NVIDIA free tier), while complex tasks get premium models.

### How does ClawRouter compare to OpenRouter?

ClawRouter is open source and runs locally. It uses wallet-based authentication (no API keys) and USDC per-request payments (no credit cards or subscriptions). OpenRouter requires an account, API key, and credit card. ClawRouter also features smart routing — it automatically picks the best model for each request, while OpenRouter requires manual model selection.

### How does ClawRouter compare to LiteLLM?

Both are open source and run locally. But ClawRouter adds smart routing (automatic model selection), wallet-based auth, and USDC payments. LiteLLM requires you to bring your own API keys and manually choose models.

### What agents does ClawRouter work with?

ClawRouter integrates with OpenClaw (Claude Code), ElizaOS, and any agent that makes OpenAI-compatible API calls. It runs as a local proxy on port 8402.

### Is ClawRouter free?

ClawRouter itself is free and MIT licensed. You pay only for the LLM API calls routed through it — and 11 models (DeepSeek V3.2, Nemotron Ultra 253B, Mistral Large 675B, Llama 4 Maverick, and more) are completely free. Use `/model free` for Nemotron Ultra 253B, or pick any free model by name.

---

<div align="center">

**MIT License** · [BlockRun](https://blockrun.ai) — Agent-native AI infrastructure

⭐ If ClawRouter powers your agents, consider starring the repo!

</div>
