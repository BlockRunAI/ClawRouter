---
name: clawrouter
description: Smart LLM router — save 78% on inference costs. Routes every request to the cheapest capable model across 30+ models from OpenAI, Anthropic, Google, DeepSeek, and xAI.
homepage: https://github.com/BlockRunAI/ClawRouter
metadata: { "openclaw": { "emoji": "🦀", "requires": { "config": ["models.providers.blockrun"] } } }
---

# ClawRouter

Smart LLM router that saves 78% on inference costs by routing each request to the cheapest model that can handle it. 30+ models across 5 providers, all through one wallet.

## Install

```bash
openclaw plugins install @blockrun/clawrouter
```

## Setup

```bash
# Enable smart routing (auto-picks cheapest model per request)
openclaw models set blockrun/auto

# Or pin a specific model
openclaw models set openai/gpt-4o
```

## How Routing Works

ClawRouter classifies each request into one of four tiers:

- **SIMPLE** (40% of traffic) — factual lookups, greetings, translations → Gemini Flash ($0.60/M, 99% savings)
- **MEDIUM** (30%) — summaries, explanations, data extraction → DeepSeek Chat ($0.42/M, 99% savings)
- **COMPLEX** (20%) — code generation, multi-step analysis → Claude Opus ($75/M, best quality)
- **REASONING** (10%) — proofs, formal logic, multi-step math → o3 ($8/M, 89% savings)

Rules handle ~80% of requests in <1ms. Only ambiguous queries hit the LLM classifier (~$0.00003 per classification).

## Available Models

30+ models including: gpt-5.2, gpt-4o, gpt-4o-mini, o3, o4-mini, claude-opus-4.5, claude-sonnet-4, claude-haiku-4.5, gemini-2.5-pro, gemini-2.5-flash, deepseek-chat, deepseek-reasoner, grok-3, grok-3-mini.

## Example Output

```
[ClawRouter] google/gemini-2.5-flash (SIMPLE, rules, confidence=0.92)
             Cost: $0.0025 | Baseline: $0.308 | Saved: 99.2%
```
