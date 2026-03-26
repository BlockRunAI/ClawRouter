# Building a Smart LLM Router: How We Benchmarked 46 Models and Built a 14-Dimension Classifier

_March 20, 2026 | BlockRun Engineering_

When you route AI requests across 55+ models from 8 providers, you can't just pick the cheapest one. You can't just pick the fastest one either. We learned this the hard way.

This is the technical story of how we benchmarked every model on our platform, discovered that speed and intelligence are poorly correlated, and built a production routing system that classifies requests in under 1ms using 14 weighted dimensions with sigmoid confidence calibration.

## The Problem: One Gateway, 46 Models, Infinite Wrong Choices

BlockRun is an x402 micropayment gateway. Every LLM request flows through our proxy, gets authenticated via on-chain USDC payment, and is forwarded to the appropriate provider. The payment overhead adds 50-100ms to every request.

Our users set `model: "auto"` and expect us to pick the right model. But "right" means different things for different requests:

- A "what is Python?" query should route to the cheapest, fastest model
- A "implement a B-tree with concurrent insertions" query needs a capable model
- A "prove this theorem step by step" query needs reasoning capabilities
- An agentic workflow with tool calls needs models that follow instructions precisely

We needed a system that could classify any request and route it to the optimal model in real-time.

## Step 1: Benchmarking the Fleet

Before building the router, we needed ground truth. We benchmarked all 55+ models through our production payment pipeline.

### Methodology

```
Setup:     ClawRouter v0.12.47 proxy on localhost
           → BlockRun x402 gateway (Base EVM chain)
           → Provider APIs (OpenAI, Anthropic, Google, xAI, DeepSeek, Moonshot, MiniMax, NVIDIA, Z.AI)

Prompts:   3 Python coding tasks (IPv4 validation, LCS algorithm, LRU cache)
           2 requests per model per prompt
Config:    256 max tokens, non-streaming, temperature 0.7
Measured:  End-to-end wall clock time (includes x402 payment verification)
```

This is not a synthetic benchmark. Every measurement includes the full payment-verification round trip that real users experience.

### The Latency Landscape

Results revealed a 7x spread between the fastest and slowest models:

```
FAST TIER (<1.5s):
  xai/grok-4-fast           1,143ms   224 tok/s   $0.20/$0.50
  xai/grok-3-mini           1,202ms   215 tok/s   $0.30/$0.50
  google/gemini-2.5-flash   1,238ms   208 tok/s   $0.30/$2.50
  google/gemini-2.5-pro     1,294ms   198 tok/s   $1.25/$10.00
  google/gemini-3-flash     1,398ms   183 tok/s   $0.50/$3.00
  deepseek/deepseek-chat    1,431ms   179 tok/s   $0.28/$0.42

MID TIER (1.5-2.5s):
  google/gemini-3.1-pro     1,609ms   167 tok/s   $2.00/$12.00
  moonshot/kimi-k2.5        1,646ms   156 tok/s   $0.60/$3.00
  anthropic/claude-sonnet   2,110ms   121 tok/s   $3.00/$15.00
  anthropic/claude-opus     2,139ms   120 tok/s   $5.00/$25.00
  openai/o3-mini            2,260ms   114 tok/s   $1.10/$4.40

SLOW TIER (>3s):
  openai/gpt-5.2-pro        3,546ms    73 tok/s   $21.00/$168.00
  openai/gpt-4o             5,378ms    48 tok/s   $2.50/$10.00
  openai/gpt-5.4            6,213ms    41 tok/s   $2.50/$15.00
  openai/gpt-5.3-codex      7,935ms    32 tok/s   $1.75/$14.00
```

Two clear patterns:

1. **Google and xAI dominate speed.** 11 of the top 13 fastest models are from Google or xAI.
2. **OpenAI flagship models are consistently slow.** Every GPT-5.x model takes 3-8 seconds. Even their cheapest models (GPT-4.1-nano at $0.10/$0.40) are 2x slower than Google's cheapest.

## Step 2: Adding the Quality Dimension

Speed alone tells you nothing about whether a model can actually handle your request. We cross-referenced our latency data with Artificial Analysis Intelligence Index v4.0 scores (composite of GPQA, MMLU, MATH, HumanEval, and other benchmarks):

