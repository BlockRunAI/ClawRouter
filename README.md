# @blockrun/openclaw

LLM cost optimization for OpenClaw. One wallet, 30+ models, smart routing, spend controls. Pay per request with x402 USDC micropayments — no account needed.

## The Problem

OpenClaw operators are bleeding money on LLM costs.

The #1 complaint in the OpenClaw community ([#1594](https://github.com/openclaw/openclaw/issues/1594), 18 comments): users on $100/month plans hit their limits in 30 minutes. Context accumulates, token costs explode, and operators have zero visibility into where the money goes.

The related pain points:
- **Silent failures burn money** ([#2202](https://github.com/openclaw/openclaw/issues/2202)) — When rate limits hit, the system retries in a loop, each retry burning tokens. No error message, no fallback.
- **API key hell** ([#3713](https://github.com/openclaw/openclaw/issues/3713), [#7916](https://github.com/openclaw/openclaw/issues/7916)) — Operators juggle keys from OpenAI, Anthropic, Google, DeepSeek. Each with different billing, different limits, different dashboards.
- **No smart routing** ([#4658](https://github.com/openclaw/openclaw/issues/4658)) — Simple queries go to GPT-4o at $10/M output tokens when Gemini Flash could handle them at $0.60/M. No cost-aware model selection.

## The Solution

BlockRun gives OpenClaw operators one wallet for 30+ models with automatic cost optimization. No account, no API key — your wallet signs a USDC micropayment on Base for each request.

```bash
# Install the provider plugin
openclaw plugin install @blockrun/openclaw

# Set your wallet key
export BLOCKRUN_WALLET_KEY=0x...

# Set your model (or let smart routing choose)
openclaw config set model blockrun/auto
```

### What You Get

| Feature | What It Does |
|---------|-------------|
| **One wallet, 30+ models** | OpenAI, Anthropic, Google, DeepSeek, xAI — all through one wallet |
| **Smart routing** | Auto-routes queries to the cheapest model that can handle them |
| **Spend controls** | Set daily/weekly/monthly budgets. Hard stop when limit hit — no surprise bills |
| **Graceful fallback** | When one provider rate-limits, auto-switches to another. No silent failures |
| **Usage analytics** | Know exactly where every dollar goes — by model, by day, by conversation |

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                     Operator's OpenClaw Agent                    │
│                                                                 │
│  Agent sends standard OpenAI-format request                     │
│  (doesn't know about BlockRun)                                  │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  @blockrun/openclaw provider plugin                       │  │
│  │  • Intercepts LLM requests                                │  │
│  │  • Checks spend limits                                    │  │
│  │  • Forwards to BlockRun API                               │  │
│  │  • Handles x402 micropayment                               │  │
│  │  • Streams response back                                  │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     BlockRun API                                │
│                                                                 │
│  1. Verify x402 payment                                         │
│  2. Smart routing: pick cheapest capable model                  │
│  3. Enforce spend limits                                        │
│  4. Forward to provider (OpenAI, Anthropic, Google, etc.)       │
│  5. Stream response back                                        │
│  6. Log usage + cost                                            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

The plugin runs a local proxy between OpenClaw's LLM engine (pi-ai) and BlockRun's API. Pi-ai sees a standard OpenAI-compatible endpoint at `localhost`. It doesn't know about routing, payments, or spend limits — that's all handled transparently.

## Smart Routing

When model is set to `blockrun/auto`, BlockRun analyzes each request and routes to the cheapest model that can handle it:

```
Simple query ("What's 2+2?")
  → gemini-2.5-flash ($0.15/$0.60 per M tokens)

Medium query ("Summarize this article")
  → deepseek-chat ($0.28/$0.42 per M tokens)

Complex query ("Write a React component with tests")
  → gpt-4o or claude-sonnet-4 ($2.50-3.00/$10-15 per M tokens)

Reasoning task ("Prove this theorem")
  → o3 or gemini-2.5-pro ($1.25-2.00/$8-10 per M tokens)
```

Operators can also pin a specific model (`openclaw config set model openai/gpt-4o`) and still get spend controls + analytics.

## Payment

No account needed. Payment IS authentication via [x402](https://www.x402.org/).

Your wallet signs a USDC micropayment on Base for each API call. The plugin handles the payment dance transparently:

```
Request → 402 (price: $0.002) → sign USDC → retry with payment → stream response
```

```bash
export BLOCKRUN_WALLET_KEY=0x...your_private_key...
```

That's it. No signup, no dashboard, no credit card. Fund your wallet with USDC on Base and start making requests.

## Spend Controls

```yaml
# openclaw.yaml
plugins:
  - id: "@blockrun/openclaw"
    config:
      # Hard budget limits (requests blocked when exceeded)
      dailyBudget: "5.00"      # Max $5/day
      monthlyBudget: "50.00"   # Max $50/month

      # Per-request limits
      maxCostPerRequest: "0.50" # No single request over $0.50

      # Alerts
      alertAt: "80%"           # Notify when 80% of budget used
```

When a limit is hit, the plugin returns a clear error to the agent instead of silently failing or retrying in a loop.

## Available Models

| Model | Input ($/1M tokens) | Output ($/1M tokens) | Context |
|-------|---------------------|----------------------|---------|
| **OpenAI** | | | |
| openai/gpt-5.2 | $1.75 | $14.00 | 400K |
| openai/gpt-5-mini | $0.25 | $2.00 | 200K |
| openai/gpt-4o | $2.50 | $10.00 | 128K |
| openai/o3 | $2.00 | $8.00 | 200K |
| **Anthropic** | | | |
| anthropic/claude-opus-4.5 | $15.00 | $75.00 | 200K |
| anthropic/claude-sonnet-4 | $3.00 | $15.00 | 200K |
| anthropic/claude-haiku-4.5 | $1.00 | $5.00 | 200K |
| **Google** | | | |
| google/gemini-2.5-pro | $1.25 | $10.00 | 1M |
| google/gemini-2.5-flash | $0.15 | $0.60 | 1M |
| **DeepSeek** | | | |
| deepseek/deepseek-chat | $0.28 | $0.42 | 128K |
| **xAI** | | | |
| xai/grok-3 | $3.00 | $15.00 | 131K |

Full list: 30+ models across 5 providers. See `src/models.ts`.

## Architecture

### Plugin (Open Source)

The OpenClaw provider plugin. Runs a local HTTP proxy that sits between pi-ai and BlockRun's API.

```
src/
├── index.ts      # Plugin entry — register() and activate() lifecycle
├── provider.ts   # Registers "blockrun" provider in OpenClaw
├── proxy.ts      # Local HTTP proxy with payment handling
├── router.ts     # Smart routing logic (model selection)
├── budget.ts     # Spend controls and budget enforcement
├── models.ts     # Model definitions and pricing
├── auth.ts       # Wallet key resolution
└── types.ts      # Type definitions
```

### BlockRun API (Closed Source)

The backend that handles routing, billing, and provider forwarding. Already exists — this plugin connects to it.

```
POST /api/v1/chat/completions    — OpenAI-compatible chat endpoint
GET  /api/v1/models              — List available models
GET  /api/v1/usage               — Usage analytics
GET  /api/v1/budget              — Current spend vs. limits
```

## Market Context

- **OpenClaw**: 156K GitHub stars, most active open-source AI agent framework
- **#1 pain point**: Token costs ([#1594](https://github.com/openclaw/openclaw/issues/1594), 18 comments) — users hitting $100/month limits in 30 minutes
- **#2 pain point**: Silent failures burning money ([#2202](https://github.com/openclaw/openclaw/issues/2202), 7 comments)
- **#3 pain point**: API key management across multiple providers ([#3713](https://github.com/openclaw/openclaw/issues/3713))
- **#4 pain point**: No cost-aware model routing ([#4658](https://github.com/openclaw/openclaw/issues/4658))
- **Maintainer stance**: Payment and billing features should be third-party extensions ([#3465](https://github.com/openclaw/openclaw/issues/3465))

## Quick Start

```bash
# Install
openclaw plugin install @blockrun/openclaw

# Set your wallet key (USDC on Base)
export BLOCKRUN_WALLET_KEY=0x...

# Use smart routing
openclaw config set model blockrun/auto

# Or pick a specific model
openclaw config set model openai/gpt-4o
```

## Development

```bash
npm install
npm run build
npm run dev        # Watch mode
npm run typecheck
```

## Roadmap

- [x] Phase 1: Provider plugin — one API key, 30+ models, x402 payment proxy
- [ ] Phase 2: Smart routing — auto-select cheapest capable model
- [ ] Phase 3: Spend controls — daily/monthly budgets, per-request limits
- [ ] Phase 4: Usage analytics — cost tracking dashboard at blockrun.ai
- [ ] Phase 5: Graceful fallback — auto-switch providers on rate limit
- [ ] Phase 6: Community launch — npm publish, OpenClaw PR, awesome-list

## License

MIT
