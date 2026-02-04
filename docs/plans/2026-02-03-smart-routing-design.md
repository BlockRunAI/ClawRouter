# ClawRouter: Client-Side Smart Routing Design

> **Status: Implemented** — Core routing shipped in [`src/router/`](../../src/router/). This document is the design record.

## Problem

Simple queries go to GPT-4o at $10/M output tokens when Gemini Flash could handle them at $0.60/M. No cost-aware model selection.

Phase 1 solved API key management (one wallet for 30+ models). Phase 2 solves cost optimization by routing queries to the cheapest capable model.

## Why Client-Side

Every existing smart router (OpenRouter, LiteLLM, etc.) runs server-side. The routing logic is proprietary — users can't see why a model was chosen or customize the rules.

BlockRun's structural advantage: **x402 per-model transparent pricing**. Each model has an independent price visible in the 402 response. This means the routing decision can live in the open-source plugin where it's inspectable, customizable, and auditable.

| | Server-side (OpenRouter) | Client-side (ClawRouter) |
|---|---|---|
| Routing logic | Proprietary black box | Open-source in plugin |
| Pricing | Bundled, opaque | Per-model, transparent via x402 |
| Customization | None | Operators edit config |
| Trust model | "Trust us" | "Read the code" |

## Research Summary

Analyzed 9 open-source smart routing implementations. Three classification approaches emerged:

1. **Pure heuristic** (keyword + length + regex) — Zero cost, < 1ms, but brittle
2. **Small LLM classifier** (DistilBERT, Granite 350M, 8B model) — Better accuracy, 20-500ms overhead
3. **Hybrid** (rules first, LLM only for ambiguous cases) — Best of both worlds

The hybrid approach (from octoroute, smart-router) handles 70-80% of requests via rules in < 1ms, and only sends ambiguous cases to a cheap LLM classifier. This is what we implemented.

## Architecture

```
OpenClaw Agent
     |
     v
┌─────────────────────────────────────────────────┐
│              ClawRouter (src/router/)             │
│                                                   │
│  ┌─────────────────────────────────────────────┐ │
│  │  Step 1: Rule-Based Classifier (< 1ms)      │ │
│  │  • Token count heuristic                     │ │
│  │  • Code detection (backticks, keywords)      │ │
│  │  • Reasoning markers                         │ │
│  │  • Length-based bucketing                     │ │
│  │  • Returns: tier or AMBIGUOUS                │ │
│  └─────────────────────┬───────────────────────┘ │
│                        |                          │
│          ┌─────────────┴──────────────┐          │
│          |                            |           │
│     tier found                   AMBIGUOUS        │
│          |                            |           │
│          |  ┌─────────────────────────┴────────┐ │
│          |  │  Step 2: LLM Classifier (~200ms) │ │
│          |  │  • Send to gemini-flash (cheapest)│ │
│          |  │  • "Classify: SIMPLE/MEDIUM/..."  │ │
│          |  │  • Cache classification result    │ │
│          |  └─────────────────────────┬────────┘ │
│          |                            |           │
│          └────────────┬───────────────┘           │
│                       |                           │
│  ┌────────────────────┴────────────────────────┐ │
│  │  Step 3: Tier → Model Selection             │ │
│  │  • Look up cheapest model for tier          │ │
│  │  • Calculate cost estimate + savings        │ │
│  └────────────────────┬────────────────────────┘ │
│                       |                           │
│  ┌────────────────────┴────────────────────────┐ │
│  │  Step 4: RoutingDecision metadata           │ │
│  │  { model, tier, confidence, reasoning }     │ │
│  └────────────────────┬────────────────────────┘ │
│                       |                           │
└───────────────────────┼─────────────────────────┘
                        |
                        v
               BlockRun API (x402)
                        |
                        v
                  LLM Provider
```

## Classification Tiers

Four tiers. REASONING is distinct from COMPLEX because reasoning tasks need different models (o3, gemini-pro) than general complex tasks (gpt-4o, sonnet-4).

