# Routing Profiles & Pricing

ClawRouter offers four routing profiles to balance cost vs quality. Prices are in **$/M tokens** (input/output). Tables show each tier's **primary** model — every tier also carries a benchmark-ordered fallback chain (see `src/router/config.ts`).

## ECO (Absolute Cheapest)

Use `blockrun/eco` for maximum cost savings.

| Tier      | Primary Model                | Input | Output |
| --------- | ---------------------------- | ----- | ------ |
| SIMPLE    | free/gpt-oss-120b            | $0.00 | $0.00  |
| MEDIUM    | google/gemini-3.1-flash-lite | $0.25 | $1.50  |
| COMPLEX   | google/gemini-3.1-flash-lite | $0.25 | $1.50  |
| REASONING | xai/grok-4-1-fast-reasoning  | $0.20 | $0.50  |

---

## AUTO (Balanced - Default)

Use `blockrun/auto` for the best quality/price balance.

| Tier      | Primary Model               | Input | Output |
| --------- | --------------------------- | ----- | ------ |
| SIMPLE    | google/gemini-2.5-flash     | $0.30 | $2.50  |
| MEDIUM    | moonshot/kimi-k2.6          | $0.95 | $4.00  |
| COMPLEX   | google/gemini-3.1-pro       | $2.00 | $12.00 |
| REASONING | xai/grok-4-1-fast-reasoning | $0.20 | $0.50  |

---

## PREMIUM (Best Quality)

Use `blockrun/premium` for maximum quality.

| Tier      | Primary Model        | Input  | Output |
| --------- | -------------------- | ------ | ------ |
| SIMPLE    | moonshot/kimi-k2.6   | $0.95  | $4.00  |
| MEDIUM    | openai/gpt-5.3-codex | $1.75  | $14.00 |
| COMPLEX   | claude-fable-5       | $10.00 | $50.00 |
| REASONING | claude-sonnet-4.6    | $3.00  | $15.00 |

---

## AGENTIC (Multi-Step Tasks)

ClawRouter auto-detects agentic patterns (tool use, multi-step autonomy) and switches to agent-tuned primaries.

| Tier      | Primary Model      | Input | Output |
| --------- | ------------------ | ----- | ------ |
| SIMPLE    | openai/gpt-4o-mini | $0.15 | $0.60  |
| MEDIUM    | moonshot/kimi-k2.6 | $0.95 | $4.00  |
| COMPLEX   | claude-sonnet-4.6  | $3.00 | $15.00 |
| REASONING | claude-sonnet-4.6  | $3.00 | $15.00 |

---

## ECO vs AUTO Savings

Combined input + output rate per 1M tokens:

| Tier      | ECO   | AUTO   | Savings  |
| --------- | ----- | ------ | -------- |
| SIMPLE    | FREE  | $2.80  | **100%** |
| MEDIUM    | $1.75 | $4.95  | **65%**  |
| COMPLEX   | $1.75 | $14.00 | **88%**  |
| REASONING | $0.70 | $0.70  | 0%       |

---

## How Tiers Work

ClawRouter automatically classifies your query into one of four tiers:

- **SIMPLE**: Basic questions, short responses, simple lookups
- **MEDIUM**: Code generation, moderate complexity tasks
- **COMPLEX**: Large context, multi-step reasoning, complex code
- **REASONING**: Logic puzzles, math, chain-of-thought tasks

The router picks the cheapest model capable of handling your query's tier.

There is also a `blockrun/free` pin that routes exclusively across the free NVIDIA-hosted fleet (gpt-oss-120b default) — no USDC required.

---

_Last updated: v0.12.201_
