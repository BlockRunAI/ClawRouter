# Architecture

Technical deep-dive into ClawRouter's internals.

## Table of Contents

- [System Overview](#system-overview)
- [Request Flow](#request-flow)
- [Routing Engine](#routing-engine)
- [Payment System](#payment-system)
- [Optimizations](#optimizations)
- [Source Structure](#source-structure)

---

## System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     OpenClaw / Your App                     │
│                   (OpenAI-compatible client)                │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                 ClawRouter Proxy (localhost)                │
│  ┌─────────────┐  ┌─────────────┐  ┌───────────────────┐   │
│  │   Dedup     │→ │   Router    │→ │   x402 Payment    │   │
│  │   Cache     │  │  (14-dim)   │  │   (EIP-712 USDC)  │   │
│  └─────────────┘  └─────────────┘  └───────────────────┘   │
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌───────────────────┐   │
│  │  Fallback   │  │   Balance   │  │   SSE Heartbeat   │   │
│  │   Chain     │  │   Monitor   │  │   (streaming)     │   │
│  └─────────────┘  └─────────────┘  └───────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      BlockRun API                           │
│    402 → Sign Payment → Retry → OpenAI/Anthropic/Google    │
└─────────────────────────────────────────────────────────────┘
```

**Key Principles:**

- **100% local routing** — No API calls for model selection
- **Client-side only** — Your wallet key never leaves your machine
- **Non-custodial** — USDC stays in your wallet until spent

---

## Request Flow

### 1. Request Received

```
POST /v1/chat/completions
{
  "model": "blockrun/auto",
  "messages": [{ "role": "user", "content": "What is 2+2?" }],
  "stream": true
}
```

### 2. Deduplication Check

```typescript
// SHA-256 hash of request body
const dedupKey = RequestDeduplicator.hash(body);

// Check completed cache (30s TTL)
const cached = deduplicator.getCached(dedupKey);
if (cached) {
  return cached; // Replay cached response
}

// Check in-flight requests
const inflight = deduplicator.getInflight(dedupKey);
if (inflight) {
  return await inflight; // Wait for original to complete
}
```

### 3. Smart Routing (if model is `blockrun/auto`)

```typescript
// Extract user's last message
const prompt = messages.findLast((m) => m.role === "user")?.content;

// Run 14-dimension weighted scorer
const decision = route(prompt, systemPrompt, maxTokens, {
  config: DEFAULT_ROUTING_CONFIG,
  modelPricing,
});

// decision = {
//   model: "google/gemini-2.5-flash",
//   tier: "SIMPLE",
//   confidence: 0.92,
//   savings: 0.99,
//   costEstimate: 0.0012,
// }
```

### 4. Balance Check

```typescript
const estimated = estimateAmount(modelId, bodyLength, maxTokens);
const sufficiency = await balanceMonitor.checkSufficient(estimated);

if (sufficiency.info.isEmpty) {
  throw new EmptyWalletError(walletAddress);
}

if (!sufficiency.sufficient) {
  throw new InsufficientFundsError({ ... });
}

if (sufficiency.info.isLow) {
  onLowBalance({ balanceUSD, walletAddress });
}
```

### 5. SSE Heartbeat (for streaming)

```typescript
if (isStreaming) {
  // Send 200 + headers immediately
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });

  // Heartbeat every 2s to prevent timeout
  heartbeatInterval = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 2000);
}
```

### 6. x402 Payment Flow

```
1. Request → BlockRun API
2. ← 402 Payment Required
   {
     "x402Version": 1,
     "accepts": [{
       "scheme": "exact",
       "network": "base",
       "maxAmountRequired": "5000",  // $0.005
       "resource": "https://blockrun.ai/api/v1/chat/completions",
       "payTo": "0x..."
     }]
   }
3. Sign EIP-712 typed data with wallet key
4. Retry with X-PAYMENT header
5. ← 200 OK with response
```

### 7. Fallback Chain (on provider errors)

```typescript
const FALLBACK_STATUS_CODES = [400, 401, 402, 403, 429, 500, 502, 503, 504];

for (const model of fallbackChain) {
  const result = await tryModelRequest(model, ...);

  if (result.success) {
    return result.response;
  }

  if (result.isProviderError && !isLastAttempt) {
    console.log(`Fallback: ${model} → next`);
    continue;
  }

  break;
}
```

### 8. Response Streaming

```typescript
// Convert non-streaming JSON to SSE format
// (BlockRun API returns JSON, we simulate SSE)

// Chunk 1: role
data: {"id":"...","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant"}}]}

