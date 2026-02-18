# Configuration Reference

Complete reference for ClawRouter configuration options.

## Table of Contents

- [Environment Variables](#environment-variables)
- [Wallet Configuration](#wallet-configuration)
- [Wallet Backup & Recovery](#wallet-backup--recovery)
- [Proxy Settings](#proxy-settings)
- [Programmatic Usage](#programmatic-usage)
- [Routing Configuration](#routing-configuration)
- [Tier Overrides](#tier-overrides)
- [Scoring Weights](#scoring-weights)
- [Testing Configuration](#testing-configuration)

---

## Environment Variables

| Variable              | Default | Description                                                              |
| --------------------- | ------- | ------------------------------------------------------------------------ |
| `BLOCKRUN_WALLET_KEY` | -       | Ethereum private key (hex, 0x-prefixed). Used if no saved wallet exists. |
| `BLOCKRUN_PROXY_PORT` | `8402`  | Port for the local x402 proxy server.                                    |

### BLOCKRUN_WALLET_KEY

The wallet private key for signing x402 micropayments.

```bash
export BLOCKRUN_WALLET_KEY=0x...your_private_key...
```

**Resolution order:**

1. Saved file (`~/.openclaw/blockrun/wallet.key`) — checked first
2. `BLOCKRUN_WALLET_KEY` environment variable — used if no saved file
3. Auto-generate — creates new wallet and saves to file

> **Security Note:** The saved file takes priority to prevent accidentally switching wallets and losing access to funded balances.

### BLOCKRUN_PROXY_PORT

Configure the proxy to listen on a different port:

```bash
export BLOCKRUN_PROXY_PORT=8403
openclaw gateway restart
```

**Behavior:**

- If a proxy is already running on the configured port, ClawRouter will **reuse it** instead of failing with `EADDRINUSE`
- The proxy returns the wallet address of the existing instance, not the configured wallet
- A warning is logged if the existing proxy uses a different wallet

**Valid values:** 1-65535 (integers only). Invalid values fall back to 8402.

---

## Wallet Configuration

### Check Active Wallet

```bash
# View wallet address
curl http://localhost:8402/health | jq .wallet

# View wallet with balance info
curl "http://localhost:8402/health?full=true" | jq
```

Response:

```json
{
  "status": "ok",
  "wallet": "0x...",
  "balance": "$2.50",
  "isLow": false,
  "isEmpty": false
}
```

### Switch Wallets

To use a different wallet:

```bash
# 1. Remove saved wallet
rm ~/.openclaw/blockrun/wallet.key

# 2. Set new wallet key
export BLOCKRUN_WALLET_KEY=0x...

# 3. Restart
openclaw gateway restart
```

### Backup Wallet

```bash
# Backup wallet key
cp ~/.openclaw/blockrun/wallet.key ~/backup/

# View wallet address from key file
cat ~/.openclaw/blockrun/wallet.key
```

### Wallet Backup & Recovery

Your wallet private key is stored at `~/.openclaw/blockrun/wallet.key`. **Back up this file before terminating any VPS or machine!**

#### Using the `/wallet` Command

ClawRouter provides a built-in command for wallet management:

```bash
# Check wallet status (address, balance, file location)
/wallet

# Export private key for backup (shows the actual key)
/wallet export
```

The `/wallet export` command displays your private key so you can copy it before terminating a machine.

#### Manual Backup

```bash
# Option 1: Copy the key file
cp ~/.openclaw/blockrun/wallet.key ~/backup-wallet.key

# Option 2: View and copy the key
cat ~/.openclaw/blockrun/wallet.key
```

#### Restore on a New Machine

```bash
# Option 1: Set environment variable (before installing ClawRouter)
export BLOCKRUN_WALLET_KEY=0x...your_key_here...
openclaw plugins install @blockrun/clawrouter

# Option 2: Create the key file directly
mkdir -p ~/.openclaw/blockrun
echo "0x...your_key_here..." > ~/.openclaw/blockrun/wallet.key
chmod 600 ~/.openclaw/blockrun/wallet.key
openclaw plugins install @blockrun/clawrouter
```

**Important:** If a saved wallet file exists, it takes priority over the environment variable. To use a different wallet, delete the existing file first.

#### Lost Key Recovery

If you lose your wallet key, **there is no way to recover it**. The wallet is self-custodial, meaning only you have the private key. We do not store keys or have any way to restore access.

**Prevention tips:**

- Run `/wallet export` before terminating any VPS
- Keep a secure backup of `~/.openclaw/blockrun/wallet.key`
- For production use, consider using a hardware wallet or key management system

---

## Proxy Settings

### Proxy Reuse (v0.4.1+)

ClawRouter automatically detects and reuses an existing proxy on startup:

```
Session 1: startProxy() → starts server on :8402
Session 2: startProxy() → detects existing, reuses handle
```

**Behavior:**

- Health check is performed on the configured port before starting
- If responsive, returns a handle that uses the existing proxy
- `close()` on reused handles is a no-op (doesn't stop the original server)
- Warning logged if existing proxy uses a different wallet

### Programmatic Usage

Use ClawRouter without OpenClaw:

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

Or use the router directly (no proxy, no payments):

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

### Programmatic Options

All options for `startProxy()`:

```typescript
import { startProxy } from "@blockrun/clawrouter";

const proxy = await startProxy({
  walletKey: "0x...",

  // Port configuration
  port: 8402, // Default: 8402 or BLOCKRUN_PROXY_PORT

  // Timeouts
  requestTimeoutMs: 180000, // 3 minutes (covers on-chain tx + LLM response)

  // API base (for testing)
  apiBase: "https://blockrun.ai/api",

  // Callbacks
  onReady: (port) => console.log(`Proxy ready on ${port}`),
  onError: (error) => console.error(error),
  onRouted: (decision) => console.log(decision.model, decision.tier),
  onLowBalance: (info) => console.warn(`Low balance: ${info.balanceUSD}`),
  onInsufficientFunds: (info) => console.error(`Need ${info.requiredUSD}`),
  onPayment: (info) => console.log(`Paid ${info.amount} for ${info.model}`),

  // Routing config overrides
  routingConfig: {
    // See Routing Configuration below
  },
});
```

---

## Routing Configuration

### Via openclaw.yaml

```yaml
plugins:
  - id: "@blockrun/clawrouter"
    config:
      routing:
        # Override tier assignments
        tiers:
          SIMPLE:
            primary: "google/gemini-2.5-flash"
            fallback: ["deepseek/deepseek-chat"]
          MEDIUM:
            primary: "deepseek/deepseek-chat"
            fallback: ["openai/gpt-4o-mini"]
          COMPLEX:
            primary: "anthropic/claude-sonnet-4.6"
            fallback: ["openai/gpt-4o"]
          REASONING:
            primary: "deepseek/deepseek-reasoner"
            fallback: ["openai/o3-mini"]

        # Override scoring parameters
        scoring:
          reasoningKeywords: ["prove", "theorem", "formal", "derive"]
          codeKeywords: ["function", "class", "async", "import"]
          simpleKeywords: ["what is", "define", "hello"]

        # Override thresholds
        classifier:
          confidenceThreshold: 0.7
          reasoningConfidence: 0.97

        # Context-based overrides
        overrides:
          largeContextTokens: 100000 # Force COMPLEX above this
          structuredOutput: true # Bump to min MEDIUM for JSON/YAML
```

---

## Tier Overrides

### Default Tier Mappings

| Tier      | Primary Model                | Fallback Chain                                  |
| --------- | ---------------------------- | ----------------------------------------------- |
| SIMPLE    | `google/gemini-2.5-flash`    | `deepseek/deepseek-chat`                        |
| MEDIUM    | `deepseek/deepseek-chat`     | `openai/gpt-4o-mini`, `google/gemini-2.5-flash` |
| COMPLEX   | `anthropic/claude-sonnet-4.6`  | `openai/gpt-4o`, `google/gemini-2.5-pro`        |
| REASONING | `deepseek/deepseek-reasoner` | `openai/o3-mini`, `anthropic/claude-sonnet-4.6`   |

### Fallback Chain

When the primary model fails (rate limits, billing errors, provider outages), ClawRouter tries the next model in the fallback chain:

```
Request → gemini-2.5-flash (rate limited)
       → deepseek-chat (billing error)
       → gpt-4o-mini (success)
```

Max fallback attempts: 3 models per request.

### Custom Tier Configuration

```yaml
routing:
  tiers:
    COMPLEX:
      primary: "openai/gpt-4o" # Use GPT-4o instead of Claude
      fallback:
        - "anthropic/claude-sonnet-4.6"
        - "google/gemini-2.5-pro"
```

---

## Scoring Weights

The 15-dimension weighted scorer determines query complexity:

| Dimension             | Weight | Detection                                |
| --------------------- | ------ | ---------------------------------------- |
| `reasoningMarkers`    | 0.18   | "prove", "theorem", "step by step"       |
| `codePresence`        | 0.15   | "function", "async", "import", "```"     |
| `multiStepPatterns`   | 0.12   | "first...then", "step 1", numbered lists |
| `agenticTask`         | 0.10   | "run", "test", "fix", "deploy", "edit"   |
| `technicalTerms`      | 0.10   | "algorithm", "kubernetes", "distributed" |
| `tokenCount`          | 0.08   | short (<50) vs long (>500)               |
| `creativeMarkers`     | 0.05   | "story", "poem", "brainstorm"            |
| `questionComplexity`  | 0.05   | Multiple question marks                  |
| `constraintCount`     | 0.04   | "at most", "O(n)", "maximum"             |
| `imperativeVerbs`     | 0.03   | "build", "create", "implement"           |
| `outputFormat`        | 0.03   | "json", "yaml", "schema"                 |
| `simpleIndicators`    | 0.02   | "what is", "define", "translate"         |
| `domainSpecificity`   | 0.02   | "quantum", "fpga", "genomics"            |
| `referenceComplexity` | 0.02   | "the docs", "the api", "above"           |
| `negationComplexity`  | 0.01   | "don't", "avoid", "without"              |

### Custom Keywords

```yaml
routing:
  scoring:
    # Add domain-specific reasoning triggers
    reasoningKeywords:
      - "prove"
      - "theorem"
      - "formal verification"
      - "type theory" # Custom

    # Add framework-specific code triggers
    codeKeywords:
      - "function"
      - "useEffect" # React-specific
      - "prisma" # ORM-specific
```

---

## Advanced: Confidence Calibration

The classifier uses sigmoid calibration to convert raw scores to confidence values:

```
confidence = 1 / (1 + exp(-k * (score - midpoint)))
```

Parameters:

- `k = 8` — steepness of the sigmoid curve
- `midpoint = 0.5` — score at which confidence = 50%

### Override Thresholds

```yaml
routing:
  classifier:
    # Require higher confidence for tier assignment
    confidenceThreshold: 0.8 # Default: 0.7

    # Force REASONING tier at lower confidence
    reasoningConfidence: 0.90 # Default: 0.97
```

---

## Testing Configuration

### Dry Run (No Payments)

For testing routing without spending USDC:

```typescript
import { route, DEFAULT_ROUTING_CONFIG, BLOCKRUN_MODELS } from "@blockrun/clawrouter";

// Build pricing map
const modelPricing = new Map();
for (const m of BLOCKRUN_MODELS) {
  modelPricing.set(m.id, { inputPrice: m.inputPrice, outputPrice: m.outputPrice });
}

// Test routing decisions locally
const decision = route("Prove sqrt(2) is irrational", undefined, 4096, {
  config: DEFAULT_ROUTING_CONFIG,
  modelPricing,
});

console.log(decision);
// { model: "deepseek/deepseek-reasoner", tier: "REASONING", ... }
```

### Run Tests

```bash
# Router tests (no wallet needed)
npx tsx test/e2e.ts

# Proxy reuse tests
npx tsx test/proxy-reuse.ts

# Full e2e with payments (requires funded wallet)
BLOCKRUN_WALLET_KEY=0x... npx tsx test/e2e.ts
```