| Tier | Description | Example Queries |
|------|-------------|-----------------|
| **SIMPLE** | Short factual Q&A, translations, definitions | "What's the capital of France?", "Translate hello to Spanish" |
| **MEDIUM** | Summaries, explanations, moderate code | "Summarize this article", "Write a Python function to sort a list" |
| **COMPLEX** | Multi-step code, system design, creative writing | "Build a React component with tests", "Design a REST API" |
| **REASONING** | Proofs, multi-step logic, mathematical reasoning | "Prove this theorem", "Solve step by step", "Debug this algorithm" |

## Rule-Based Classifier

Implemented in [`src/router/rules.ts`](../../src/router/rules.ts).

Scores each request across 8 dimensions, then maps the aggregate score to a tier. If the score falls in an ambiguous zone, returns `null` to trigger the LLM classifier.

### Scoring Dimensions

| Dimension | Signal | Score Impact |
|-----------|--------|-------------|
| **Token count** | Estimated via `text.length / 4` | < 50 tokens: -2, > 500 tokens: +2 |
| **Code presence** | Backticks, `function`, `class`, `import`, `SELECT`, `{`, `}` | +1 or +2 if code detected |
| **Reasoning markers** | "prove", "step by step", "derive", "theorem", "chain of thought" | +3 (routes to REASONING) |
| **Technical terms** | "algorithm", "optimize", "architecture", "distributed", "kubernetes" | +1 per 2 matches |
| **Creative markers** | "write a story", "compose", "brainstorm", "creative" | +1 |
| **Simple indicators** | "what is", "define", "translate", "yes or no", "hello" | -2 |
| **Multi-step patterns** | "first...then", numbered lists, "step 1" | +1 |
| **Question count** | Multiple `?` in input | > 3 questions: +1 |

### Score → Tier Mapping

```
Score <= 0     → SIMPLE     (confidence: 0.85-0.95)
Score 1-2      → AMBIGUOUS  (triggers LLM classifier)
Score 3-4      → MEDIUM     (confidence: 0.75-0.85)
Score 5-6      → COMPLEX    (confidence: 0.70-0.85)
Score 7+       → REASONING  (confidence: 0.70-0.80)
                 OR if 2+ reasoning markers → REASONING (confidence: 0.90)
```

### Special Case Overrides

| Condition | Override | Reason |
|-----------|----------|--------|
| Input > 100K tokens | Force COMPLEX tier | Large context = expensive regardless |
| System prompt contains "JSON" or "structured" | Minimum MEDIUM tier | Structured output needs capable models |

## LLM Classifier (Fallback)

Implemented in [`src/router/llm-classifier.ts`](../../src/router/llm-classifier.ts).

When the rule-based classifier returns AMBIGUOUS, sends a classification request to the cheapest available model.

### Implementation Details

- **Model**: `google/gemini-2.5-flash` ($0.15/$0.60 per M tokens)
- **Max tokens**: 10 (one word response)
- **Temperature**: 0 (deterministic)
- **Prompt truncation**: First 500 characters
- **Cost per classification**: ~$0.00003
- **Latency**: ~200-400ms
- **Parsing**: Word-boundary regex matching for SIMPLE/MEDIUM/COMPLEX/REASONING
- **Fallback on parse failure**: Default to MEDIUM
- **Cache**: In-memory Map, TTL 1 hour, prunes at 1000 entries

## Tier → Model Mapping

Implemented in [`src/router/selector.ts`](../../src/router/selector.ts) and [`src/router/config.ts`](../../src/router/config.ts).

| Tier | Primary Model | Cost (input/output per M) | Fallback Chain |
|------|--------------|---------------------------|----------------|
| **SIMPLE** | `google/gemini-2.5-flash` | $0.15 / $0.60 | deepseek-chat → gpt-4o-mini |
| **MEDIUM** | `deepseek/deepseek-chat` | $0.28 / $0.42 | gemini-flash → gpt-4o-mini |
| **COMPLEX** | `anthropic/claude-sonnet-4` | $3.00 / $15.00 | gpt-4o → gemini-2.5-pro |
| **REASONING** | `openai/o3` | $2.00 / $8.00 | gemini-2.5-pro → claude-sonnet-4 |

