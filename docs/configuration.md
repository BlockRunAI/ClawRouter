# Configuration Reference

Complete reference for ClawRouter configuration options.

## Table of Contents

- [Environment Variables](#environment-variables)
- [API Key Authentication](#api-key-authentication)
- [Environment Variable Reference](#environment-variable-reference)
- [Wallet Configuration](#wallet-configuration)
- [Wallet Backup & Recovery](#wallet-backup--recovery)
- [Proxy Settings](#proxy-settings)
- [Programmatic Usage](#programmatic-usage)
- [Routing Configuration](#routing-configuration)
- [Tier Overrides](#tier-overrides)
- [Scoring Weights](#scoring-weights)
- [Spend Control & Counterparty Policy](#spend-control--counterparty-policy)
- [Testing Configuration](#testing-configuration)

---

## Environment Variables

| Variable                    | Default                               | Description                                                                                                                                                 |
| --------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BLOCKRUN_API_KEY`          | -                                     | BlockRun API key (`brk_live_…`). Pays from card-funded account credit via `api.blockrun.ai` instead of a wallet. Takes precedence over every wallet source. |
| `BLOCKRUN_API_BASE_URL`     | `https://api.blockrun.ai`             | Override the API-key gateway (staging deploys only).                                                                                                        |
| `BLOCKRUN_WALLET_KEY`       | -                                     | Explicit Base wallet override (hex, 0x-prefixed).                                                                                                           |
| `BLOCKRUN_PROXY_PORT`       | `8402`                                | Port for the local x402 proxy server.                                                                                                                       |
| `CLAWROUTER_SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | Solana RPC endpoint for USDC balance checks.                                                                                                                |
| `CLAWROUTER_DISABLED`       | `false`                               | Set to `true` to disable smart routing (pass requests through as-is).                                                                                       |
| `CLAWROUTER_WORKER`         | -                                     | Set to `1` to enable Worker Mode (earn USDC by running health checks).                                                                                      |
| `CLAWROUTER_DEBUG_HEADERS`  | (on)                                  | Set to `off`/`false`/`0` to suppress the `x-clawrouter-*` debug response headers.                                                                           |
| `BLOCKRUN_WEB_SEARCH`       | (auto-enabled)                        | Set to `off` to disable BlockRun's Exa web search provider registration.                                                                                    |

---

## API Key Authentication

ClawRouter has two ways to pay BlockRun, and they are mutually exclusive per
process:

|              | Wallet (default)                                         | API key                                                              |
| ------------ | -------------------------------------------------------- | -------------------------------------------------------------------- |
| Credential   | An EVM/Solana private key held locally                   | `brk_live_…`, issued at [user.blockrun.ai](https://user.blockrun.ai) |
| Gateway      | `blockrun.ai/api` (Base), `sol.blockrun.ai/api` (Solana) | `api.blockrun.ai`                                                    |
| Wire auth    | An x402 signature per request                            | `Authorization: Bearer brk_live_…`                                   |
| Funding      | USDC you send to the wallet                              | Credit card top-up on the portal                                     |
| Out of money | Local balance check → free-model fallback                | Gateway answers `402 insufficient_quota`                             |

**An API key wins whenever one is present.** A machine holding both a legacy
wallet and a key the user just added means "bill my account", not "keep spending
my USDC". Nothing is deleted — `clawrouter logout` puts the wallet back in
charge.

### Resolution order

1. `BLOCKRUN_API_KEY` environment variable
2. BlockRun Core — `~/.blockrun/.api-key`, shared with other BlockRun products
3. Legacy ClawRouter location — `~/.openclaw/blockrun/api-key`
4. The OpenClaw plugin's `apiKey` config value (checked first inside the plugin)

A file that exists but does not hold a `brk_`-prefixed value is reported and
skipped rather than sent upstream — a malformed credential otherwise surfaces as
an unexplained 401 on every request.

### Commands

```bash
clawrouter login brk_live_...   # save to ~/.blockrun/.api-key (mode 0600)
clawrouter login                # prompt for the key instead
clawrouter logout               # delete stored keys, fall back to the wallet
clawrouter status               # shows the mode, gateway, and masked key
clawrouter doctor               # verifies the key against api.blockrun.ai
```

### Behaviour in API-key mode

- **No wallet is created or read.** `startProxy` skips the x402 client, the EVM
  and Solana signers, and the spend-policy pre-sign hook entirely — there is
  nothing to sign. `clawrouter doctor` will not generate one either.
- **No payment chain.** `/health` reports `authMode: "api-key"` with a masked
  key and no `paymentChain`, `wallet` or `solana` field. Two ClawRouters on the
  same port refuse to reuse each other across modes, the same way they already
  refuse across chains.
- **No local balance gate.** The gateway holds the books and publishes no
  key-readable balance, so ClawRouter does not guess one: it makes the call, and
  a 402 with `insufficient_quota` is the answer when credit runs out. The free
  models remain free and need no credit.
- **Endpoint coverage.** `api.blockrun.ai` currently serves `/v1/chat/completions`,
  `/v1/messages`, `GET /v1/models` and `GET /v1/images/models`. Media and partner
  endpoints stay wallet-only until BlockRun publishes them on the API-key rail;
  ClawRouter passes every path through and rewrites the gateway's
  `Unsupported endpoint` 404 into an explanation, so new services work the day
  they ship with no ClawRouter release.
- **Routing is unchanged.** Model ids, aliases, the 15-dimension classifier, the
  fallback chains, `/exclude`, `maxCostPerRun` and the response cache all behave
  identically.
- **`clawrouter policy` limits are NOT enforced.** The spend windows
  (`perRequest`/`hourly`/`daily`/`session`) and the payee/network/asset lists are
  checked in the x402 pre-sign hook, which does not run when nothing is signed.
  Your BlockRun account balance is the cap. ClawRouter warns at startup if any
  limit is configured, so a disabled cap is never silent. `maxCostPerRun` is
  unaffected — it is enforced by the router.

### Using the key without ClawRouter

The same key works against `api.blockrun.ai` from any OpenAI-compatible client
(`Authorization: Bearer`) or Anthropic client (`x-api-key`):

```bash
curl https://api.blockrun.ai/v1/chat/completions \
  -H "Authorization: Bearer brk_live_..." \
  -H "Content-Type: application/json" \
  -d '{"model": "anthropic/claude-sonnet-5", "messages": [{"role": "user", "content": "hello"}]}'
```

Going through ClawRouter is what adds smart routing, fallback chains, the
response cache and local spend controls.

---

## Environment Variable Reference

### BLOCKRUN_WALLET_KEY

The wallet private key for signing x402 micropayments.

```bash
export BLOCKRUN_WALLET_KEY=0x...your_private_key...
```

**Resolution order:**

1. `BLOCKRUN_WALLET_KEY` environment variable — explicit override
2. BlockRun Core wallet (`~/.blockrun/.session` and `~/.blockrun/.solana-session`)
3. Legacy ClawRouter wallet (`~/.openclaw/blockrun/`) — copied into Core automatically
4. Auto-generate — creates a Core wallet plus legacy recovery files

> **Migration safety:** Existing Core files are never overwritten. Legacy files are copied, not moved or deleted, so they remain available for rollback and recovery.

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

### BLOCKRUN_WEB_SEARCH

Disable BlockRun's bundled Exa web search provider. By default ClawRouter calls `registerWebSearchProvider(blockrun-exa)` and lets OpenClaw auto-detect it as the active search provider; if you'd rather use a different provider (or no web search at all), turn it off.

**Two equivalent opt-out paths:**

```bash
# Path 1: env var (CI / one-off runs)
export BLOCKRUN_WEB_SEARCH=off
openclaw gateway restart
```

```jsonc
// Path 2: persistent — edit ~/.openclaw/openclaw.json
{
  "tools": {
    "web": {
      "search": {
        "enabled": false,
      },
    },
  },
}
```

When disabled:

- ClawRouter skips `registerWebSearchProvider()` so blockrun-exa never gets wired up.
- `injectModelsConfig` leaves your `tools.web.search.enabled = false` alone instead of flipping it back to `true` on every plugin load.
- The legacy `tools.web.search.provider = "blockrun-exa"` migration still runs (that's correctness — it's an invalid value rejected by OpenClaw 2026.5.2+ validators, regardless of whether you want search enabled).

### CLAWROUTER_DEBUG_HEADERS

Non-streaming responses carry routing debug headers by default
(`x-clawrouter-profile`, `x-clawrouter-tier`, `x-clawrouter-model`,
`x-clawrouter-confidence`, `x-clawrouter-reasoning`). To turn them off
globally:

```bash
export CLAWROUTER_DEBUG_HEADERS=off   # also accepts false / 0
openclaw gateway restart
```

Per-request alternative: send `x-clawrouter-debug: false` on the request.

> Since v0.12.208 the reasoning value is percent-encoded, so non-ASCII routing
> signals (Cyrillic/CJK keyword matches) can no longer produce an invalid
> header. On v0.12.207 and earlier, non-English prompts could crash response
> delivery with `Invalid character in header content ["x-clawrouter-reasoning"]`
> — upgrade rather than relying on this switch.

### CLAWROUTER_SOLANA_RPC_URL

Override the Solana RPC endpoint used for USDC balance checks **and for signing
payments** (Solana chain only):

```bash
export CLAWROUTER_SOLANA_RPC_URL=https://your-rpc-provider.com
openclaw gateway restart
```

Public RPC may rate-limit on heavy usage. Use a dedicated RPC for production.

Unlike Base, where the EIP-3009 signature is produced entirely offline, signing
a Solana payment reads the payment asset's mint account over RPC. A host that
cannot reach `api.mainnet-beta.solana.com` therefore fails **every** paid Solana
call with `fetch failed` while `sol.blockrun.ai` itself answers normally. Check
egress before blaming the gateway:

```bash
curl -s -m 10 -X POST https://api.mainnet-beta.solana.com \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getAccountInfo","params":["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",{"encoding":"base64"}]}'
```

If that hangs or is refused, point this variable at an endpoint the host can
reach.

---

## Wallet Configuration

ClawRouter supports **two payment chains**: Base (EVM) and Solana. Both are USDC only — no SOL or ETH accepted for payments.

### Check Active Wallet

```bash
# View wallet address + balance (both chains shown)
/wallet

# Or via HTTP
curl http://localhost:8402/health | jq .wallet
curl "http://localhost:8402/health?full=true" | jq
```

Response (dual-chain):

```json
{
  "status": "ok",
  "wallet": "0x1234...abcd",
  "solanaWallet": "7Xkr...xyz",
  "paymentChain": "base",
  "balance": "$2.50",
  "isLow": false,
  "isEmpty": false
}
```

### Switch Payment Chain

```bash
/wallet solana    # Switch to Solana USDC payments
/wallet base      # Switch to Base (EVM) USDC payments
```

The selected chain is persisted across gateway restarts in `~/.blockrun/.chain` (and mirrored to the legacy `~/.openclaw/blockrun/payment-chain` file for rollback compatibility). New installs default to **Solana**; existing installs without a saved selection stay on **Base**, where their funds already live. The `CLAWROUTER_PAYMENT_CHAIN` environment variable (`solana` or `base`) overrides the persisted selection.

### Switch Wallets

To use a different wallet:

```bash
# 1. Back up the current Core wallet
cp -R ~/.blockrun ~/blockrun-wallet-backup

# 2. Set new wallet key
export BLOCKRUN_WALLET_KEY=0x...

# 3. Restart
openclaw gateway restart
```

### Backup Wallet

```bash
# Back up the complete Core wallet directory
cp -R ~/.blockrun ~/blockrun-wallet-backup
```

Use `/wallet` in OpenClaw chat to view wallet addresses and balances. Never
print or share `~/.blockrun/.session`—it contains your Base private key.

### Wallet Backup & Recovery

BlockRun Core stores the Base private key at `~/.blockrun/.session`, the Solana key at `~/.blockrun/.solana-session`, and the selected chain at `~/.blockrun/.chain`. ClawRouter-generated wallets also retain the recovery mnemonic at `~/.openclaw/blockrun/mnemonic`. **Back up both directories before terminating any VPS or machine.**

#### Using the `/wallet` Command

```bash
# Check wallet status (address, balance, chain, file location)
/wallet

# Export mnemonic + private keys for backup
/wallet export
```

The `/wallet export` command displays your mnemonic and keys so you can copy them before terminating a machine.

#### Manual Backup

```bash
# Option 1: Copy the Core wallet directory
cp -R ~/.blockrun ~/blockrun-wallet-backup

# Option 2: View mnemonic
cat ~/.openclaw/blockrun/mnemonic
```

#### Restore on a New Machine

```bash
# Option 1: Restore a complete Core backup
cp -R ~/blockrun-wallet-backup ~/.blockrun

# Option 2: Set environment variable (before installing ClawRouter)
export BLOCKRUN_WALLET_KEY=0x...your_private_key...
openclaw plugins install @blockrun/clawrouter

# Option 3: Restore a ClawRouter recovery mnemonic, then migrate on startup
mkdir -p ~/.openclaw/blockrun
echo "your recovery mnemonic here" > ~/.openclaw/blockrun/mnemonic
chmod 600 ~/.openclaw/blockrun/mnemonic
npx @blockrun/clawrouter wallet recover
openclaw plugins install @blockrun/clawrouter
```

**Important:** `BLOCKRUN_WALLET_KEY` is an explicit Base-wallet override. Back up the existing Core directory before replacing wallet files.

#### Lost Key Recovery

If you lose your wallet key, **there is no way to recover it**. The wallet is self-custodial, meaning only you have the private key. We do not store keys or have any way to restore access.

**Prevention tips:**

- Run `/wallet export` before terminating any VPS
- Keep secure backups of `~/.blockrun` and any legacy recovery mnemonic
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
//   model: "xai/grok-4-1-fast-reasoning",
//   tier: "REASONING",
//   taskType: "reasoning_math",
//   confidence: 0.97,
//   method: "portfolio",
//   routerVersion: "v3-portfolio",
//   profile: "auto",
//   candidates: ["xai/grok-4-1-fast-reasoning", "xai/grok-4-fast-reasoning", "deepseek/deepseek-reasoner", ...],
//   candidateScores: [{ model, score, quality, cost, speed, reliability }, ...],
//   savings: 0.99,
//   costEstimate: 0.0007,
//   reasoning: "…",
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

Routing decisions are made by [`@blockrun/router-core`](https://github.com/BlockRunAI/router-core) (Router Core V3.4). The `routing` block is merged over router-core's `DEFAULT_ROUTING_CONFIG`: tier maps are merged per tier (override just `COMPLEX` without redefining the other three), `classifier` / `scoring` / `overrides` are merged per key, and `null` disables a tier set.

### Via openclaw.yaml

```yaml
plugins:
  - id: "@blockrun/clawrouter"
    config:
      # Maximum spend per session/run in USD.
      # Default: disabled (no limit)
      maxCostPerRun: 0.50 # $0.50 per session

      # How to enforce the budget cap. Default: graceful
      #
      # graceful (default): when budget runs low, ClawRouter automatically downgrades
      #   to cheaper models (premium → auto → eco → free). Tasks keep running.
      #   Only returns an error if no model can serve the request at all.
      #
      # strict: immediately returns 429 (X-ClawRouter-Cost-Cap-Exceeded: 1) once
      #   the session spend reaches the cap. Use when you need a hard budget ceiling.
      maxCostPerRunMode: graceful # or: strict

      # Note: image generation endpoints (/v1/images/generations) bypass maxCostPerRun.
      # Their cost is charged via x402 micropayment directly and is not tracked per-session.

      routing:
        # Strategy. Default: portfolio (Router Core V3.4 — constraint-first ranking
        # over the tier's chain). "rules" is the one-line rollback to the V2
        # primary-first selector.
        strategy: portfolio

        # Optional shadow evaluation: recompute a comparison decision locally on a
        # sample of requests and report it on the x-clawrouter-* debug headers.
        # Never issues a second paid completion, never persists prompt content.
        # shadow:
        #   strategy: rules
        #   sampleRate: 0.1

        # Override tier chains (auto profile). Each tier is merged individually,
        # so you can override just COMPLEX. Under the portfolio strategy the
        # chain is the candidate pool: primary is the curated head, the ranker
        # still enforces tool/vision/context constraints and may pick a fallback.
        tiers:
          COMPLEX:
            primary: "anthropic/claude-sonnet-5"
            fallback: ["google/gemini-3.1-pro", "openai/gpt-5.6-terra"]

        # Same shape for the other tier sets:
        # ecoTiers: { ... }
        # premiumTiers: { ... }
        # agenticTiers: { ... }   # or `null` to disable agentic switching entirely

        # Override scoring keywords
        scoring:
          reasoningKeywords: ["prove", "theorem", "formal", "derive"]
          codeKeywords: ["function", "class", "async", "import"]
          simpleKeywords: ["what is", "define", "hello"]

        # Override thresholds
        classifier:
          confidenceThreshold: 0.7

        # Context-based overrides
        overrides:
          maxTokensForceComplex: 100000 # Force COMPLEX above this many tokens
          structuredOutputMinTier: MEDIUM # Bump to at least MEDIUM for JSON/YAML
          ambiguousDefaultTier: MEDIUM # Where low-confidence requests land
          # agenticMode: true | false   # force / disable the agentic tier set (default: auto-detect)
```

---

## Tier Overrides

### Default Tier Mappings (auto profile)

Curated primaries from router-core's `DEFAULT_ROUTING_CONFIG.tiers`; chains truncated. The full chains for every profile — and the eco / premium / agentic tier sets — are in [routing-profiles.md](./routing-profiles.md).

| Tier      | Primary Model                | Fallback Chain (head)                                              |
| --------- | ---------------------------- | ------------------------------------------------------------------ |
| SIMPLE    | `google/gemini-2.5-flash`    | `google/gemini-3-flash-preview`, `google/gemini-3.5-flash-lite`, … |
| MEDIUM    | `google/gemini-3.5-flash`    | `google/gemini-3.6-flash`, `zai/glm-5.3-flash`, …                  |
| COMPLEX   | `google/gemini-3.1-pro`      | `google/gemini-3.6-flash`, `google/gemini-3.5-flash`, …            |
| REASONING | `deepseek/deepseek-reasoner` | `deepseek/deepseek-v4-pro`, `xai/grok-4.3`, …                      |

### Fallback Chain

The ranked candidate list is returned on every decision (`decision.candidates`). When the selected model fails (rate limits, billing errors, provider outages, timeouts), ClawRouter tries the next candidate:

```
Request → gemini-3.1-pro (503)
       → gemini-3-flash-preview (rate limited)
       → grok-4-0709 (success)
```

Candidates that fail a hard constraint (no tool calling on a tool turn, no vision on image input, too small a context window) are removed before ranking, so a fallback never lands on a model that cannot serve the request.

### Custom Tier Configuration

```yaml
routing:
  tiers:
    COMPLEX:
      primary: "openai/gpt-5.6-terra" # Use GPT-5.6 Terra instead of Gemini 3.1 Pro
      fallback:
        - "anthropic/claude-sonnet-5"
        - "google/gemini-3.1-pro"
```

---

## Scoring Weights

The 15-dimension weighted scorer determines query complexity:

| Dimension             | Weight | Detection                                |
| --------------------- | ------ | ---------------------------------------- |
| `reasoningMarkers`    | 0.18   | "prove", "theorem", "step by step"       |
| `codePresence`        | 0.15   | "function", "async", "import", "```"     |
| `multiStepPatterns`   | 0.12   | "first...then", "step 1", numbered lists |
| `technicalTerms`      | 0.10   | "algorithm", "kubernetes", "distributed" |
| `tokenCount`          | 0.08   | short (<50) vs long (>500)               |
| `creativeMarkers`     | 0.05   | "story", "poem", "brainstorm"            |
| `questionComplexity`  | 0.05   | Multiple question marks                  |
| `constraintCount`     | 0.04   | "at most", "O(n)", "maximum"             |
| `agenticTask`         | 0.04   | "run", "test", "fix", "deploy", "edit"   |
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

Parameters (router-core `classifier`):

- `confidenceSteepness = 12` — steepness of the sigmoid curve
- `confidenceThreshold = 0.7` — below this the request is ambiguous and lands on `overrides.ambiguousDefaultTier` (MEDIUM)

Tier boundaries on the weighted-score axis: `mediumComplex = 0.3`, `complexReasoning = 0.5`.

### Override Thresholds

```yaml
routing:
  classifier:
    # Require higher confidence for tier assignment
    confidenceThreshold: 0.8 # Default: 0.7
```

---

## Spend Control & Counterparty Policy

Amount caps bound **how much** the agent may pay. Counterparty policy bounds
**whom** it may pay, and on which network and asset. Both are evaluated before
the wallet signs anything: a refusal aborts the payment at the x402 pre-sign
hook, so no authorization is ever produced.

Everything here is **off by default**. An unconfigured list is not consulted.

State lives in `~/.openclaw/blockrun/spending.json` (mode 0600), read once at
proxy startup — **edit it, then restart the proxy** for changes to take effect.

```json
{
  "limits": {
    "perRequest": 0.05,
    "hourly": 2.0,
    "daily": 20.0,
    "session": 5.0,
    "allowedPayees": ["0x1111111111111111111111111111111111111111"],
    "blockedPayees": ["0x2222222222222222222222222222222222222222"],
    "allowedNetworks": ["eip155:8453"],
    "allowedAssets": ["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"]
  },
  "history": []
}
```

| Field                                         | Meaning                                                                            |
| --------------------------------------------- | ---------------------------------------------------------------------------------- |
| `perRequest` / `hourly` / `daily` / `session` | USD caps. Rolling 1h and 24h windows; session resets on restart.                   |
| `allowedPayees`                               | Only these `payTo` addresses may be paid.                                          |
| `blockedPayees`                               | These may never be paid. **Wins over `allowedPayees`** when an address is on both. |
| `allowedNetworks`                             | CAIP-2 ids only.                                                                   |
| `allowedAssets`                               | Token contract addresses of the asset being paid in.                               |

**Networks are CAIP-2, not nicknames.** `base` does not match `eip155:8453`
and fails closed. Use `eip155:8453` for Base and
`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d` for Solana mainnet; both
are exported as `CAIP2_BASE` and `CAIP2_SOLANA_MAINNET`.

EVM addresses in `allowedPayees`, `blockedPayees` and `allowedAssets` are
compared case-insensitively, so checksummed and lowercase forms both match.
Solana base58 addresses are case-sensitive and compared exactly.

### Fail-closed behavior

- A configured list with **no matching value on the payment** refuses, rather
  than skipping the check.
- A payment quote whose amount is not a canonical decimal integer refuses
  whenever an amount cap is set. (`parseInt` and the signer's `BigInt` disagree
  on `0x`-style values, so an unparseable quote is never treated as $0.)
- A **malformed** policy list in `spending.json` refuses every paid request
  until the file is repaired. The proxy still starts and free models keep
  working; the error names the offending field. An empty array (`[]`) is not
  malformed — it means "not configured", and is how you clear a list by hand.

### Programmatic use

```ts
import { SpendControl, registerSpendPolicyHook, CAIP2_BASE } from "@blockrun/clawrouter";

const control = new SpendControl();
control.setLimit("daily", 20);
control.setPolicy("allowedNetworks", [CAIP2_BASE]);

// startProxy does this for you; only needed on your own x402 client.
registerSpendPolicyHook(x402, control);
```

A refusal reaches the caller as HTTP 403 with
`{"error": {"type": "spend_policy_denied", ...}}`. It is deliberately **not**
retried against other models: a policy denial is a decision, not an outage.

**Scope:** this governs payments made by the proxy. Local tools that sign with
the same wallet outside the proxy's x402 client (Polymarket funding and order
placement, `clawrouter doctor`'s probe) are not covered.

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

# Proxy end-to-end smoke (mock upstream, no wallet needed)
npm run test:e2e

# Proxy reuse tests
npx tsx test/proxy-reuse.ts

# Live e2e with payments (requires funded wallet)
BLOCKRUN_WALLET_KEY=0x... npm run test:e2e

# Optional slower/costlier live coverage
CLAWROUTER_E2E_FULL=1 BLOCKRUN_WALLET_KEY=0x... npm run test:e2e
RUN_IMAGE_TEST=1 BLOCKRUN_WALLET_KEY=0x... npm run test:e2e
RUN_MUSIC_TEST=1 BLOCKRUN_WALLET_KEY=0x... npm run test:e2e
```
