# Anthropic Is Cutting Off Third-Party Harnesses. Here's What You Can Do.

Starting April 4, 2026, Anthropic will no longer allow Claude subscription limits to cover third-party harnesses like OpenClaw. If you've been using your Claude Pro/Team subscription to power autonomous agents, code assistants, or any tool outside of Anthropic's own products — that stops tomorrow.

## What Changed

Anthropic sent this to affected users:

> Starting April 4 at 12pm PT, you'll no longer be able to use your Claude subscription limits for third-party harnesses including OpenClaw. To keep using third-party harnesses with your Claude login, turn on extra usage — a pay-as-you-go option billed separately from your subscription.

Translation: your $20/month Claude Pro subscription now only covers claude.ai, Claude Code, and Claude Cowork. Everything else requires "extra usage" — Anthropic's pay-as-you-go billing with no spending cap by default.

They're offering a one-time credit equal to your subscription price (redeemable by April 17) and up to 30% off on prepaid bundles. That softens the blow, but doesn't change the fundamental shift: **third-party agent usage is now metered separately, at full API rates.**

## Why This Matters

If you're running agents through OpenClaw, Continue.dev, or any third-party harness, your costs are about to change dramatically:

- **Claude Sonnet 4.6**: $3/M input, $15/M output tokens
- **Claude Opus 4.6**: $15/M input, $75/M output tokens

An agent session that sends 50 requests averaging 4K tokens each? That's roughly $3–15 per session on Sonnet, $15–75 on Opus. Run a few sessions a day and you're looking at $100–500+/month — far more than the $20 subscription you were paying.

## The Alternative: Stop Overpaying for Every Request

Here's the thing most people don't realize: **~70% of agent requests don't need Claude at all.**

Status checks, JSON extraction, simple Q&A, code formatting, translation — these tasks get routed to Claude Opus at $75/M output tokens when a free model or Gemini Flash at $0.40/M would produce identical results.

This is exactly the problem [ClawRouter](https://github.com/BlockRunAI/ClawRouter) solves.

## ClawRouter: Smart Routing for Agents

ClawRouter is an open-source local proxy that sits between your agent and <!-- br:models.chatVisible -->73<!-- /br:models.chatVisible --> LLM models across 9 providers. It analyzes every request across 15 dimensions and routes it to the cheapest model that can handle it — in under 1ms, entirely locally.

```
Your Agent → ClawRouter (localhost:8402) → Best model for the job

SIMPLE  ("what is X?")          → Free model         $0.00
MEDIUM  ("review this code")    → Kimi-K2.5           $0.002
COMPLEX ("refactor this OAuth") → Claude Sonnet 4.6   $0.009
REASONING ("prove this theorem")→ Grok-4-Reasoning    $0.001
```

Claude is still there when you need it — for complex reasoning, nuanced code review, architectural decisions. But it's not wasted on tasks a smaller model handles equally well.

### Real Numbers

From 20,000+ production requests:

| Where requests actually go       | % of traffic | Cost per M tokens |
| -------------------------------- | ------------ | ----------------- |
| Gemini Flash Lite (simple tasks) | 34.5%        | $0.10 / $0.40     |
| Claude Sonnet (complex only)     | 22.7%        | $3.00 / $15.00    |
| Kimi-K2.5 (medium tasks)         | 16.2%        | $0.60 / $3.00     |
| Free models (trivial tasks)      | 12.8%        | $0.00             |
| Others                           | 13.8%        | varies            |

**Result: <!-- br:savings.autoVsBaselinePct -->88<!-- /br:savings.autoVsBaselinePct -->% cheaper than pinning Claude Opus 5 for every request** — the published figure, priced on a stated workload mix rather than estimated.

A typical user running 10K mixed requests/month:

- Direct Claude Sonnet: ~$105/month
- Direct Claude Opus: ~$175/month
- **ClawRouter: ~$20/month**

### How It Works

```bash
npx @blockrun/clawrouter    # Install and start (generates wallet automatically)
```

Then point your agent at `http://localhost:8402/v1/` with any OpenAI-compatible client. That's it.

- **No API keys to manage** — wallet-based cryptographic auth
- **No subscriptions** — pay per request in USDC (Base or Solana)
- **No vendor lock-in** — <!-- br:models.chatVisible -->73<!-- /br:models.chatVisible --> models, switch anytime
- **You control your wallet** — non-custodial, funds never held by a third party
- **Budget caps** — set a max spend per session, ClawRouter gracefully downgrades when budget runs low
- **Token compression** — 7-layer pipeline reduces token costs by 7–40% before they hit any provider
- **Response caching** — identical requests within 10 minutes cost $0
- **<!-- br:models.free -->7<!-- /br:models.free --> free models** — for tasks that don't need a paid model at all

### Routing Profiles

| Profile   | Strategy                | Savings | Command          |
| --------- | ----------------------- | ------- | ---------------- |
| `auto`    | Balanced cost + quality | 74–100% | `/model auto`    |
| `eco`     | Maximum savings         | 95–100% | `/model eco`     |
| `premium` | Best quality always     | 0%      | `/model premium` |
| `free`    | Free models only        | 100%    | `/model free`    |

## The Bottom Line

Anthropic's change isn't surprising — they need to manage capacity, and third-party harnesses were consuming disproportionate resources relative to subscription revenue. It's a reasonable business decision.

But it means the economics of running agents just changed. If you're paying API rates for every request, the cost adds up fast. Smart routing — sending each request to the cheapest model that can handle it — is no longer a nice-to-have. It's the difference between a $20/month AI workflow and a $200/month one.

ClawRouter is open source, runs locally, and takes 30 seconds to set up:

```bash
npx @blockrun/clawrouter
```

Your agents keep working. Your costs stay under control. Claude is still there when you actually need it.

---

_ClawRouter is built by [BlockRun](https://blockrun.ai). Source code: [github.com/BlockRunAI/ClawRouter](https://github.com/BlockRunAI/ClawRouter)_