```
MODEL                       LATENCY    IQ    $/M INPUT
─────────────────────────────────────────────────────
google/gemini-3.1-pro       1,609ms    57    $2.00    ← SWEET SPOT
openai/gpt-5.4              6,213ms    57    $2.50
openai/gpt-5.3-codex        7,935ms    54    $1.75
anthropic/claude-opus-4.6   2,139ms    53    $5.00
anthropic/claude-sonnet-4.6 2,110ms    52    $3.00
google/gemini-3-pro-prev    1,352ms    48    $2.00
moonshot/kimi-k2.5          1,646ms    47    $0.60
google/gemini-3-flash-prev  1,398ms    46    $0.50    ← VALUE SWEET SPOT
xai/grok-4                  1,348ms    41    $0.20
xai/grok-4.1-fast           1,244ms    41    $0.20
deepseek/deepseek-chat      1,431ms    32    $0.28
xai/grok-4-fast             1,143ms    23    $0.20
google/gemini-2.5-flash     1,238ms    20    $0.30
```

### The Efficiency Frontier

Plotting IQ against latency reveals a clear efficiency frontier:

```
IQ
57 |  Gem3.1Pro ·························· GPT-5.4
   |
53 |                    · Opus
52 |                   · Sonnet
   |
48 |  Gem3Pro ·
47 |   · Kimi
46 |  Gem3Flash ·
   |
41 |  Grok4 ·
   |
32 | Grok3 · · DeepSeek
   |
23 | GrokFast ·
20 | GemFlash ·
   └──────────────────────────────────────────────
     1.0   1.5   2.0   2.5   3.0        6.0  8.0
                 End-to-End Latency (seconds)
```

The frontier runs from Gemini 2.5 Flash (IQ 20, 1.2s) up to Gemini 3.1 Pro (IQ 57, 1.6s). Everything above and to the right of this line is dominated — you can get equal or better quality at lower latency from a different model.

Key insight: **Gemini 3.1 Pro matches GPT-5.4's IQ at 1/4 the latency and lower cost.** Claude Sonnet 4.6 nearly matches Opus 4.6 quality at 60% of the price. These dominated pairings directly informed our routing fallback chains.

## Step 3: The Failed Experiment (Latency-First Routing)

Armed with benchmark data, we initially optimized for speed. The routing config promoted fast models:

```typescript
// v0.12.47 — latency-optimized (REVERTED)
COMPLEX: {
  primary: "xai/grok-4-0709",           // 1,348ms, IQ 41
  fallback: [
    "xai/grok-4-1-fast-non-reasoning",  // 1,244ms, IQ 41
    "google/gemini-2.5-flash",           // 1,238ms, IQ 20
    // ... fast models first
  ],
}
```

Users complained within 24 hours. The fast models were refusing complex tasks and giving shallow responses. A model with IQ 41 can't reliably handle architecture design or multi-step code generation, no matter how fast it is.

**Lesson: optimizing for a single metric in a multi-objective system creates failure modes.** We needed to optimize across speed, quality, and cost simultaneously.

## Step 4: The 14-Dimension Scoring System

The router needs to determine what kind of request it's looking at before selecting a model. We built a rule-based classifier that scores requests across 14 weighted dimensions:

### Architecture

```
User Prompt → Lowercase + Tokenize
                    ↓
            ┌──────────────────────────────────┐
            │   14 Dimension Scorers           │
            │   Each returns score ∈ [-1, 1]   │
            └──────┬───────────────────────────┘
                   ↓
            Weighted Sum (configurable weights)
                   ↓
            Tier Boundaries (SIMPLE < 0.0 < MEDIUM < 0.3 < COMPLEX < 0.5 < REASONING)
                   ↓
            Sigmoid Confidence Calibration
                   ↓
            confidence < 0.7 → AMBIGUOUS → default to MEDIUM
            confidence ≥ 0.7 → Classified tier
                   ↓
            Tier × Profile → Model Selection
```

### The 14 Dimensions

