# ClawRouter vs OpenRouter

OpenRouter is a popular LLM routing service. Here's why ClawRouter is built differently — and why it matters for agents.

## TL;DR

**OpenRouter is built for developers. ClawRouter is built for agents.**

| Aspect | OpenRouter | ClawRouter |
|--------|------------|------------|
| **Setup** | Human creates account, pastes API key | Agent generates wallet, receives funds |
| **Authentication** | API key (shared secret) | Wallet signature (cryptographic) |
| **Payment** | Prepaid balance (custodial) | Per-request USDC (non-custodial) |
| **Routing** | Server-side, proprietary | Client-side, open source, <1ms |
| **Rate limits** | Per-key quotas | None (your wallet, your limits) |
| **Empty balance** | Request fails | Auto-fallback to free tier |

---

## The Problem with API Keys

OpenRouter (and every traditional LLM gateway) uses API keys for authentication. This breaks agent autonomy:

### 1. Key Leakage in LLM Context

**OpenClaw Issue [#11202](https://github.com/openclaw/openclaw/issues/11202)**: API keys configured in `openclaw.json` are resolved and serialized into every LLM request payload. Every provider sees every other provider's keys.

> "OpenRouter sees your NVIDIA key, Anthropic sees your Google key... keys are sent on every turn."

**ClawRouter**: No API keys. Authentication happens via cryptographic wallet signatures. There's nothing to leak because there are no shared secrets.

### 2. Rate Limit Hell

**OpenClaw Issue [#8615](https://github.com/openclaw/openclaw/issues/8615)**: Single API key support means heavy users hit rate limits (429 errors) quickly. Users request multi-key load balancing, but that's just patching a broken model.

**ClawRouter**: Non-custodial wallets. You control your own keys. No shared rate limits. Scale by funding more wallets if needed.

### 3. Setup Friction

**OpenClaw Issues [#16257](https://github.com/openclaw/openclaw/issues/16257), [#16226](https://github.com/openclaw/openclaw/issues/16226)**: Latest installer skips model selection, shows "No auth configured for provider anthropic". Users can't even get started without debugging config.

**ClawRouter**: One-line install. 30+ models auto-configured. No API keys to paste.

### 4. Model Path Collision

**OpenClaw Issue [#2373](https://github.com/openclaw/openclaw/issues/2373)**: `openrouter/auto` is broken because OpenClaw prefixes all OpenRouter models with `openrouter/`, so the actual model becomes `openrouter/openrouter/auto`.

**ClawRouter**: Clean namespace. `blockrun/auto` just works. No prefix collision.

### 5. False Billing Errors

**OpenClaw Issue [#16237](https://github.com/openclaw/openclaw/issues/16237)**: The regex `/\b402\b/` falsely matches normal content (e.g., "402 calories") as a billing error, replacing valid AI responses with error messages.

**ClawRouter**: Native x402 protocol support. Precise error handling. No regex hacks.

### 6. Unknown Model Failures

**OpenClaw Issues [#16277](https://github.com/openclaw/openclaw/issues/16277), [#10687](https://github.com/openclaw/openclaw/issues/10687)**: Static model catalog causes "Unknown model" errors when providers add new models or during sub-agent spawns.

**ClawRouter**: 30+ models pre-configured, auto-updated catalog.

---

## Agent-Native: Why It Matters

Traditional LLM gateways require a human in the loop:

```
Traditional Flow (Human-in-the-loop):
  Human → creates account → gets API key → pastes into config → agent runs

Agent-Native Flow (Fully autonomous):
  Agent → generates wallet → receives USDC → pays per request → runs
```

| Capability | OpenRouter | ClawRouter |
|------------|------------|------------|
| **Account creation** | Requires human | Agent generates wallet |
| **Authentication** | Shared secret (API key) | Cryptographic signature |
| **Payment** | Human prepays balance | Agent pays per request |
| **Funds custody** | They hold your money | You hold your keys |
| **Empty balance** | Request fails | Auto-fallback to free tier |

### The x402 Difference

```
Request → 402 Response (price: $0.003)
       → Agent's wallet signs payment
       → Response delivered

No accounts. No API keys. No human intervention.
```

**Agents can:**
- Spawn with a fresh wallet
- Receive funds programmatically
- Pay for exactly what they use
- Never trust a third party with their funds

---

## Routing: Cloud vs Local

### OpenRouter

- Routing decisions happen on OpenRouter's servers
- You trust their proprietary algorithm
- No visibility into why a model was chosen
- Adds latency for every request

### ClawRouter

- **100% local routing** — 15-dimension weighted scoring runs on YOUR machine
- **<1ms decisions** — no API calls for routing
- **Open source** — inspect the exact scoring logic in [`src/router.ts`](../src/router.ts)
- **Transparent** — see why each model is chosen

---

## Quick Start

Already using OpenRouter? Switch in 60 seconds:

```bash
# 1. Install ClawRouter
curl -fsSL https://blockrun.ai/ClawRouter-update | bash

# 2. Restart gateway
openclaw gateway restart

# 3. Fund wallet (address shown during install)
# $5 USDC on Base = thousands of requests

# 4. Switch model
/model blockrun/auto
```

Your OpenRouter config stays intact — ClawRouter is additive, not replacement.

---

## Summary

> **OpenRouter**: Built for developers who paste API keys
>
> **ClawRouter**: Built for agents that manage their own wallets

The future of AI isn't humans configuring API keys. It's agents autonomously acquiring and paying for resources.

---

<div align="center">

**Questions?** [Telegram](https://t.me/blockrunAI) · [X](https://x.com/BlockRunAI) · [GitHub](https://github.com/BlockRunAI/ClawRouter)

</div>
