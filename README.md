<div align="center">

<img src="assets/banner.png" alt="ClawRouter Banner" width="600">

<h3>The agent-native LLM router for <a href="https://openclaw.ai">OpenClaw</a></h3>

Route every request to the right model at the right price.<br>
15-dimension scoring, <1ms local routing, optimized for autonomous agents.<br>
One wallet, 41+ models, zero API keys.

<img src="https://img.shields.io/badge/🚀_92%25_Cost_Savings-success?style=for-the-badge" alt="92% savings">&nbsp;
<img src="https://img.shields.io/badge/🔑_Zero_API_Keys-blue?style=for-the-badge" alt="No API keys">&nbsp;
<img src="https://img.shields.io/badge/🤖_41+_Models-purple?style=for-the-badge" alt="41+ models">&nbsp;
<img src="https://img.shields.io/badge/💰_Non--Custodial-orange?style=for-the-badge" alt="Non-custodial">&nbsp;
<img src="https://img.shields.io/badge/⚡_<1ms_Routing-yellow?style=for-the-badge" alt="Fast routing">

[![npm version](https://img.shields.io/npm/v/@blockrun/clawrouter.svg?style=flat-square&color=cb3837)](https://npmjs.com/package/@blockrun/clawrouter)
[![npm downloads](https://img.shields.io/npm/dm/@blockrun/clawrouter.svg?style=flat-square&color=blue)](https://npmjs.com/package/@blockrun/clawrouter)
[![GitHub stars](https://img.shields.io/github/stars/BlockRunAI/ClawRouter?style=flat-square)](https://github.com/BlockRunAI/ClawRouter)
[![CI](https://img.shields.io/github/actions/workflow/status/BlockRunAI/ClawRouter/ci.yml?style=flat-square&label=CI)](https://github.com/BlockRunAI/ClawRouter/actions)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)
[![Chat with Repo](https://badge.forgithub.com/BlockRunAI/ClawRouter?badge=chat)](https://uithub.com/BlockRunAI/ClawRouter)

[![USDC Hackathon Winner](https://img.shields.io/badge/🏆_USDC_Hackathon-Agentic_Commerce_Winner-gold?style=flat-square)](https://x.com/USDC/status/2021625822294216977)
[![x402 Protocol](https://img.shields.io/badge/x402-Micropayments-purple?style=flat-square)](https://x402.org)
[![Base Network](https://img.shields.io/badge/Base-USDC-0052FF?style=flat-square&logo=coinbase&logoColor=white)](https://base.org)
[![Solana](https://img.shields.io/badge/Solana-USDC-9945FF?style=flat-square&logo=solana&logoColor=white)](https://solana.com)
[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-orange?style=flat-square)](https://openclaw.ai)
[![Telegram](https://img.shields.io/badge/Telegram-Community-26A5E4?style=flat-square&logo=telegram)](https://t.me/blockrunAI)

</div>

---

## 📑 Quick Navigation

| Section                                   | Description                     |
| ----------------------------------------- | ------------------------------- |
| [Quick Start](#-quick-start)              | Install in 2 minutes            |
| [Routing Profiles](#-routing-profiles)    | eco / auto / premium / free     |
| [Image Generation](#-image-generation)    | /imagegen with 5 models         |
| [How It Works](#-how-it-works)            | 15-dimension local routing      |
| [Models & Pricing](#-models--pricing)     | 41+ models, full price list     |
| [Screenshots](#-screenshots)              | See it in action                |
| [Payment](#-payment)                      | x402 non-custodial USDC         |
| [Configuration](#%EF%B8%8F-configuration) | Environment variables           |
| [Troubleshooting](#-troubleshooting)      | `doctor` AI-powered diagnostics |
| [vs OpenRouter](#-vs-openrouter)          | Why ClawRouter wins             |
| [Support](#-support)                      | Telegram, X, founders           |

---

## 🚀 Quick Start

```bash
# 1. Install with smart routing enabled
curl -fsSL https://blockrun.ai/ClawRouter-update | bash
openclaw gateway restart

# 2. Fund your wallet with USDC on Base or Solana (address printed on install)
# $5 is enough for thousands of requests
```

Done! Smart routing (`blockrun/auto`) is now your default model.

---

## 🎯 Routing Profiles

Choose your routing strategy with `/model <profile>`:

| Profile          | Strategy           | Savings | Best For         |
| ---------------- | ------------------ | ------- | ---------------- |
| `/model auto`    | Balanced (default) | 74-100% | General use      |
| `/model eco`     | Cheapest possible  | 95-100% | Maximum savings  |
| `/model premium` | Best quality       | 0%      | Mission-critical |
| `/model free`    | Free tier only     | 100%    | Zero cost        |

**Shortcuts:** `/model grok`, `/model br-sonnet`, `/model gpt5`, `/model o3`

---

## 🎨 Image Generation

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

Default model: `nano-banana`. Images are returned as hosted URLs for compatibility with Telegram, Discord, and other clients.

---

## ⚡ How It Works

**100% local routing. <1ms latency. Zero external API calls.**

```
Request → Weighted Scorer (15 dimensions) → Tier → Cheapest Model → Response
```

| Tier      | ECO Model                           | AUTO Model                   | PREMIUM Model                |
| --------- | ----------------------------------- | ---------------------------- | ---------------------------- |
| SIMPLE    | nvidia/gpt-oss-120b (FREE)          | kimi-k2.5 ($0.60/$3.00)      | kimi-k2.5                    |
| MEDIUM    | gemini-2.5-flash-lite ($0.10/$0.40) | grok-code-fast ($0.20/$1.50) | gpt-5.2-codex ($1.75/$14.00) |
| COMPLEX   | gemini-2.5-flash-lite ($0.10/$0.40) | gemini-3.1-pro ($2/$12)      | claude-opus-4.6 ($5/$25)     |
| REASONING | grok-4-fast ($0.20/$0.50)           | grok-4-fast ($0.20/$0.50)    | claude-sonnet-4.6 ($3/$15)   |

**Blended average: $2.05/M** vs $25/M for Claude Opus = **92% savings**

---

## 💰 Models & Pricing

41+ models across 7 providers, one wallet:

<details>
<summary><strong>Click to expand full model list</strong></summary>

| Model                   | Input $/M | Output $/M | Context | Reasoning |
| ----------------------- | --------- | ---------- | ------- | :-------: |
| **OpenAI**              |           |            |         |           |
| gpt-5.2                 | $1.75     | $14.00     | 400K    |    \*     |
| gpt-4o                  | $2.50     | $10.00     | 128K    |           |
| gpt-4o-mini             | $0.15     | $0.60      | 128K    |           |
| gpt-oss-120b            | **FREE**  | **FREE**   | 128K    |           |
| o1                      | $15.00    | $60.00     | 200K    |    \*     |
| o1-mini                 | $1.10     | $4.40      | 128K    |    \*     |
| o3                      | $2.00     | $8.00      | 200K    |    \*     |
| o4-mini                 | $1.10     | $4.40      | 128K    |    \*     |
| **Anthropic**           |           |            |         |           |
| claude-opus-4.6         | $5.00     | $25.00     | 200K    |    \*     |
| claude-sonnet-4.6       | $3.00     | $15.00     | 200K    |    \*     |
| claude-haiku-4.5        | $1.00     | $5.00      | 200K    |           |
| **Google**              |           |            |         |           |
| gemini-3.1-pro          | $2.00     | $12.00     | 1M      |    \*     |
| gemini-3-pro-preview    | $2.00     | $12.00     | 1M      |    \*     |
| gemini-3-flash-preview  | $0.50     | $3.00      | 1M      |           |
| gemini-2.5-pro          | $1.25     | $10.00     | 1M      |    \*     |
| gemini-2.5-flash        | $0.30     | $2.50      | 1M      |           |
| gemini-2.5-flash-lite   | $0.10     | $0.40      | 1M      |           |
| **DeepSeek**            |           |            |         |           |
| deepseek-chat           | $0.28     | $0.42      | 128K    |           |
| deepseek-reasoner       | $0.28     | $0.42      | 128K    |    \*     |
| **xAI**                 |           |            |         |           |
| grok-4-0709             | $0.20     | $1.50      | 131K    |    \*     |
| grok-4-1-fast-reasoning | $0.20     | $0.50      | 131K    |    \*     |
| grok-code-fast-1        | $0.20     | $1.50      | 131K    |           |
| **Moonshot**            |           |            |         |           |
| kimi-k2.5               | $0.60     | $3.00      | 262K    |    \*     |
| **MiniMax**             |           |            |         |           |
| minimax-m2.5            | $0.30     | $1.20      | 205K    |    \*     |

</details>

> **Free tier:** `gpt-oss-120b` costs nothing and serves as automatic fallback when wallet is empty.

---

## 📸 Screenshots

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

**The flow:**

1. **Wallet auto-generated** on Base (L2) — saved at `~/.openclaw/blockrun/wallet.key`
2. **Fund with $1 USDC** — enough for hundreds of requests
3. **Request any model** — ClawRouter picks the cheapest capable one
4. **Pay per request** — non-custodial, you hold your keys

---

## 💳 Payment

No account. No API key. **Payment IS authentication** via [x402](https://x402.org).

```
Request → 402 (price: $0.003) → wallet signs USDC → retry → response
```

USDC stays in your wallet until spent - non-custodial. Price is visible in the 402 header before signing.

**Dual-chain support:** Pay with USDC on **Base (EVM)** or **Solana**. Both wallets are derived from a single BIP-39 mnemonic on first run. Existing EVM-only users can enable Solana with `/wallet setup-solana`.

```bash
/wallet              # Check balance and address (both chains)
/wallet export       # Export keys and mnemonic for backup
/wallet solana       # Enable Solana payments / switch to Solana
/wallet base         # Switch back to Base (EVM)
/stats               # View usage and savings
```

**Fund your wallet:**

- **Base (EVM):** Send USDC on Base to your EVM address
- **Solana:** Send USDC on Solana to your Solana address
- **Coinbase/CEX:** Withdraw USDC to either network
- **Credit card:** Don't have USDC? Reach out to [@bc1max on Telegram](https://t.me/bc1max) — we accept credit card payments

---

## ⚙️ Configuration

For basic usage, no configuration needed. For advanced options:

| Variable                    | Default                               | Description             |
| --------------------------- | ------------------------------------- | ----------------------- |
| `BLOCKRUN_WALLET_KEY`       | auto-generated                        | Your wallet private key |
| `BLOCKRUN_PROXY_PORT`       | `8402`                                | Local proxy port        |
| `CLAWROUTER_DISABLED`       | `false`                               | Disable smart routing   |
| `CLAWROUTER_SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | Solana RPC endpoint     |

**Full reference:** [docs/configuration.md](docs/configuration.md)

---

## 🥊 vs OpenRouter

|                 | OpenRouter / LiteLLM        | ClawRouter                       |
| --------------- | --------------------------- | -------------------------------- |
| **Setup**       | Human creates account       | Agent generates wallet           |
| **Auth**        | API key (shared secret)     | Wallet signature (cryptographic) |
| **Payment**     | Prepaid balance (custodial) | Per-request (non-custodial)      |
| **Routing**     | Proprietary / closed        | Open source, client-side         |
| **Rate limits** | Per-key quotas              | None (your wallet, your limits)  |
| **Cost**        | $25/M (Opus equivalent)     | $2.05/M blended average          |

**[Full comparison →](docs/vs-openrouter.md)**

---

## 🩺 Troubleshooting

**When things go wrong, run the doctor:**

```bash
npx @blockrun/clawrouter doctor
```

This collects diagnostics and sends them to Claude Sonnet for AI-powered analysis:

```
🩺 BlockRun Doctor v0.10.4

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

## 🛠 Development

```bash
git clone https://github.com/BlockRunAI/ClawRouter.git
cd ClawRouter
npm install
npm run build
npm test
```

---

## 📞 Support

| Channel               | Link                                                               |
| --------------------- | ------------------------------------------------------------------ |
| 📅 Schedule Demo      | [calendly.com/vickyfu9/30min](https://calendly.com/vickyfu9/30min) |
| 💬 Community Telegram | [t.me/blockrunAI](https://t.me/blockrunAI)                         |
| 🐦 X / Twitter        | [x.com/BlockRunAI](https://x.com/BlockRunAI)                       |
| 📱 Founder Telegram   | [@bc1max](https://t.me/bc1max)                                     |
| ✉️ Email              | vicky@blockrun.ai                                                  |

---

## 📚 More Resources

| Resource                                     | Description              |
| -------------------------------------------- | ------------------------ |
| [Documentation](https://blockrun.ai/docs)    | Full docs                |
| [Model Pricing](https://blockrun.ai/models)  | All models & prices      |
| [Routing Profiles](docs/routing-profiles.md) | ECO/AUTO/PREMIUM details |
| [Architecture](docs/architecture.md)         | Technical deep dive      |
| [Configuration](docs/configuration.md)       | Environment variables    |
| [vs OpenRouter](docs/vs-openrouter.md)       | Why ClawRouter wins      |
| [Features](docs/features.md)                 | All features             |
| [Troubleshooting](docs/troubleshooting.md)   | Common issues            |

---

<div align="center">

**MIT License** · [BlockRun](https://blockrun.ai) — Pay-per-request AI infrastructure

⭐ If ClawRouter saves you money, consider starring the repo!

</div>