| Dimension           | Weight | What It Detects                          | Score Range |
| ------------------- | ------ | ---------------------------------------- | ----------- |
| reasoningMarkers    | 0.18   | "prove", "theorem", "step by step"       | 0 to 1.0    |
| codePresence        | 0.15   | "function", "class", "import", "```"     | 0 to 1.0    |
| multiStepPatterns   | 0.12   | "first...then", "step N", numbered lists | 0 or 0.5    |
| technicalTerms      | 0.10   | "algorithm", "kubernetes", "distributed" | 0 to 1.0    |
| tokenCount          | 0.08   | Short (<50 tokens) vs long (>500 tokens) | -1.0 to 1.0 |
| creativeMarkers     | 0.05   | "story", "poem", "brainstorm"            | 0 to 0.7    |
| questionComplexity  | 0.05   | Number of question marks (>3 = complex)  | 0 or 0.5    |
| agenticTask         | 0.04   | "edit", "deploy", "fix", "debug"         | 0 to 1.0    |
| constraintCount     | 0.04   | "at most", "within", "O()"               | 0 to 0.7    |
| imperativeVerbs     | 0.03   | "build", "create", "implement"           | 0 to 0.5    |
| outputFormat        | 0.03   | "json", "yaml", "table", "csv"           | 0 to 0.7    |
| simpleIndicators    | 0.02   | "what is", "hello", "define"             | 0 to -1.0   |
| referenceComplexity | 0.02   | "the code above", "the API docs"         | 0 to 0.5    |
| domainSpecificity   | 0.02   | "quantum", "FPGA", "genomics"            | 0 to 0.8    |

Weights sum to 1.0. The weighted score maps to a continuous axis where tier boundaries partition the space.

### Multilingual Support

Every keyword list includes translations in 9 languages (EN, ZH, JA, RU, DE, ES, PT, KO, AR). A Chinese user asking "证明这个定理" triggers the same reasoning classification as "prove this theorem."

### Confidence Calibration

Raw tier assignments can be ambiguous when a score falls near a boundary. We use sigmoid calibration:

```
confidence = 1 / (1 + exp(-steepness * distance_from_boundary))
```

Where `steepness = 12` and `distance_from_boundary` is the score's distance to the nearest tier boundary. This maps to a [0.5, 1.0] confidence range. Below `threshold = 0.7`, the request is classified as ambiguous and defaults to MEDIUM.

### Agentic Detection

A separate scoring pathway detects agentic tasks (multi-step, tool-using, iterative). When `agenticScore >= 0.5`, the router switches to agentic-optimized tier configs that prefer models with strong instruction following (Claude Sonnet for complex tasks, GPT-4o-mini for simple tool calls).

## Step 5: Tier-to-Model Mapping

Once a request is classified into a tier, the router selects from 4 routing profiles:

### Auto Profile (Default)

Tuned from our benchmark data + user retention metrics:

```
SIMPLE  → gemini-2.5-flash (1,238ms, IQ 20, 60% retention)
MEDIUM  → kimi-k2.5 (1,646ms, IQ 47, strong tool use)
COMPLEX → gemini-3.1-pro (1,609ms, IQ 57, fastest flagship)
REASON  → grok-4-1-fast-reasoning (1,454ms, $0.20/$0.50)
```

### Eco Profile

Ultra cost-optimized. Uses free/near-free models:

```
SIMPLE  → nvidia/gpt-oss-120b (FREE)
MEDIUM  → gemini-2.5-flash-lite ($0.10/$0.40, 1M context)
COMPLEX → gemini-2.5-flash-lite ($0.10/$0.40)
REASON  → grok-4-1-fast-reasoning ($0.20/$0.50)
```

### Premium Profile

Best quality regardless of cost:

```
SIMPLE  → kimi-k2.5 ($0.60/$3.00)
MEDIUM  → gpt-5.3-codex ($1.75/$14.00, 400K context)
COMPLEX → claude-opus-4.6 ($5.00/$25.00)
REASON  → claude-sonnet-4.6 ($3.00/$15.00)
```

### Fallback Chains

Each tier config includes an ordered fallback list. When the primary model returns a 402 (payment failed), 429 (rate limited), or 5xx, the proxy walks the fallback chain. Fallback ordering is benchmark-informed:

