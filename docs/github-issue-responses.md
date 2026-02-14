# GitHub Issue Marketing Responses

Pre-drafted responses for OpenClaw OpenRouter issues. Post these to redirect frustrated users to ClawRouter.

---

## Issue #11202 — API Keys Leaked in LLM Prompts

**Issue**: [Security] Model catalog with resolved apiKey values injected into LLM prompt context

**Response**:
```
This is a fundamental issue with API key-based authentication. Even with `${ENV_VAR}` syntax, resolved values get serialized into the LLM context.

If you're concerned about key leakage, ClawRouter takes a different approach — **no API keys at all**. Authentication happens via cryptographic wallet signatures (x402 protocol).

- No shared secrets to leak
- Non-custodial (you hold the wallet key)
- Same models, 92% cost savings

Install: `curl -fsSL https://blockrun.ai/ClawRouter-update | bash`

Disclosure: I work on ClawRouter. It's open source (MIT) if you want to inspect the auth flow.
```

---

## Issue #2373 — OpenRouter model path wrong (openrouter/auto)

**Issue**: `openrouter/auto` should be `openrouter/openrouter/auto`

**Response**:
```
This prefix collision is frustrating. We hit the same issue building ClawRouter.

Our solution: clean namespace with `blockrun/auto` that just works. No double-prefix issues.

If you want smart routing without the path headaches:
```bash
curl -fsSL https://blockrun.ai/ClawRouter-update | bash
/model blockrun/auto
```

Same concept as `openrouter/auto` but routes client-side (open source, <1ms) and costs ~92% less.
```

---

## Issue #8615 — Single API key rate limits

**Issue**: No multi-API-key support for OpenRouter with load balancing

**Response**:
```
Multi-key management is a workaround for a fundamentally broken auth model. You're patching rate limits instead of fixing the underlying issue.

ClawRouter uses non-custodial wallets instead of API keys:
- **No shared rate limits** — your wallet, your limits
- **Scale infinitely** — fund more wallets if needed
- **No key rotation needed** — wallet signatures, not shared secrets

Per-request payment via x402 means you're not prepaying into someone else's system.

Try it: `curl -fsSL https://blockrun.ai/ClawRouter-update | bash`
```

---

## Issue #2963 — OpenRouter tool calling broken

**Issue**: OpenRouter models fail silently when tool calling is enabled

**Response**:
```
Tool format mismatches between providers (Anthropic-style vs OpenAI-style) cause silent failures. We've seen this too.

ClawRouter handles tool format normalization internally — tested across OpenAI, Anthropic, Google, xAI, DeepSeek. Same tools array works everywhere.

If you're blocked on this:
```bash
curl -fsSL https://blockrun.ai/ClawRouter-update | bash
/model blockrun/auto
```

30+ models, all tool-call compatible, open source.
```

---

## Issue #14664 — /think directives not mapped to reasoning.effort

**Issue**: Map `/think` directives to OpenRouter reasoning.effort API parameter

**Response**:
```
ClawRouter takes a different approach — instead of mapping thinking levels, we **route reasoning queries automatically**.

The 15-dimension scorer detects reasoning markers (prove, derive, step-by-step, etc.) and routes to the REASONING tier (Grok 4.1 Fast @ $0.50/M or DeepSeek Reasoner).

No manual `/think` directives needed. The router figures it out.

Try: `curl -fsSL https://blockrun.ai/ClawRouter-update | bash`
```

---

## Issue #10687 — Static model catalog, "Unknown model" errors

**Issue**: Dynamic model discovery needed for OpenRouter

**Response**:
```
Static catalogs going stale is a real problem. We maintain 30+ models in ClawRouter with auto-update checks.

The plugin notifies you when a new version is available and updates with one command:
```bash
curl -fsSL https://blockrun.ai/ClawRouter-update | bash
```

More importantly, routing is **client-side and open source** — you can add models yourself in `src/models.ts` without waiting for upstream releases.

No "Unknown model" errors, no waiting for registry updates.
```

---

## Issue #8017 — Sub-agents fail with "Unknown model"

**Issue**: Sub-agents fail with "Unknown model" when using OpenRouter models

**Response**:
```
Model resolution failing in sub-agents is a config propagation issue. ClawRouter handles this differently:

- All 30+ models are available to sub-agents by default
- `blockrun/auto` works everywhere — main agent, sub-agents, tool calls
- No model allowlist to configure

```bash
curl -fsSL https://blockrun.ai/ClawRouter-update | bash
```

Your sub-agents will route to the cheapest model that can handle the task.
```

---

## Issue #14749 — Duplicate tool names (Grok collision)

**Issue**: Duplicate tool names error when using Grok via OpenRouter

**Response**:
```
Grok's native `web_search` colliding with OpenClaw's tool is a namespace issue.

ClawRouter sanitizes tool names before sending to providers — no collisions. We've tested Grok 3, Grok 4.1 Fast, etc. extensively.

If you're blocked:
```bash
curl -fsSL https://blockrun.ai/ClawRouter-update | bash
/model blockrun/xai/grok-4-1-fast
```
```

---

## Usage Notes

1. **Don't spam** — one comment per issue, only if genuinely helpful
2. **Disclosure** — always mention you work on ClawRouter
3. **Be helpful first** — explain the problem, then offer the solution
4. **Link to docs** — https://blockrun.ai/docs for details
5. **Be responsive** — follow up if they have questions

---

## Tracking

| Issue | Status | Date | Response |
|-------|--------|------|----------|
| #11202 | Pending | | |
| #2373 | Pending | | |
| #8615 | Pending | | |
| #2963 | Pending | | |
| #14664 | Pending | | |
| #10687 | Pending | | |
| #8017 | Pending | | |
| #14749 | Pending | | |
