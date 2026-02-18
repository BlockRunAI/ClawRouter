# ClawRouter: Client-Side Smart Routing Design

> **Status: Implemented (v2)** — Weighted scoring engine shipped in [`src/router/`](../../src/router/). This document is the design record.

## Problem

Simple queries go to Claude Opus at $75/M output tokens when Gemini Flash could handle them at $0.60/M. No cost-aware model selection.

Phase 1 solved API key management (one wallet for 30+ models). Phase 2 solves cost optimization by routing queries to the cheapest capable model.

## Why Client-Side

Every existing smart router (OpenRouter, LiteLLM, etc.) runs server-side. The routing logic is proprietary — users can't see why a model was chosen or customize the rules.

BlockRun's structural advantage: **x402 per-model transparent pricing**. Each model has an independent price visible in the 402 response. This means the routing decision can live in the open-source plugin where it's inspectable, customizable, and auditable.

|               | Server-side (OpenRouter) | Client-side (ClawRouter)        |
| ------------- | ------------------------ | ------------------------------- |
| Routing logic | Proprietary black box    | Open-source in plugin           |
| Pricing       | Bundled, opaque          | Per-model, transparent via x402 |
| Customization | None                     | Operators edit config           |
| Trust model   | "Trust us"               | "Read the code"                 |

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
│  │  Step 1: Weighted Scoring Engine (< 1ms)    │ │
│  │  • 14 scoring dimensions, each [-1, 1]      │ │
│  │  • Weighted sum → float score               │ │
│  │  • Sigmoid confidence calibration           │ │
│  │  • Returns: tier or null (ambiguous)        │ │
│  └─────────────────────┬───────────────────────┘ │
│                        |                          │
│          ┌─────────────┴──────────────┐          │
│          |                            |           │
│     confident                    ambiguous        │
│   (conf >= 0.70)              (conf < 0.70)       │
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

Four tiers. REASONING is distinct from COMPLEX because reasoning tasks need different models (o3, gemini-pro) than general complex tasks (claude-opus-4, gpt-4o).

| Tier          | Description                                      | Example Queries                                                    |
| ------------- | ------------------------------------------------ | ------------------------------------------------------------------ |
| **SIMPLE**    | Short factual Q&A, translations, definitions     | "What's the capital of France?", "Translate hello to Spanish"      |
| **MEDIUM**    | Summaries, explanations, moderate code           | "Summarize this article", "Write a Python function to sort a list" |
| **COMPLEX**   | Multi-step code, system design, creative writing | "Build a React component with tests", "Design a REST API"          |
| **REASONING** | Proofs, multi-step logic, mathematical reasoning | "Prove this theorem", "Solve step by step", "Debug this algorithm" |

## Weighted Scoring Engine (v2)

Implemented in [`src/router/rules.ts`](../../src/router/rules.ts).

14 dimensions, each scored in [-1, 1] and multiplied by a learned weight:

| Dimension            | Weight | Signal                                   |
| -------------------- | ------ | ---------------------------------------- |
| Reasoning markers    | 0.18   | "prove", "theorem", "step by step"       |
| Code presence        | 0.15   | "function", "async", "import", "```"     |
| Simple indicators    | 0.12   | "what is", "define", "translate"         |
| Multi-step patterns  | 0.12   | "first...then", "step 1", numbered lists |
| Technical terms      | 0.10   | "algorithm", "kubernetes", "distributed" |
| Token count          | 0.08   | short (<50) vs long (>500)               |
| Creative markers     | 0.05   | "story", "poem", "brainstorm"            |
| Question complexity  | 0.05   | 4+ question marks                        |
| Constraint count     | 0.04   | "at most", "O(n)", "maximum"             |
| Imperative verbs     | 0.03   | "build", "create", "implement"           |
| Output format        | 0.03   | "json", "yaml", "schema"                 |
| Domain specificity   | 0.02   | "quantum", "fpga", "genomics"            |
| Reference complexity | 0.02   | "the docs", "the api", "above"           |
| Negation complexity  | 0.01   | "don't", "avoid", "without"              |

Weighted score maps to a tier via configurable boundaries. Confidence is calibrated using a sigmoid function — distance from the nearest tier boundary determines how sure the classifier is.

### Tier Boundaries

```
Score < 0.00   → SIMPLE
Score 0.00-0.15 → MEDIUM
Score 0.15-0.25 → COMPLEX
Score > 0.25   → REASONING
```

### Sigmoid Confidence Calibration

```typescript
function calibrateConfidence(distance: number, steepness: number): number {
  return 1 / (1 + Math.exp(-steepness * distance));
}
// steepness = 12 (tuned)
// distance = how far the score is from the nearest tier boundary
// Near boundary → confidence ~0.50 → triggers LLM fallback
// Far from boundary → confidence ~0.95+ → confident classification
```

### Special Case Overrides