```typescript
// COMPLEX tier — quality-first fallback order
fallback: [
  "google/gemini-3-pro-preview", // IQ 48, 1,352ms
  "google/gemini-3-flash-preview", // IQ 46, 1,398ms
  "xai/grok-4-0709", // IQ 41, 1,348ms
  "google/gemini-2.5-pro", // 1,294ms
  "anthropic/claude-sonnet-4.6", // IQ 52, 2,110ms
  "deepseek/deepseek-chat", // IQ 32, 1,431ms
  "google/gemini-2.5-flash", // IQ 20, 1,238ms
  "openai/gpt-5.4", // IQ 57, 6,213ms — last resort
];
```

The chain descends by quality first (IQ 48 → 46 → 41), then trades quality for speed. GPT-5.4 is last despite having IQ 57, because its 6.2s latency is a worst-case user experience.

## Step 6: Context-Aware Filtering

The fallback chain is filtered at runtime based on request properties:

1. **Context window filtering**: Models with insufficient context window for the estimated total tokens are excluded (with 10% safety buffer)
2. **Tool calling filter**: When the request includes tool definitions, only models that support function calling are kept
3. **Vision filter**: When the request includes images, only vision-capable models are kept

If filtering eliminates all candidates, the full chain is used as a fallback (better to let the API error than return nothing).

## Cost Calculation and Savings

Every routing decision includes a cost estimate and savings percentage against a baseline (Claude Opus 4.6 pricing):

```typescript
savings = max(0, (opusCost - routedCost) / opusCost);
```

For a typical SIMPLE request (500 input tokens, 256 output tokens):

- Opus cost: $0.0089 (at $5.00/$25.00 per 1M tokens)
- Gemini Flash cost: $0.0008 (at $0.30/$2.50 per 1M tokens)
- Savings: 91.0%

Across our user base, the median savings rate is 85% compared to routing everything to a premium model.

## Performance

The entire classification pipeline (14 dimensions + tier mapping + model selection) runs in under 1ms. No external API calls. No LLM inference. Pure keyword matching and arithmetic.

We originally designed a two-stage system where low-confidence rules-based classifications would fall back to an LLM classifier (Gemini 2.5 Flash). In practice, the rules handle 70-80% of requests with high confidence, and the remaining ambiguous cases default to MEDIUM — which is the correct conservative choice.

## What We Learned

1. **Speed and intelligence are weakly correlated.** The fastest model (Grok 4 Fast, IQ 23) is at the bottom of the quality scale. The smartest model at low latency (Gemini 3.1 Pro, IQ 57, 1.6s) is a Google model, not OpenAI.

2. **Optimizing for one metric fails.** Latency-first routing breaks quality. Quality-first routing breaks latency budgets. You need multi-objective optimization.

3. **User retention is the real metric.** Our best-performing model for SIMPLE tasks isn't the cheapest or the fastest — it's Gemini 2.5 Flash (60% retention rate), which balances speed, cost, and just-enough quality.

4. **Fallback ordering matters more than primary selection.** The primary model handles the happy path. The fallback chain handles reality — rate limits, outages, payment failures. A well-ordered fallback chain is more important than picking the perfect primary.

5. **Rule-based classification is underrated.** 14 keyword dimensions with sigmoid confidence calibration handles 70-80% of requests correctly in <1ms. The remaining 20-30% default to a safe middle tier. For a routing system where every millisecond of overhead compounds across millions of requests, avoiding LLM inference in the classification step is worth the reduced accuracy.

---

## Appendix: Full Benchmark Data

Raw data (55+ models, latency, throughput, IQ scores, pricing): [`benchmark-merged.json`](https://github.com/BlockRunAI/ClawRouter/blob/main/benchmark-merged.json)

Routing configuration: [`src/router/config.ts`](https://github.com/BlockRunAI/ClawRouter/blob/main/src/router/config.ts)

Scoring implementation: [`src/router/rules.ts`](https://github.com/BlockRunAI/ClawRouter/blob/main/src/router/rules.ts)

---

_BlockRun is the x402 micropayment gateway for AI. One wallet, 55+ models, pay-per-request with USDC. [blockrun.ai](https://blockrun.ai)_
