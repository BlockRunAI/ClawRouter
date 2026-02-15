# Advanced Features

ClawRouter v0.5+ includes intelligent routing features that work automatically.

## Table of Contents

- [Agentic Auto-Detection](#agentic-auto-detection)
- [Tool Detection](#tool-detection)
- [Context-Length-Aware Routing](#context-length-aware-routing)
- [Model Aliases](#model-aliases)
- [Free Tier Fallback](#free-tier-fallback)
- [Session Persistence](#session-persistence)
- [Cost Tracking with /stats](#cost-tracking-with-stats)

---

## Agentic Auto-Detection

ClawRouter automatically detects multi-step agentic tasks and routes to models optimized for autonomous execution:

```
"what is 2+2"                    → gemini-flash (standard)
"build the project then run tests" → kimi-k2.5 (auto-agentic)
"fix the bug and make sure it works" → kimi-k2.5 (auto-agentic)
```

**How it works:**

- Detects agentic keywords: file ops ("read", "edit"), execution ("run", "test", "deploy"), iteration ("fix", "debug", "verify")
- Threshold: 2+ signals triggers auto-switch to agentic tiers
- No config needed — works automatically

**Agentic tier models** (optimized for multi-step autonomy):

| Tier      | Agentic Model    | Why                            |
| --------- | ---------------- | ------------------------------ |
| SIMPLE    | claude-haiku-4.5 | Fast + reliable tool use       |
| MEDIUM    | kimi-k2.5        | 200+ tool chains, 76% cheaper  |
| COMPLEX   | claude-sonnet-4  | Best balance for complex tasks |
| REASONING | kimi-k2.5        | Extended reasoning + execution |

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

When your request includes a `tools` array (function calling), ClawRouter automatically switches to agentic tiers:

```typescript
// Request with tools → auto-agentic mode
{
  model: "blockrun/auto",
  messages: [{ role: "user", content: "Check the weather" }],
  tools: [{ type: "function", function: { name: "get_weather", ... } }]
}
// → Routes to claude-haiku-4.5 (excellent tool use)
// → Instead of gemini-flash (may produce malformed tool calls)
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
/model free      # gpt-oss-120b (FREE!)
/model br-sonnet # anthropic/claude-sonnet-4
/model br-opus   # anthropic/claude-opus-4
/model br-haiku  # anthropic/claude-haiku-4.5
/model gpt       # openai/gpt-4o
/model gpt5      # openai/gpt-5.2
/model deepseek  # deepseek/deepseek-chat
/model reasoner  # deepseek/deepseek-reasoner
/model kimi      # moonshot/kimi-k2.5
/model gemini    # google/gemini-2.5-pro
/model flash     # google/gemini-2.5-flash
/model grok      # xai/grok-3
/model grok-fast # xai/grok-4-fast-reasoning
```

All aliases work with `/model blockrun/xxx` or just `/model xxx`.

---

## Free Tier Fallback

When your wallet balance hits $0, ClawRouter automatically falls back to the free model (`gpt-oss-120b`):

```
Wallet: $0.00
Request: "Help me write a function"
→ Routes to gpt-oss-120b (FREE)
→ No "insufficient funds" error
→ Keep building while you top up
```

You'll never get blocked by an empty wallet — the free tier keeps you running.

---

## Session Persistence

For multi-turn conversations, ClawRouter pins the model to prevent mid-task switching:

```
Turn 1: "Build a React component" → claude-sonnet-4
Turn 2: "Add dark mode support"   → claude-sonnet-4 (pinned)
Turn 3: "Now add tests"           → claude-sonnet-4 (pinned)
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
