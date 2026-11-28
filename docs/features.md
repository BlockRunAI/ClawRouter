# Advanced Features

ClawRouter v0.5+ includes intelligent routing features that work automatically.

## Table of Contents

- [Response Cache](#response-cache)
- [Agentic Auto-Detection](#agentic-auto-detection)
- [Tool Detection](#tool-detection)
- [Context-Length-Aware Routing](#context-length-aware-routing)
- [Model Aliases](#model-aliases)
- [Free Tier Fallback](#free-tier-fallback)
- [Session Persistence](#session-persistence)
- [Cost Tracking with /stats](#cost-tracking-with-stats)

---

## Response Cache

ClawRouter includes LLM response caching inspired by LiteLLM's caching system. Identical requests return cached responses, saving both cost and latency.

**How it works:**

```
Request: "What is 2+2?"
  First call:  → API ($0.001) → Cache response
  Second call: → Cache HIT → Return instantly ($0)
```

**Features:**

| Feature      | Default     | Description                |
| ------------ | ----------- | -------------------------- |
| TTL          | 10 minutes  | Responses expire after TTL |
| Max size     | 200 entries | LRU eviction when full     |
| Item limit   | 1MB         | Large responses skipped    |
| Auto-enabled | Yes         | No config needed           |

**Cache key generation:**

The cache key is a SHA-256 hash of the request body (model + messages + params), with normalization:

- Message timestamps stripped (OpenClaw injects `[Mon 2024-01-15 10:30 UTC]`)
- Keys sorted for consistent hashing
- Stream mode, user, and request_id fields excluded

**Bypass cache:**

Either way, the request is neither answered from the cache nor stored in it. The separate 30-second dedup cache still applies, so an identical retry inside that window can replay the response.

```typescript
// Via header ("no-store" works too)
fetch("/v1/chat/completions", {
  headers: { "Cache-Control": "no-cache" }
})

// Via body
{
  "model": "blockrun/auto",
  "cache": false,  // or "no_cache": true
  "messages": [...]
}
```

**Check cache stats:**

```bash
curl http://localhost:8402/cache
```

Response:

```json
{
  "size": 42,
  "maxSize": 200,
  "hits": 156,
  "misses": 89,
  "evictions": 3,
  "hitRate": "63.7%"
}
```

**Configuration:**

Response caching is enabled by default with sensible defaults. For advanced tuning, the cache can be configured programmatically:

```typescript
import { ResponseCache } from "@blockrun/clawrouter";

const cache = new ResponseCache({
  maxSize: 500, // Max cached responses
  defaultTTL: 300, // 5 minutes
  maxItemSize: 2_097_152, // 2MB max per item
  enabled: true,
});
```

---

## Agentic Auto-Detection

ClawRouter switches to models optimized for autonomous execution when a turn actually needs its attached tools. On the `auto` profile, router-core 53fe783 picks:

```
"build the project then run tests", no tools attached  → gemini-3.5-flash-lite (auto SIMPLE)
"build the project then run tests", a bash tool        → claude-sonnet-5 (agentic SIMPLE)
"Check the weather in Paris", get_weather, tool_choice "auto"     → gemini-3.5-flash-lite (auto SIMPLE)
"Check the weather in Paris", get_weather, tool_choice "required" → claude-sonnet-5 (agentic SIMPLE)
```

**How it works:**

- The switch keys on tool need, not on keywords: router-core's `inferToolRequirement` decides whether this turn has to call one of the attached tools. `tool_choice: "none"` is authoritative, and host tool _descriptions_ alone do not trigger it.
- No config needed — works automatically

**Agentic tier models** (optimized for multi-step autonomy):

| Tier      | Agentic Model   |
| --------- | --------------- |
| SIMPLE    | gpt-4o-mini     |
| MEDIUM    | gpt-5.6-luna    |
| COMPLEX   | claude-sonnet-5 |
| REASONING | claude-sonnet-5 |

Curated primaries from router-core's `DEFAULT_ROUTING_CONFIG.agenticTiers`; full fallback chains in [routing-profiles.md](./routing-profiles.md#agentic-multi-step-tool-use).

### Force Agentic Mode

You can also force agentic mode via config:

```yaml
# openclaw.yaml
plugins:
  - id: "@blockrun/clawrouter"
    config:
      routing:
        overrides:
          agenticMode: true # Always use agentic tiers
```

---

## Tool Detection

When your request includes a `tools` array (function calling) and the turn has to call one, ClawRouter switches to agentic tiers and drops every candidate without tool calling:

```typescript
// Request that must use its tool → agentic tiers
{
  model: "blockrun/auto",
  messages: [{ role: "user", content: "Check the weather in Paris" }],
  tools: [{ type: "function", function: { name: "get_weather", ... } }],
  tool_choice: "required"
}
// → Routes to claude-sonnet-5 (agentic SIMPLE, router-core 53fe783)
// → With tool_choice "auto" the same turn stays on gemini-3.5-flash-lite (auto SIMPLE)
```

**Why this matters:** Some models (like `deepseek-reasoner`) are optimized for chain-of-thought reasoning but can generate malformed tool calls. Tool detection ensures requests with functions go to models proven to handle tool use correctly.

---

## Context-Length-Aware Routing

ClawRouter automatically filters out models that can't handle your context size:

```
150K token request:
  Full chain: [grok-4-fast (131K), deepseek (128K), kimi (262K), gemini (1M)]
  Filtered:   [kimi (262K), gemini (1M)]
  → Skips models that would fail with "context too long" errors
```

This prevents wasted API calls and faster fallback to capable models.

---

## Model Aliases

Use short aliases instead of full model paths:

```bash
/model free      # free/nemotron-3.5-lightning (FREE!)
/model br-sonnet # anthropic/claude-sonnet-5.5; /model sonnet-4.6 pins the older Sonnet
/model opus      # anthropic/claude-opus-5.5; /model opus-5 or opus-4.8 pins an older Opus
/model haiku     # anthropic/claude-haiku-4.5
/model gpt       # openai/gpt-4o
/model gpt5      # openai/gpt-5.6-terra; /model gpt-6-astra, gpt-6-sol, gpt-6-luna for GPT-6
/model deepseek  # deepseek/deepseek-v4.1-flash
/model reasoner  # deepseek/deepseek-reasoner
/model kimi      # moonshot/kimi-k2.7; /model kimi-k3.1-pro for the 1M-ctx flagship
/model glm       # zai/glm-5.3
/model gemini    # google/gemini-3.8-flash
/model flash     # google/gemini-3.5-flash-lite (text only; /model gemini-3.6-flash for images)
/model grok      # xai/grok-4.7; /model grok-4.6 or grok-4.5 pins an older Grok
/model grok-fast # xai/grok-4-1-fast-reasoning
```

All aliases work with `/model blockrun/xxx` or just `/model xxx`.

---

## Free Tier Fallback

When your wallet balance hits $0, ClawRouter automatically falls back to the free model (`nemotron-3.5-lightning`):

```
Wallet: $0.00
Request: "Help me write a function"
→ Routes to nemotron-3.5-lightning (FREE)
→ No "insufficient funds" error
→ Keep building while you top up
```

You'll never get blocked by an empty wallet — the free tier keeps you running.

---

## Session Persistence

For multi-turn conversations, ClawRouter pins the model to prevent mid-task switching:

```
Turn 1: "Build a React component" → claude-sonnet-5.5
Turn 2: "Add dark mode support"   → claude-sonnet-5.5 (pinned)
Turn 3: "Now add tests"           → claude-sonnet-5.5 (pinned)
```

Sessions are identified by conversation ID and persist for 1 hour of inactivity.

---

## Cost Tracking with /stats

Track your savings in real-time:

```bash
# In any OpenClaw conversation
/stats
```

Output:

```
+============================================================+
|              ClawRouter Usage Statistics                   |
+============================================================+
|  Period: last 7 days                                      |
|  Total Requests: 442                                      |
|  Total Cost: $1.73                                       |
|  Baseline Cost (Opus): $20.13                            |
|  Total Saved: $18.40 (91.4%)                             |
+------------------------------------------------------------+
|  Routing by Tier:                                          |
|    SIMPLE     ===========           55.0% (243)            |
|    MEDIUM     ======                30.8% (136)            |
|    COMPLEX    =                      7.2% (32)             |
|    REASONING  =                      7.0% (31)             |
+============================================================+
```

Stats are stored locally at `~/.openclaw/blockrun/logs/` and aggregated on demand.
