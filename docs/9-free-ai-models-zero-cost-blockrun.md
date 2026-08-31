# 9 Free AI Models, Zero Cost: How BlockRun Gives Developers Top-Tier LLMs for Nothing

> **The count in this title is a snapshot, and so is every model name below.**
> It was 9 when this was written; the published free tier is <!-- br:models.free -->7<!-- /br:models.free --> today, and _none_ of the
> nine originals is still in it. Free hosting is volatile — NVIDIA retired four
> of the five visible free models in a single sweep on 2026-08-30 — so the tier
> gets rebuilt rather than topped up. The URL keeps its original slug so existing
> links do not break. Current figures, always:
> [blockrun.ai/brand/numbers.json](https://blockrun.ai/brand/numbers.json); the
> live catalog is [blockrun.ai/api/v1/models](https://blockrun.ai/api/v1/models).

## The Cost Problem Nobody Talks About

It's 2026. Large language models are table stakes for developers. But here's the uncomfortable truth — **the models you can afford aren't good enough, and the good ones aren't affordable.**

Claude Opus 4 runs $15/$75 per million tokens. GPT-4o sits at $2.50/$10. Even the "cheap" models add up fast. For indie developers, students, and early-stage startups, $50–$200/month in API costs is real money — especially when half of it goes to throwaway experiments, prompt iterations, and dead-end debugging sessions.

You're not just paying for intelligence. You're paying for every mistake, every retry, every discarded attempt.

**What if you had a handful of high-quality LLMs — completely free, unlimited calls, up to 1M context — and could use them right now?**

BlockRun's answer: just take them.

---

## The Lineup: <!-- br:models.free -->7<!-- /br:models.free --> Models, $0.00

Through [ClawRouter](https://github.com/BlockRunAI/ClawRouter) — BlockRun's local AI routing proxy — you get zero-cost access to the following (verified live 2026-08-30):

| Model                        | Context | Reasoning | Best For                                   |
| ---------------------------- | ------- | --------- | ------------------------------------------ |
| **Nemotron 3.5 Lightning**   | 1M      | ✅        | The free default — thinking-mode reasoning |
| **Nemotron 3 Nano 30B**      | 131K    | ✅        | Fastest free model (~121 tok/s)            |
| **Nemotron 3 Ultra 550B**    | 1M      | ✅        | Largest free model — 550B / 55B active MoE |
| **Nemotron 3 Nano Omni 30B** | 256K    | ✅        | Vision — text + image + video + audio      |
| **Llama 3.2 11B Vision**     | 128K    | —         | Meta Llama with image input                |
| **Cohere North Mini Code**   | 256K    | ✅        | Coding, sub-second responses               |
| **Poolside Laguna XS 2.1**   | 131K    | —         | Coding, ~161 tok/s                         |

**Price: $0.00 per million tokens. Input free. Output free. No hidden fees. No daily caps. No trial period.**

This isn't "free for your first 1,000 requests." It's not "free but rate-limited to uselessness." It's production-grade, unlimited, genuinely free inference.

---

## Why Free?

BlockRun's business model is simple: **make the best models accessible, charge only for the premium ones.**

The free models are BlockRun's foundation tier. They cover the vast majority of everyday developer tasks — chat, coding, translation, summarization, lightweight reasoning — without costing a cent. When you need heavier firepower (Claude Opus 4, GPT-4o, o3), BlockRun charges per-call via [x402 micropayments](https://www.x402.org/). No subscriptions, no monthly minimums — just pay for what you use, only when you need to.

The free tier isn't a loss leader. It's the product. BlockRun believes baseline AI capability should be accessible to every developer, regardless of budget. The premium tier exists for tasks that genuinely demand it.

---

## Not Just Free: How Smart Routing Squeezes Every Dollar

ClawRouter's value proposition isn't just "here are free models." It's **intelligent routing** — automatically selecting the right model for each request based on prompt complexity.

### The Four-Tier Architecture

ClawRouter classifies every incoming request into one of four complexity tiers:

| Tier          | Typical Tasks                         | ECO Route (Cheapest)             | AUTO Route (Balanced) |
| ------------- | ------------------------------------- | -------------------------------- | --------------------- |
| **SIMPLE**    | Formatting, translation, Q&A          | 🆓 Nemotron 3.5 Lightning (FREE) | Gemini 2.5 Flash      |
| **MEDIUM**    | Summaries, analysis, general coding   | GLM-5.3 Flash ($0.15/$0.50)      | Gemini 3.5 Flash      |
| **COMPLEX**   | Architecture, complex code            | GLM-5.3 Flash ($0.15/$0.50)      | Gemini 3.1 Pro        |
| **REASONING** | Mathematical proofs, multi-step logic | DeepSeek Reasoner ($0.14/$0.28)  | Claude Sonnet 5       |

The SIMPLE tier — the bulk of everyday traffic — costs nothing, and the paid ECO rungs are cents. Note what changed since this was written: ECO used to route three of four tiers to free models. It no longer does, and that is deliberate. Paid value-tier models got cheap enough ($0.14–$0.15 per million input tokens) that routing hard work to a free model is a worse trade than paying a fraction of a cent for one that will not time out.

### Real-World Cost Comparison

Assume 100 requests per day, distributed roughly as:

- 40% SIMPLE (chat, translation, formatting)
- 30% MEDIUM (coding, analysis)
- 20% COMPLEX (architecture, deep debugging)
- 10% REASONING (math, formal logic)

| Approach                    | Estimated Monthly Cost |
| --------------------------- | ---------------------- |
| Pure Claude Opus 4          | ~$75–150               |
| Pure GPT-4o                 | ~$15–30                |
| ClawRouter AUTO mode        | ~$5–10                 |
| ClawRouter ECO mode         | ~$1–3                  |
| Manual free model selection | **$0**                 |

**ECO mode is <!-- br:savings.ecoVsBaselinePct -->98<!-- /br:savings.ecoVsBaselinePct -->% cheaper than pinning Claude Opus 5 for every request.**

---

## Deep Dive: What Each Free Model Does Best

### Nemotron 3.5 Lightning — The Free Default

A 30B-A3B mixture-of-experts model with a **1M-token context** and thinking-mode reasoning. It is what `/model free` pins and what ECO's SIMPLE tier opens on. Roughly 35 tokens/second, and a 1M window is unusual at any price, let alone $0.

**Best for:** Long-context reasoning, multi-step planning, anything where the input is big. If you remember one free model name, remember this one.

### Nemotron 3 Nano 30B — The Fast One

The **fastest free model in the catalog** — around 121 tokens/second on realistic workloads, not just short pings. Returns reasoning content. When you are iterating rapidly and each round-trip is a tax on your attention, this is the one to pin.

**Best for:** Rapid iteration, prompt engineering, high-volume light tasks.

### Nemotron 3 Ultra 550B — The Big One

550 billion total parameters, 55B active, 1M context — the **largest free model ever listed**. It is genuinely strong, and it is genuinely slower than the rest of the tier; treat it as the one you reach for when the task is hard rather than the one you leave pinned.

**Best for:** Complex analysis and deep reasoning where you would otherwise pay.

### Nemotron 3 Nano Omni 30B — The Only Free Vision Model

31B / 3.2B active MoE, 256K context, and the **only vision-capable model in the free tier**. It accepts images, video up to two minutes, and audio up to an hour. ChartQA 90.3, DocVQA 95.6, MMMU 70.8.

**Best for:** Screenshots, charts, documents, and any multimodal input at zero cost.

### Llama 3.2 11B Vision — The Free Llama

Meta's Llama 3.2 11B with image input and a 128K window. It is older than everything else here, and that is the point: a 12-model sweep of what NVIDIA still serves free found this was the only Llama that actually finishes a real completion.

**Best for:** Anyone who needs a Llama specifically, plus lightweight image understanding.

### Cohere North Mini Code — The Fast Coder

A compact coding model with a 256K window and **sub-second median responses** — the quickest thing in the tier by a wide margin. BlockRun sells no Cohere SKU, so listing it free cannibalizes nothing.

**Best for:** Code completion, quick refactors, anything where latency dominates.

### Poolside Laguna XS 2.1 — The Other Fast Coder

Around 161 tokens/second on a 131K window. It sits next to North Mini Code in the fallback chain on purpose: the two run on **different capacity pools**, so one provider's outage cannot take both coding rungs at once.

**Best for:** Code generation, and as insurance for the rung above it.

---

## Get Started in 5 Minutes

### Option 1: Via ClawRouter (Recommended)

```bash
# Install
npm install -g @blockrun/clawrouter

# Start the local proxy
clawrouter start
```

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8402/v1",
    api_key="your-blockrun-key"
)

# Pick a specific free model
response = client.chat.completions.create(
    model="free/nemotron-3.5-lightning",
    messages=[{"role": "user", "content": "Explain quantum entanglement"}]
)

# Or let ECO routing pick the best free model automatically
response = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Hello world"}]
)
```

### Option 2: Switch Models in Claude Code

If you're using Claude Code, one command switches you to any free model:

```
/model free              → Nemotron 3.5 Lightning (1M ctx, the default)
/model nano-30b          → Nemotron 3 Nano 30B (fastest)
/model ultra-550b        → Nemotron 3 Ultra 550B (largest)
/model vision-free       → Nemotron 3 Nano Omni (images, video, audio)
/model llama-vision      → Llama 3.2 11B Vision
/model north-mini        → Cohere North Mini Code
/model laguna            → Poolside Laguna XS 2.1
```

Seamless. No config changes. No restarts.

---

## The Honest Limitations

Free models aren't a silver bullet. Here's what you need to know:

### 1. Tool Calling Is Not Routed to Free Models

The gateway will return structured tool calls from these models, but ClawRouter deliberately keeps the free tier out of tool-bearing requests: a one-tool probe is not evidence that a model survives a long agentic run. If your application depends on tool calling, you get a paid model.

### 2. Reasoning Has a Ceiling

Five of the seven are reasoning-capable and handle most tasks well. On the hardest problems — competition-level math, formal proofs, deep multi-step planning — they don't match Claude Opus 5 or Sonnet 5. That's why ClawRouter's REASONING tier doesn't use free models.

### 3. Free Hosting Is Volatile

This is the real limitation, and it is worth more than the other two. On 2026-08-30 NVIDIA retired four of the five visible free models in one sweep, and none of the nine models this article originally listed is still in the tier. Free capacity comes from whatever a provider is willing to give away this quarter. Pin a free model if you like — but build so that losing it costs you a config line, not a rewrite. That is the entire argument for putting a router in front of them.

---

## Best Practices: Maximizing Free Models

### Strategy 1: Match Model to Task

Don't use one model for everything. Route by task type:

```
Quick chat, formatting    → Nemotron 3 Nano 30B (fastest)
Code generation           → North Mini Code or Laguna XS 2.1
Reasoning required        → Nemotron 3.5 Lightning (1M ctx)
Hardest free reasoning    → Nemotron 3 Ultra 550B
Images, video, audio      → Nemotron 3 Nano Omni
A Llama specifically      → Llama 3.2 11B Vision
```

### Strategy 2: Free for 80%, Paid for 20%

Use ECO mode for the bulk of daily tasks — it's free. Reserve paid models (Claude Opus, GPT-4o) for the 20% that genuinely requires top-tier capability: production-critical reasoning, tool calling, agentic workflows. Monthly AI spend drops to single digits.

### Strategy 3: Prototype Free, Ship Paid

During development, iterate freely — prompt engineering, edge case testing, architecture exploration — all on free models. Once you've nailed the approach, switch to a paid model for final quality assurance and production deployment.

---

## The Bigger Picture: What This Means for AI Access

Look at the cost trajectory over the past three years:

- **2023:** GPT-4 dominates alone at $30/$60 per M tokens
- **2024:** Open-source models surge, prices halve repeatedly
- **2025:** DeepSeek, Qwen push top-tier inference below $1/M
- **2026:** BlockRun offers <!-- br:models.free -->7<!-- /br:models.free --> free models through a single API

**A free tier that gets rebuilt rather than retired isn't just a product feature — it's a signal.** Baseline AI capability is becoming infrastructure. Like internet bandwidth before it, the cost of "good enough" AI inference is converging toward zero.

BlockRun and ClawRouter exist to be the **routing layer** in this transition: not locked to any single provider, not bound to any single model, always giving developers the lowest-cost path to the right capability.

Today it's <!-- br:models.free -->7<!-- /br:models.free --> free models, and they are not the same seven as last month. Tomorrow it could be 50. Prices will only drop. Capabilities will only improve. The names will keep churning.

**The one constant: your code doesn't need to change.**

---

## Start Now

```bash
npm install -g @blockrun/clawrouter
clawrouter start
```

Point your `base_url` to `http://localhost:8402/v1`. That's the whole setup.

<!-- br:models.free -->7<!-- /br:models.free --> free models. Up to 1M context. Unlimited calls. Zero cost.

Go build something.

---

_Model lineup refreshed for ClawRouter v0.12.258 (2026-08-30). Model availability changes often — the table above is a snapshot, the catalog endpoint is not. For the latest information, visit [blockrun.ai](https://blockrun.ai)._