### Cost Savings

| Tier | % of Queries | Cost (per M output) | vs GPT-4o ($10/M) |
|------|-------------|--------------------|--------------------|
| SIMPLE | 40% | $0.60 | **94% savings** |
| MEDIUM | 30% | $0.42 | **96% savings** |
| COMPLEX | 20% | $15.00 | 50% more (but better quality) |
| REASONING | 10% | $8.00 | **20% savings** |
| **Weighted average** | | **$3.67/M** | **63% savings** |

## RoutingDecision Object

Defined in [`src/router/types.ts`](../../src/router/types.ts).

```typescript
type RoutingDecision = {
  model: string;           // "deepseek/deepseek-chat"
  tier: Tier;              // "MEDIUM"
  confidence: number;      // 0.85
  method: "rules" | "llm"; // How the decision was made
  reasoning: string;       // "score=-4, signals: short (8 tokens), simple indicator (what is)"
  costEstimate: number;    // 0.0004
  baselineCost: number;    // 0.0095 (what GPT-4o would have cost)
  savings: number;         // 0.958 (0-1)
};
```

## E2E Test Results

20 tests, 0 failures. See [`test/e2e.ts`](../../test/e2e.ts).

```
═══ Part 1: Rule-Based Classifier ═══
  ✓ "What is the capital of France?" → SIMPLE (score=-4)
  ✓ "Hello" → SIMPLE (score=-4)
  ✓ "Define photosynthesis" → SIMPLE (score=-3)
  ✓ "Translate hello to Spanish" → SIMPLE (score=-4)
  ✓ "Yes or no: is the sky blue?" → SIMPLE (score=-4)
  ✓ Kanban board → AMBIGUOUS (score=1) — correctly defers to LLM classifier
  ✓ Distributed trading platform → AMBIGUOUS (score=2) — correctly defers to LLM
  ✓ "Prove sqrt(2) irrational" → REASONING (score=3)
  ✓ "Derive time complexity + prove optimal" → REASONING (score=3)
  ✓ "Chain of thought proof" → REASONING (score=3)

═══ Part 2: Full Router ═══
  ✓ Simple factual → gemini-2.5-flash (SIMPLE, rules) saved=94.0%
  ✓ Greeting → gemini-2.5-flash (SIMPLE, rules) saved=94.0%
  ✓ Math proof → o3 (REASONING, rules) saved=20.0%
  ✓ 125K token input → COMPLEX (forced override)
  ✓ Structured output → MEDIUM (min tier applied)
  ✓ Cost estimate > 0, baseline > 0, savings in [0,1], cost <= baseline

═══ Part 3: Proxy Startup ═══
  ✓ Health check: ok, wallet: 0x4069...
  ✓ Smart routing: "What is 2+2?" → gemini-flash (SIMPLE) saved=94.0%
```

## File Structure

```
src/
├── index.ts              # Plugin entry — register() + activate()
├── provider.ts           # Registers "blockrun" provider in OpenClaw
├── proxy.ts              # Local HTTP proxy — routing + x402 payment
├── models.ts             # 30+ model definitions with pricing
├── auth.ts               # Wallet key resolution (env, config, prompt)
├── logger.ts             # JSON lines usage logger
├── types.ts              # OpenClaw plugin type definitions
└── router/
    ├── index.ts           # route() entry point
    ├── rules.ts           # Rule-based classifier (8 dimensions)
    ├── llm-classifier.ts  # LLM fallback (gemini-flash, cached)
    ├── selector.ts        # Tier → model selection + cost calculation
    ├── config.ts          # DEFAULT_ROUTING_CONFIG constant
    └── types.ts           # RoutingDecision, Tier, ScoringResult
```

## Not Implemented (Future)

- **Graceful fallback** — Auto-switch on rate limit or provider error using per-tier fallback chains
- **Spend controls** — Daily/monthly budgets, server-side enforcement
- **Semantic caching** — Too heavy for client-side (needs embedding model + vector store)
- **Quality feedback loop** — Learning from past routing decisions to improve accuracy
- **Conversation context** — Current design is per-message. Future: track conversation complexity over time