// Chunk 2: content
data: {"id":"...","object":"chat.completion.chunk","choices":[{"delta":{"content":"4"}}]}

// Chunk 3: finish
data: {"id":"...","object":"chat.completion.chunk","choices":[{"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

---

## Routing Engine

### Weighted Scorer

The routing engine uses a 14-dimension weighted scorer that runs entirely locally:

```typescript
function classifyByRules(
  prompt: string,
  systemPrompt: string | undefined,
  tokenCount: number,
  config: ScoringConfig,
): ClassificationResult {
  let score = 0;
  const signals: string[] = [];

  // Dimension 1: Reasoning markers (weight: 0.18)
  const reasoningCount = countKeywords(prompt, config.reasoningKeywords);
  if (reasoningCount >= 2) {
    score += 0.18 * 2; // Double weight for multiple markers
    signals.push("reasoning");
  }

  // Dimension 2: Code presence (weight: 0.15)
  if (hasCodeBlock(prompt) || countKeywords(prompt, config.codeKeywords) > 0) {
    score += 0.15;
    signals.push("code");
  }

  // ... 12 more dimensions

  // Sigmoid calibration
  const confidence = sigmoid(score, (k = 8), (midpoint = 0.5));

  return { score, confidence, tier: selectTier(score, confidence), signals };
}
```

### Tier Selection

```typescript
function selectTier(score: number, confidence: number): Tier | null {
  // Special case: 2+ reasoning markers → REASONING at high confidence
  if (signals.includes("reasoning") && reasoningCount >= 2) {
    return "REASONING";
  }

  if (confidence < 0.7) {
    return null; // Ambiguous → default to MEDIUM
  }

  if (score < 0.3) return "SIMPLE";
  if (score < 0.6) return "MEDIUM";
  if (score < 0.8) return "COMPLEX";
  return "REASONING";
}
```

### Overrides

Certain conditions force tier assignment:

```typescript
// Large context → COMPLEX
if (tokenCount > 100000) {
  return { tier: "COMPLEX", method: "override:large_context" };
}

// Structured output (JSON/YAML) → min MEDIUM
if (systemPrompt?.includes("json") || systemPrompt?.includes("yaml")) {
  return { tier: Math.max(tier, "MEDIUM"), method: "override:structured" };
}
```

---

## Payment System

### x402 Protocol

ClawRouter uses the [x402 protocol](https://x402.org) for micropayments:

```
┌────────────┐     ┌────────────┐     ┌────────────┐
│   Client   │────▶│  BlockRun  │────▶│  Provider  │
│ (ClawRouter)     │    API     │     │ (OpenAI)   │
└────────────┘     └────────────┘     └────────────┘
      │                  │
      │ 1. Request       │
      │─────────────────▶│
      │                  │
      │ 2. 402 + price   │
      │◀─────────────────│
      │                  │
      │ 3. Sign payment  │
      │ (EIP-712 USDC)   │
      │                  │
      │ 4. Retry + sig   │
      │─────────────────▶│
      │                  │
      │ 5. Response      │
      │◀─────────────────│
```

### EIP-712 Signing

```typescript
const typedData = {
  types: {
    Payment: [
      { name: "scheme", type: "string" },
      { name: "network", type: "string" },
      { name: "amount", type: "uint256" },
      { name: "resource", type: "string" },
      { name: "payTo", type: "address" },
      { name: "nonce", type: "uint256" },
    ],
  },
  primaryType: "Payment",
  domain: { name: "x402", version: "1" },
  message: {
    scheme: "exact",
    network: "base",
    amount: "5000", // 0.005 USDC (6 decimals)
    resource: "https://blockrun.ai/api/v1/chat/completions",
    payTo: "0x...",
    nonce: Date.now(),
  },
};

const signature = await account.signTypedData(typedData);
```

### Pre-Authorization

To skip the 402 round trip:

```typescript
// Estimate cost before request
const estimated = estimateAmount(modelId, bodyLength, maxTokens);

// Pre-sign payment with estimate (+ 20% buffer)
const preAuth: PreAuthParams = { estimatedAmount: estimated };

// Request with pre-signed payment
const response = await payFetch(url, init, preAuth);
```

---

## Optimizations

### 1. Request Deduplication

Prevents double-charging when clients retry after timeout:

```typescript
class RequestDeduplicator {
  private cache = new Map<string, CachedResponse>();
  private inflight = new Map<string, Promise<CachedResponse>>();
  private TTL_MS = 30_000;

  static hash(body: Buffer): string {
    return createHash("sha256").update(body).digest("hex");
  }

  getCached(key: string): CachedResponse | undefined {
    const entry = this.cache.get(key);
    if (entry && Date.now() - entry.completedAt < this.TTL_MS) {
      return entry;
    }
    return undefined;
  }
}
```

### 2. SSE Heartbeat

Prevents upstream timeout while waiting for x402 payment:

```
0s:  Request received
0s:  → 200 OK, Content-Type: text/event-stream
0s:  → : heartbeat
2s:  → : heartbeat  (client stays connected)
4s:  → : heartbeat
5s:  x402 payment completes
5s:  → data: {"choices":[...]}
5s:  → data: [DONE]
```

### 3. Balance Caching

Avoids RPC calls on every request:

```typescript
class BalanceMonitor {
  private cachedBalance: bigint | undefined;
  private cacheTime = 0;
  private CACHE_TTL_MS = 60_000; // 1 minute

  async checkBalance(): Promise<BalanceInfo> {
    if (this.cachedBalance !== undefined && Date.now() - this.cacheTime < this.CACHE_TTL_MS) {
      return this.formatBalance(this.cachedBalance);
    }

    // Fetch from Base RPC
    const balance = await this.fetchUSDCBalance();
    this.cachedBalance = balance;
    this.cacheTime = Date.now();
    return this.formatBalance(balance);
  }

  // Optimistic deduction after successful payment
  deductEstimated(amount: bigint): void {
    if (this.cachedBalance !== undefined) {
      this.cachedBalance -= amount;
    }
  }
}
```

### 4. Proxy Reuse

Detects and reuses existing proxy to avoid `EADDRINUSE`:

```typescript
async function startProxy(options: ProxyOptions): Promise<ProxyHandle> {
  const port = options.port ?? getProxyPort();

  // Check if proxy already running
  const existingWallet = await checkExistingProxy(port);
  if (existingWallet) {
    // Return handle that uses existing proxy
    return {
      port,
      baseUrl: `http://127.0.0.1:${port}`,
      walletAddress: existingWallet,
      close: async () => {},  // No-op
    };
  }

  // Start new proxy
  const server = createServer(...);
  server.listen(port, "127.0.0.1");
  // ...
}
```

---

## Source Structure

```
src/
├── index.ts          # Plugin entry, OpenClaw integration
├── proxy.ts          # HTTP proxy server, request handling
├── provider.ts       # OpenClaw provider registration
├── models.ts         # 30+ model definitions with pricing
├── auth.ts           # Wallet key resolution (file → env → generate)
├── x402.ts           # EIP-712 payment signing, @x402/fetch
├── balance.ts        # USDC balance monitoring, caching
├── dedup.ts          # Request deduplication (SHA-256 → cache)
├── payment-cache.ts  # Pre-authorization caching
├── logger.ts         # JSON usage logging to disk
├── errors.ts         # Custom error types
├── retry.ts          # Fetch retry with exponential backoff
├── version.ts        # Version from package.json
└── router/
    ├── index.ts      # route() entry point
    ├── rules.ts      # 14-dimension weighted scorer
    ├── selector.ts   # Tier → model selection + fallback
    ├── config.ts     # Default routing configuration
    └── types.ts      # TypeScript type definitions
```

### Key Files

| File              | Purpose                                               |
| ----------------- | ----------------------------------------------------- |
| `proxy.ts`        | Core request handling, SSE simulation, fallback chain |
| `router/rules.ts` | 14-dimension weighted scorer, multilingual keywords   |
| `x402.ts`         | EIP-712 typed data signing, payment header formatting |
| `balance.ts`      | USDC balance via Base RPC, caching, thresholds        |
| `dedup.ts`        | SHA-256 hashing, 30s response cache                   |
