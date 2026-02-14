# ClawRouter vs OpenRouter

OpenRouter is a popular LLM routing service. Here's why ClawRouter is built differently — and why it matters for agents.

## TL;DR

| Aspect | OpenRouter | ClawRouter |
|--------|------------|------------|
| **Setup** | Create account, get API key, configure | Generate wallet, fund with USDC, done |
| **Authentication** | API key (shared secret) | Wallet signature (cryptographic) |
| **Payment** | Prepaid balance (custodial) | Per-request USDC (non-custodial) |
| **Routing** | Server-side, proprietary | Client-side, open source, <1ms |
| **Rate limits** | Per-key quotas | None (your wallet, your limits) |
| **Cost** | $25/M (Opus equivalent) | $2.05/M blended average |

---

## The Problems with API Keys

OpenRouter (and every traditional LLM gateway) uses API keys for authentication. This creates several issues:

### 1. Key Leakage in LLM Context

**OpenClaw Issue [#11202](https://github.com/openclaw/openclaw/issues/11202)**: API keys configured in `openclaw.json` are resolved and serialized into every LLM request payload. Every provider sees every other provider's keys.

> "OpenRouter sees your NVIDIA key, Anthropic sees your Google key... keys are sent on every turn."

**ClawRouter solution**: No API keys. Authentication happens via cryptographic wallet signatures. There's nothing to leak because there are no shared secrets.

### 2. Rate Limit Hell

**OpenClaw Issue [#8615](https://github.com/openclaw/openclaw/issues/8615)**: Single API key support means heavy users hit rate limits (429 errors) quickly. Users request multi-key load balancing, but that's just patching a broken model.

**ClawRouter solution**: Non-custodial wallets. You control your own keys. No shared rate limits. Scale by funding more wallets if needed.

### 3. Model Path Confusion

**OpenClaw Issue [#2373](https://github.com/openclaw/openclaw/issues/2373)**: `openrouter/auto` is broken because OpenClaw prefixes all OpenRouter models with `openrouter/`, so the actual model becomes `openrouter/openrouter/auto`.

**ClawRouter solution**: Clean namespace. `blockrun/auto` just works. No prefix collision.

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

```
Request → Weighted Scorer (15 dimensions) → Model Selection → Done
             (runs locally, <1ms)
```

---

## Payment Model

### OpenRouter (Custodial)

1. Create account with email
2. Add payment method
3. Prepay balance into their system
4. They hold your money until spent
5. If they get hacked, your balance is at risk

### ClawRouter (Non-Custodial)

1. Wallet auto-generated locally
2. Fund with USDC on Base (L2)
3. **You hold your funds** — wallet key stays on your machine
4. Pay per request via x402 signatures
5. Never trust a third party with your money

```
Request → 402 (price: $0.003) → wallet signs → response
         ↑                            ↑
    price shown before signing    non-custodial
```

---

## Feature Gaps in OpenRouter Integration

Based on [OpenClaw GitHub issues](https://github.com/openclaw/openclaw/issues?q=openrouter), users are frustrated by:

| Issue | Problem | ClawRouter Status |
|-------|---------|-------------------|
| [#14664](https://github.com/openclaw/openclaw/issues/14664) | `/think` directives not mapped to `reasoning.effort` | Built-in — routes to reasoning tier automatically |
| [#9600](https://github.com/openclaw/openclaw/issues/9600) | Missing `cache_control` for prompt caching | Planned — server-side caching |
| [#10687](https://github.com/openclaw/openclaw/issues/10687) | Static model catalog causes "Unknown model" errors | 30+ models pre-configured, auto-update |
| [#14749](https://github.com/openclaw/openclaw/issues/14749) | Duplicate tool names (Grok collision) | Handled — clean tool namespace |
| [#8017](https://github.com/openclaw/openclaw/issues/8017) | Sub-agents fail with "Unknown model" | Works — all models available to sub-agents |
| [#2963](https://github.com/openclaw/openclaw/issues/2963) | Tool calling broken (responses never arrive) | Works — full tool support across all models |

---

## Cost Comparison

### OpenRouter Pricing (typical usage)

- Claude Opus 4.5: $15/$75 per M tokens
- GPT-4o: $2.50/$10 per M tokens
- Gemini Pro: $1.25/$5 per M tokens

### ClawRouter Smart Routing

| Tier | Model | Cost/M | % of Traffic |
|------|-------|--------|--------------|
| SIMPLE | nvidia/kimi-k2.5 | $0.001 | ~45% |
| MEDIUM | grok-code-fast-1 | $1.50 | ~35% |
| COMPLEX | gemini-2.5-pro | $10.00 | ~15% |
| REASONING | grok-4.1-fast | $0.50 | ~5% |
| **Blended** | | **$2.05/M** | |

**92% savings** compared to using Opus for everything.

---

## Quick Comparison

### Setup Time

**OpenRouter**: ~5 minutes
1. Go to openrouter.ai
2. Create account
3. Add payment method
4. Generate API key
5. Configure in OpenClaw
6. Debug model path issues

**ClawRouter**: ~2 minutes
```bash
curl -fsSL https://blockrun.ai/ClawRouter-update | bash
openclaw gateway restart
# Fund wallet address printed during install
```

### When Wallet is Empty

**OpenRouter**: Requests fail with 402/insufficient balance errors

**ClawRouter**: Automatic fallback to free tier (`gpt-oss-120b`) — keeps working

---

## Migration Guide

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

| If you want... | Use |
|----------------|-----|
| API key management, prepaid balance | OpenRouter |
| Non-custodial, open source, 92% savings | ClawRouter |

**ClawRouter is built for agents** — they shouldn't need a human to create accounts and paste API keys. They should generate a wallet, receive funds, and pay per request programmatically.

---

<div align="center">

**Questions?** [Telegram](https://t.me/blockrunAI) · [X](https://x.com/BlockRunAI) · [GitHub](https://github.com/BlockRunAI/ClawRouter)

</div>
