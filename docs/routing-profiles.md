# Routing Profiles & Pricing

ClawRouter offers four routing profiles to balance cost vs quality. Prices are in **$/M tokens** (input/output), taken from `src/models.ts` (which mirrors the live BlockRun catalog).

Routing decisions are made by [`@blockrun/router-core`](https://github.com/BlockRunAI/router-core) (Router Core **V3.4**, the constraint-first portfolio router), which ClawRouter inlines at build time and pins by commit SHA. `src/router/index.ts` simply re-exports it. Nothing below calls a network or a second model: classification, eligibility filtering and ranking all run locally in about a quarter of a millisecond.

## How a request is routed

1. **Classify.** A 15-dimension weighted scorer maps the request onto a capability tier — `SIMPLE`, `MEDIUM`, `COMPLEX` or `REASONING` — and a task classifier labels the _shape_ of the work (`chat`, `extraction`, `code_edit`, `code_agent`, `tool_agent`, `tool_agent_parallel`, `debug`, `reasoning`, `reasoning_math`, `long_context`, `vision`, …). Turns that actually need their attached tools switch to the **agentic** tier set automatically.
2. **Filter.** The tier's curated chain (primary + fallbacks, below) is the candidate pool. Every model that cannot satisfy the request is removed **before** scoring: no tool calling on a tool-required turn, no vision on image input, too small a context window, too small a max-output, an incompatible structured-output path, or absent from the live catalog. Being cheap never compensates for failing the contract.
3. **Rank.** Survivors are scored on task quality, capability, estimated cost, speed, reliability and a small curated-order prior. The weights differ per profile (see [Profile weights](#profile-weights)).
4. **Recover.** The full ranked list stays on the decision as `candidates`. The proxy walks it on a timeout or 5xx, so a provider outage costs a retry, not the task.

The tables show each tier's **curated primary** and its fallback chain as configured in router-core. Under the portfolio strategy the primary is the head of the candidate pool and carries the curated-order prior; it is the usual winner, not a guarantee — a request that needs vision or a 1M context can legitimately land on a fallback.

---

## AUTO (Balanced — Default)

Use `blockrun/auto` (or `/model auto`) for the best quality/price balance.

| Tier      | Primary Model              | Input | Output | Fallback chain (in order)                                                                                                                                                                                          |
| --------- | -------------------------- | ----- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SIMPLE    | google/gemini-2.5-flash    | $0.30 | $2.50  | gemini-3-flash-preview → gemini-3.5-flash-lite → deepseek-chat → gemini-3.1-flash-lite → gpt-5.6-luna → gpt-5.4-nano → gemini-2.5-flash-lite → step-3.7-flash (free)                                               |
| MEDIUM    | google/gemini-3.5-flash    | $1.50 | $9.00  | gemini-3.6-flash → glm-5.3-flash → gpt-5.6-terra → gemini-3-flash-preview → deepseek-chat → gemini-2.5-flash → minimax-m3 → gemini-3.1-flash-lite → gpt-5.6-luna → gemini-2.5-flash-lite                           |
| COMPLEX   | google/gemini-3.1-pro      | $2.00 | $12.00 | gemini-3.6-flash → gemini-3.5-flash → claude-sonnet-5 → grok-4.5 → gemini-2.5-pro → claude-sonnet-4.6 → gpt-5.6-terra → gpt-5.5 → gpt-5.4 → glm-5.3 → kimi-k3 → deepseek-v4-pro → deepseek-chat → gemini-2.5-flash |
| REASONING | deepseek/deepseek-reasoner | $0.14 | $0.28  | deepseek-v4-pro → grok-4.3 → qwen3.7-plus → gemini-3.5-flash → o4-mini → o3                                                                                                                                        |

---

## ECO (Absolute Cheapest)

Use `blockrun/eco` for maximum cost savings. The first stop is the free tier, so simple requests can cost $0.00.

| Tier      | Primary Model              | Input | Output | Fallback chain (in order)                                                                                                |
| --------- | -------------------------- | ----- | ------ | ------------------------------------------------------------------------------------------------------------------------ |
| SIMPLE    | free/step-3.7-flash        | $0.00 | $0.00  | nemotron-nano-9b-v2 (free) → gemini-2.5-flash-lite → glm-5.3-flash → gpt-5.6-luna → gpt-5.4-nano → gemini-3.1-flash-lite |
| MEDIUM    | zai/glm-5.3-flash          | $0.15 | $0.50  | deepseek-chat → gemini-3.1-flash-lite → gpt-5.6-luna → gpt-5.4-nano → gemini-2.5-flash-lite → gemini-2.5-flash           |
| COMPLEX   | zai/glm-5.3-flash          | $0.15 | $0.50  | deepseek-chat → minimax-m3 → deepseek-v4-pro → gemini-3.1-flash-lite → gemini-2.5-flash                                  |
| REASONING | deepseek/deepseek-reasoner | $0.14 | $0.28  | deepseek-v4-pro → qwen3.7-plus → minimax-m3 → glm-5.3-flash                                                              |

The two free rungs at the head of ECO SIMPLE follow NVIDIA's free hosting, which retires models without notice (deepseek-v4-flash 410'd 2026-08-12, seed-oss-36b 2026-08-03, gpt-oss-120b hung 2026-08-16). Each retirement retargets the free rungs to the current free tier; the paid rungs never move. `src/router/free-model-liveness.test.ts` fails the build if a chain names a free model the picker no longer lists.

---

## PREMIUM (Best Quality)

Use `blockrun/premium` for maximum quality. Codex for complex coding, Gemini 3.5 Flash for simple work, Sonnet 5 for reasoning/instructions, Fable/Opus for architecture, audits and PM-grade work.

| Tier      | Primary Model             | Input  | Output | Fallback chain (in order)                                                                                                                                                                                                            |
| --------- | ------------------------- | ------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SIMPLE    | google/gemini-3.5-flash   | $1.50  | $9.00  | gemini-3.6-flash → claude-haiku-4.5 → glm-5.3 → gemini-2.5-flash → gemini-3.5-flash-lite → deepseek-chat                                                                                                                             |
| MEDIUM    | openai/gpt-5.3-codex      | $1.75  | $14.00 | claude-sonnet-5 → kimi-k3 → glm-5.3 → gemini-3.6-flash → gemini-3.5-flash → gemini-2.5-pro → grok-4.5 → claude-sonnet-4.6 → gpt-5.6-terra                                                                                            |
| COMPLEX   | anthropic/claude-fable-5  | $10.00 | $50.00 | claude-opus-5 → claude-opus-4.8 → claude-opus-4.7 → claude-sonnet-5 → claude-sonnet-4.6 → grok-4.5 → kimi-k3 → gpt-5.6-terra → gpt-5.5 → gpt-5.4 → gpt-5.3-codex → glm-5.3 → deepseek-v4-pro → deepseek-chat → step-3.7-flash (free) |
| REASONING | anthropic/claude-sonnet-5 | $3.00  | $15.00 | claude-sonnet-4.6 → claude-opus-5 → claude-opus-4.8 → claude-opus-4.7 → grok-4.5 → deepseek-v4-pro → grok-4.3 → o4-mini → o3                                                                                                         |

The premium COMPLEX chain is deliberately de-Gemini'd: Google's "high demand" 503s correlate with Anthropic outages (everyone falls back to Google at the same time), so the chain prefers the in-family Opus hot swaps, then xAI, Moonshot, OpenAI and Z.AI — providers on independent infrastructure.

---

## AGENTIC (Multi-Step Tool Use)

Not a profile you pick — router-core switches to these tiers when the turn actually needs its attached tools (`inferToolRequirement`: `tool_choice: "none"` is authoritative, and host tool _descriptions_ alone do not trigger it). Primaries favour models that keep going instead of stopping to ask.

| Tier      | Primary Model             | Input | Output | Fallback chain (in order)                                                                                                                                                                                          |
| --------- | ------------------------- | ----- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SIMPLE    | openai/gpt-4o-mini        | $0.15 | $0.60  | gpt-5.6-luna → glm-5.3-flash → claude-haiku-4.5 → gemini-2.5-flash                                                                                                                                                 |
| MEDIUM    | openai/gpt-5-mini         | $0.25 | $2.00  | gemini-3.5-flash → glm-5.3-flash → gpt-5.6-terra → gpt-4o-mini → claude-haiku-4.5 → deepseek-chat → kimi-k3                                                                                                        |
| COMPLEX   | anthropic/claude-sonnet-5 | $3.00 | $15.00 | claude-sonnet-4.6 → claude-opus-5 → claude-opus-4.8 → claude-opus-4.7 → grok-4.5 → kimi-k3 → gpt-5.6-terra → gpt-5.5 → gpt-5.4 → gpt-5.3-codex → glm-5.3 → deepseek-v4-pro → deepseek-chat → step-3.7-flash (free) |
| REASONING | anthropic/claude-sonnet-5 | $3.00 | $15.00 | claude-sonnet-4.6 → claude-opus-5 → claude-opus-4.8 → claude-opus-4.7 → grok-4.5 → deepseek-v4-pro → deepseek-reasoner                                                                                             |

Set `routing.overrides.agenticMode: false` to disable the agentic tier set, or `true` to force it.

---

## FREE (`/model free`)

`free` is an alias, not a routed profile: it pins the free-tier default, currently **`free/step-3.7-flash`** — the same model that opens ECO SIMPLE. If that model is excluded (`/exclude add step-flash`) or the budget cap forces a free fallback, the proxy walks the free cascade in this order: step-3.7-flash → nemotron-nano-9b-v2 → mistral-nemotron → nemotron-3-nano-omni-30b-a3b-reasoning (vision) → nemotron-nano-12b-v2-vl (vision). All five are NVIDIA-hosted, $0.00, and need no USDC.

Pin any of them directly with `/model step-flash`, `/model nemotron-nano`, `/model mistral-nemotron`, `/model nemotron-omni` (vision) or `/model nano-vl` (vision).

---

## Profile weights

How survivors are ranked, per profile (router-core `DEFAULT_ROUTING_CONFIG.portfolio`):

| Component     | AUTO |  ECO | PREMIUM | Role                                                    |
| ------------- | ---: | ---: | ------: | ------------------------------------------------------- |
| Task quality  | 0.47 | 0.36 |    0.58 | Prefer models validated for the detected task shape     |
| Capability    | 0.20 | 0.20 |    0.20 | Preserve the request contract after hard filtering      |
| Cost          | 0.18 | 0.28 |    0.08 | Reward efficient qualified candidates                   |
| Speed         | 0.07 | 0.10 |    0.06 | Ordinary interactive latency                            |
| Reliability   | 0.03 | 0.04 |    0.06 | Prefer stable candidates                                |
| Curated order | 0.05 | 0.02 |    0.02 | A small, explainable prior toward the chain order above |

High-stakes turns add `+0.08` quality / `+0.05` reliability; latency-sensitive turns add `+0.08` speed. An `affinityFloorGap` (auto 0.10, eco 0.22, premium 0.05) stops a candidate materially below the best task affinity from winning on price alone — which is why ECO can still climb to a paid model for work the free tier would botch.

---

## ECO vs AUTO Savings

Combined input + output rate per 1M tokens, primaries only:

| Tier      | ECO   | AUTO   | Savings  |
| --------- | ----- | ------ | -------- |
| SIMPLE    | FREE  | $2.80  | **100%** |
| MEDIUM    | $1.75 | $4.95  | **65%**  |
| COMPLEX   | $1.75 | $14.00 | **88%**  |
| REASONING | $0.70 | $0.70  | 0%       |

The published savings claim (**88%** on `auto`, **98%** on `eco`, against pinning Claude Opus 5) is blended across a stated workload mix and priced on the live catalog — see [`savings-mix.json`](https://github.com/BlockRunAI/blockrun/blob/main/src/brand/savings-mix.json). Per-tier numbers above are illustrative; the blended figure is the one to quote.

---

## How Tiers Work

- **SIMPLE**: factual lookups, greetings, translations, short responses
- **MEDIUM**: summaries, explanations, data extraction, moderate code
- **COMPLEX**: large context, multi-step analysis, substantial code generation
- **REASONING**: proofs, formal logic, multi-step math, chain-of-thought

Two overrides apply on top of the scorer: conversations above 100K tokens are forced to COMPLEX, and structured-output requests (JSON/YAML) are lifted to at least MEDIUM. Ambiguous requests (confidence < 0.7) default to MEDIUM.

## Rollback and shadow mode

- `routing.strategy: "rules"` reverts to the V2 tier selector (primary-first, no portfolio ranking) without a code change.
- `routing.shadow: { strategy: "rules", sampleRate: 0.1 }` recomputes a comparison decision locally on a sample of requests and reports it on `x-clawrouter-*` debug headers. It never issues a second paid completion and never persists prompt content.

See [configuration.md](./configuration.md#routing-configuration) for the YAML.

---

_Last updated: v0.12.250 — router-core V3.4 (commit `d7bc10c`)_
