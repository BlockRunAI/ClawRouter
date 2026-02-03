# @blockrun/openclaw-provider

BlockRun LLM provider plugin for [OpenClaw](https://github.com/nicepkg/openclaw). Access 30+ AI models — GPT-5, Claude, Gemini, DeepSeek, Grok — with automatic [x402](https://www.x402.org/) USDC micropayments on Base.

## Why This Exists

### The Problem

OpenClaw is an open-source AI agent framework (150K+ GitHub stars) that lets operators run AI-powered bots across WhatsApp, Telegram, Discord, Slack, and more. Operators need to connect their bots to LLM providers — but every provider requires API keys, billing accounts, credit card signups, and manual credit management.

For crypto-native operators, this friction is unacceptable. They want:
- **No accounts** — just a wallet
- **No credit cards** — just USDC
- **No prepaid credits** — pay per request, in real time
- **No vendor lock-in** — switch models freely

### The Solution: x402 Micropayments

This plugin connects OpenClaw to [BlockRun](https://blockrun.ai), an LLM API gateway that accepts [x402 payments](https://www.x402.org/) — an HTTP-native payment protocol by Coinbase where every API call is paid for with a USDC microtransaction on Base.

The flow:

```
Your OpenClaw bot sends a chat completion request
  → Local proxy intercepts it
  → Forwards to BlockRun API
  → BlockRun returns HTTP 402 (Payment Required) with price
  → Proxy auto-signs a USDC payment with your wallet
  → Retries the request with payment proof
  → BlockRun verifies, streams the response back
  → Your bot gets the completion as if nothing happened
```

**No API keys. No accounts. No invoices. Just a wallet with USDC on Base.**

### The Bigger Picture: Two-Sided Payment Layer

This plugin is **Phase 1** of a two-sided payment architecture:

```
                    Phase 1 (this plugin)          Phase 2 (coming soon)
                    ─────────────────────          ─────────────────────
End Users ──pay──▶ Operator's Bot ──x402──▶ BlockRun API ──▶ LLM Providers
  (Stripe/x402)       (earns spread)         (this plugin)    (GPT-5, Claude, etc.)
```

- **Phase 1** (this repo): Operator pays BlockRun for LLM usage via x402. One plugin install, 30+ models.
- **Phase 2** (planned): End users pay operators for bot access via x402 or Stripe. Operators earn the spread.

## Architecture

### Why a Local Proxy?

OpenClaw's LLM engine (pi-ai) speaks standard OpenAI-format HTTP to providers. It doesn't know about x402. Rather than forking pi-ai, we run a lightweight local HTTP proxy that:

1. Receives standard OpenAI requests from pi-ai at `http://127.0.0.1:{port}/v1/...`
2. Forwards them to `https://api.blockrun.ai/api/v1/...`
3. Handles the x402 payment dance (402 → sign → retry) transparently
4. Streams the response back to pi-ai

This means **zero changes to OpenClaw core**. The proxy is invisible to pi-ai — it just sees a fast local OpenAI-compatible API.

### Streaming Support

x402 is a **gated API protocol**: the server verifies the payment commitment *before* granting access, then streams the full response, then settles the payment. This means streaming works naturally — the 402 → sign → retry happens once on the initial request, then the response body streams through without buffering.

### Source Files

```
src/
├── index.ts      # Plugin entry point — register() and activate() lifecycle
├── provider.ts   # ProviderPlugin — registers "blockrun" in OpenClaw's provider system
├── proxy.ts      # Local HTTP proxy with x402 payment handling via @x402/fetch
├── models.ts     # 26 model definitions (GPT-5, Claude, Gemini, DeepSeek, Grok)
├── auth.ts       # Auth methods — wallet key input or env var
└── types.ts      # Local type definitions (duck-typed to match OpenClaw's plugin API)
```

### Key Dependencies

| Package | Purpose |
|---------|---------|
| `@x402/fetch` | Wraps native `fetch` to auto-handle 402 payment responses |
| `@x402/evm` | EVM signer for x402 — signs USDC TransferWithAuthorization via EIP-712 |
| `viem` | Ethereum account management — `privateKeyToAccount` |

## Installation

```bash
# Install the plugin in your OpenClaw workspace
openclaw plugin install @blockrun/openclaw-provider
```

Or add to your OpenClaw config manually:

```yaml
# openclaw.yaml
plugins:
  - "@blockrun/openclaw-provider"
```

## Configuration

### Option 1: Environment Variable (Recommended)

```bash
export BLOCKRUN_WALLET_KEY=0x...your_private_key...
```

The plugin auto-detects the env var on startup.

### Option 2: OpenClaw Provider Wizard

```bash
openclaw provider add blockrun
```

This prompts for your wallet private key and stores it securely in OpenClaw's credential system.

### Option 3: Plugin Config

```yaml
# openclaw.yaml
plugins:
  - id: "@blockrun/openclaw-provider"
    config:
      walletKey: "0x..."
```

### Setting the Model

```bash
# Use any BlockRun model
openclaw config set model openai/gpt-5.2
openclaw config set model anthropic/claude-sonnet-4
openclaw config set model google/gemini-2.5-pro
openclaw config set model deepseek/deepseek-chat
```

## Available Models

| Model | Input ($/1M tokens) | Output ($/1M tokens) | Context | Reasoning |
|-------|---------------------|----------------------|---------|-----------|
| **OpenAI** | | | | |
| openai/gpt-5.2 | $1.75 | $14.00 | 400K | Yes |
| openai/gpt-5-mini | $0.25 | $2.00 | 200K | |
| openai/gpt-5-nano | $0.05 | $0.40 | 128K | |
| openai/gpt-4.1 | $2.00 | $8.00 | 128K | |
| openai/gpt-4.1-mini | $0.40 | $1.60 | 128K | |
| openai/gpt-4o | $2.50 | $10.00 | 128K | |
| openai/o3 | $2.00 | $8.00 | 200K | Yes |
| openai/o4-mini | $1.10 | $4.40 | 128K | Yes |
| **Anthropic** | | | | |
| anthropic/claude-opus-4.5 | $15.00 | $75.00 | 200K | Yes |
| anthropic/claude-sonnet-4 | $3.00 | $15.00 | 200K | Yes |
| anthropic/claude-haiku-4.5 | $1.00 | $5.00 | 200K | |
| **Google** | | | | |
| google/gemini-2.5-pro | $1.25 | $10.00 | 1M | Yes |
| google/gemini-2.5-flash | $0.15 | $0.60 | 1M | |
| google/gemini-3-pro-preview | $2.00 | $12.00 | 1M | Yes |
| **DeepSeek** | | | | |
| deepseek/deepseek-chat | $0.28 | $0.42 | 128K | |
| deepseek/deepseek-reasoner | $0.28 | $0.42 | 128K | Yes |
| **xAI** | | | | |
| xai/grok-3 | $3.00 | $15.00 | 131K | Yes |
| xai/grok-3-mini | $0.30 | $0.50 | 131K | |

Full list: 26 models across 5 providers. See `src/models.ts` for details.

## How It Works (Technical)

### Plugin Lifecycle

1. **`register(api)`** — Called when OpenClaw loads the plugin. Registers the "blockrun" provider with model definitions and auth methods.

2. **`activate(api)`** — Called when the plugin activates. Resolves the wallet key (from plugin config, env var, or stored credential), starts the local x402 proxy on a random port, and updates the provider's `baseUrl` to point to the proxy.

### x402 Payment Flow (per request)

```
pi-ai                    Proxy (localhost)              BlockRun API
  │                           │                              │
  │── POST /v1/chat/comp ───▶│                              │
  │                           │── POST /v1/chat/comp ──────▶│
  │                           │                              │
  │                           │◀── 402 Payment Required ────│
  │                           │    (price: $0.002 USDC)      │
  │                           │                              │
  │                           │ [sign EIP-712 USDC auth]     │
  │                           │                              │
  │                           │── POST + X-PAYMENT header ─▶│
  │                           │                              │
  │                           │◀── 200 OK (streaming) ──────│
  │◀── 200 OK (streaming) ───│                              │
  │    [tokens stream through]│                              │
```

### Type Strategy

OpenClaw's plugin system uses duck typing — it matches object shapes at runtime rather than requiring explicit type imports. This plugin defines its own local types in `src/types.ts` that match OpenClaw's expected shapes (`ProviderPlugin`, `ModelDefinitionConfig`, etc.), avoiding dependency on internal OpenClaw paths that aren't part of the public plugin SDK export.

## Wallet Setup

You need an EVM wallet with USDC on Base:

1. **Create or use an existing wallet** — any EVM wallet works (MetaMask, Coinbase Wallet, etc.)
2. **Export the private key** — the 0x-prefixed 64-character hex string
3. **Fund with USDC on Base** — bridge USDC to Base network, or buy directly on Base
4. **Set the key** — via env var, wizard, or config (see Configuration above)

Typical costs: a single GPT-4o chat completion costs ~$0.001-0.01 in USDC. $10 of USDC gets you thousands of requests.

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Watch mode
npm run dev

# Type check
npm run typecheck
```

## Roadmap

- [x] **Phase 1**: Provider plugin — OpenClaw operators use BlockRun models via x402
- [ ] **Phase 2**: Billing plugin — operators charge end users (x402 + Stripe)
- [ ] **Phase 3**: Reference bot — self-hosted crypto analyst on Telegram
- [ ] **Phase 4**: Community launch — npm publish, ClawHub listing, OpenClaw PR

## License

MIT