| Condition                                     | Override                              | Reason                                 |
| --------------------------------------------- | ------------------------------------- | -------------------------------------- |
| 2+ reasoning markers                          | Force REASONING at >= 0.85 confidence | Reasoning markers are strong signals   |
| Input > 100K tokens                           | Force COMPLEX tier                    | Large context = expensive regardless   |
| System prompt contains "JSON" or "structured" | Minimum MEDIUM tier                   | Structured output needs capable models |

## LLM Classifier (Fallback)

Implemented in [`src/router/llm-classifier.ts`](../../src/router/llm-classifier.ts).

When weighted scoring confidence is below 0.70, sends a classification request to the cheapest available model.

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

| Tier          | Primary Model               | Cost (output per M) | Fallback Chain                   |
| ------------- | --------------------------- | ------------------- | -------------------------------- |
| **SIMPLE**    | `google/gemini-2.5-flash`   | $0.60               | deepseek-chat → gpt-4o-mini      |
| **MEDIUM**    | `deepseek/deepseek-chat`    | $0.42               | gemini-flash → gpt-4o-mini       |
| **COMPLEX**   | `anthropic/claude-opus-4.5` | $25.00              | gpt-4o → gemini-2.5-pro          |
| **REASONING** | `openai/o3`                 | $8.00               | gemini-2.5-pro → claude-sonnet-4.6 |

### Cost Savings (vs Claude Opus at $75/M)

| Tier             | % of Traffic | Output $/M   | Savings         |
| ---------------- | ------------ | ------------ | --------------- |
| SIMPLE           | 40%          | $0.60        | **99% cheaper** |
| MEDIUM           | 30%          | $0.42        | **99% cheaper** |
| COMPLEX          | 20%          | $25.00       | best quality    |
| REASONING        | 10%          | $8.00        | **89% cheaper** |
| **Weighted avg** |              | **$16.17/M** | **78% savings** |

## RoutingDecision Object

Defined in [`src/router/types.ts`](../../src/router/types.ts).

```typescript
type RoutingDecision = {
  model: string; // "deepseek/deepseek-chat"
  tier: Tier; // "MEDIUM"
  confidence: number; // 0.82
  method: "rules" | "llm"; // How the decision was made
  reasoning: string; // "score=-0.200 | short (8 tokens), simple indicator (what is)"
  costEstimate: number; // 0.0004
  baselineCost: number; // 0.3073 (what Claude Opus would have cost)
  savings: number; // 0.992 (0-1)
};
```

## E2E Test Results

19 tests, 0 failures. See [`test/e2e.ts`](../../test/e2e.ts).

```
═══ Rule-Based Classifier ═══

Simple queries:
  ✓ "What is the capital of France?" → SIMPLE (score=-0.200)
  ✓ "Hello" → SIMPLE (score=-0.200)
  ✓ "Define photosynthesis" → SIMPLE (score=-0.125)
  ✓ "Translate hello to Spanish" → SIMPLE (score=-0.200)
  ✓ "Yes or no: is the sky blue?" → SIMPLE (score=-0.200)

Complex queries (correctly deferred to classifier):
  ✓ Kanban board → AMBIGUOUS (score=0.090, conf=0.673)
  ✓ Distributed trading → AMBIGUOUS (score=0.127, conf=0.569)

Reasoning queries:
  ✓ "Prove sqrt(2) irrational" → REASONING (score=0.180, conf=0.973)
  ✓ "Derive time complexity" → REASONING (score=0.186, conf=0.973)
  ✓ "Chain of thought proof" → REASONING (score=0.180, conf=0.973)

═══ Full Router ═══

  ✓ Simple factual → google/gemini-2.5-flash (SIMPLE, rules) saved=99.2%
  ✓ Greeting → google/gemini-2.5-flash (SIMPLE, rules) saved=99.2%
  ✓ Math proof → openai/o3 (REASONING, rules) saved=89.3%

═══════════════════════════════════
  19 passed, 0 failed
═══════════════════════════════════
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
    ├── rules.ts           # Weighted classifier (14 dimensions, sigmoid confidence)
    ├── llm-classifier.ts  # LLM fallback (gemini-flash, cached)
    ├── selector.ts        # Tier → model selection + cost calculation
    ├── config.ts          # Default routing configuration
    └── types.ts           # RoutingDecision, Tier, ScoringResult
```

## Not Implemented (Future)

- **KNN fallback** — Embedding-based classifier to replace LLM fallback (<5ms vs ~200ms)
- **Cascade routing** — Try cheaper model first, escalate on low quality (AutoMix-inspired)
- **Graceful fallback** — Auto-switch on rate limit or provider error using per-tier fallback chains
- **Spend controls** — Daily/monthly budgets, server-side enforcement
- **Quality feedback loop** — Learning from past routing decisions to improve accuracy
- **Conversation context** — Current design is per-message. Future: track conversation complexity over time
