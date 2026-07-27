# 9 Free AI Models, Zero Cost: How BlockRun Gives Developers Top-Tier LLMs for Nothing

> **The count in this title is a snapshot.** It was 9 when this was written; the
> published free tier is now 8 — models are withheld from `/v1/models` when a
> provider's terms change, most recently over NVIDIA's prompt-retention policy.
> The URL keeps its original slug so existing links do not break. Current figures:
> [blockrun.ai/brand/numbers.json](https://blockrun.ai/brand/numbers.json).

## The Cost Problem Nobody Talks About

It's 2026. Large language models are table stakes for developers. But here's the uncomfortable truth — **the models you can afford aren't good enough, and the good ones aren't affordable.**

Claude Opus 4 runs $15/$75 per million tokens. GPT-4o sits at $2.50/$10. Even the "cheap" models add up fast. For indie developers, students, and early-stage startups, $50–$200/month in API costs is real money — especially when half of it goes to throwaway experiments, prompt iterations, and dead-end debugging sessions.

You're not just paying for intelligence. You're paying for every mistake, every retry, every discarded attempt.

**What if you had 9 high-quality LLMs — completely free, unlimited calls, up to 1M context — and could use them right now?**

BlockRun's answer: just take them.

---

## The Lineup: 9 Models, $0.00

Through [ClawRouter](https://github.com/BlockRunAI/ClawRouter) — BlockRun's local AI routing proxy — you get zero-cost access to the following:

| Model                       | Context | Reasoning | Best For                                    |
| --------------------------- | ------- | --------- | ------------------------------------------- |
| **GPT-OSS 120B**            | 128K    | —         | General chat, summaries, formatting         |
| **GPT-OSS 20B**             | 128K    | —         | Fast lightweight tasks                      |
| **DeepSeek V4 Flash**       | 1M      | ✅        | Fast chat + summarization over huge context |
| **Qwen3-Next 80B Thinking** | 131K    | ✅        | Reasoning, multi-step planning              |
| **Qwen3 Coder 480B**        | 131K    | —         | Professional code generation                |
| **GLM-4.7**                 | 131K    | ✅        | Chinese-English bilingual reasoning         |
| **Llama 4 Maverick**        | 131K    | ✅        | Open-source all-rounder                     |
| **Mistral Small 4 119B**    | 131K    | —         | Fast multilingual chat                      |
| **Nemotron 3 Nano Omni**    | 256K    | ✅        | Vision — text + image + video + audio       |

**Price: $0.00 per million tokens. Input free. Output free. No hidden fees. No daily caps. No trial period.**

This isn't "free for your first 1,000 requests." It's not "free but rate-limited to uselessness." It's production-grade, unlimited, genuinely free inference.

---

## Why Free?

BlockRun's business model is simple: **make the best models accessible, charge only for the premium ones.**

The 9 free models are BlockRun's foundation tier. They cover the vast majority of everyday developer tasks — chat, coding, translation, summarization, lightweight reasoning — without costing a cent. When you need heavier firepower (Claude Opus 4, GPT-4o, o3), BlockRun charges per-call via [x402 micropayments](https://www.x402.org/). No subscriptions, no monthly minimums — just pay for what you use, only when you need to.

The free tier isn't a loss leader. It's the product. BlockRun believes baseline AI capability should be accessible to every developer, regardless of budget. The premium tier exists for tasks that genuinely demand it.

---

## Not Just Free: How Smart Routing Squeezes Every Dollar

ClawRouter's value proposition isn't just "here are free models." It's **intelligent routing** — automatically selecting the right model for each request based on prompt complexity.

### The Four-Tier Architecture

ClawRouter classifies every incoming request into one of four complexity tiers:

| Tier          | Typical Tasks                         | ECO Route (Cheapest)          | AUTO Route (Balanced) |
| ------------- | ------------------------------------- | ----------------------------- | --------------------- |
| **SIMPLE**    | Formatting, translation, Q&A          | 🆓 GPT-OSS 120B (FREE)        | GPT-4o Mini           |
| **MEDIUM**    | Summaries, analysis, general coding   | 🆓 DeepSeek V3.2 (FREE)       | DeepSeek V3.2         |
| **COMPLEX**   | Architecture, complex code            | 🆓 Nemotron Ultra 253B (FREE) | Claude Sonnet 4       |
| **REASONING** | Mathematical proofs, multi-step logic | DeepSeek R1                   | Claude Opus 4         |

Look at the ECO column. **Three out of four tiers route to free models.** Unless you're doing the hardest reasoning tasks, your daily work costs nothing.

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

### GPT-OSS 120B / 20B — The Workhorse

GPT-OSS is BlockRun's default general-purpose free model. The 120B version is ClawRouter's **default SIMPLE-tier model** in ECO mode and the **ultimate fallback** when wallet balance runs low. It handles conversation, text generation, and summarization with reliable consistency.

The 20B variant trades capability for speed — noticeably faster responses for tasks that don't need the bigger model's muscle.

**Best for:** Daily conversation, text summaries, reformatting, translation, quick answers.

### Nemotron Ultra 253B — The Free Flagship

253 billion parameters. Reasoning capability. 131K context window. Nemotron Ultra is the **single strongest free model on BlockRun** — and it's the default when you type `/model free` in ClawRouter.

This is the model you reach for when the task is genuinely hard but you don't want to pay for it. Complex analysis, multi-step planning, mathematical reasoning — Nemotron Ultra handles them with surprising competence for a zero-cost option.

**Best for:** Complex reasoning, math, logic, deep analysis, planning. If you remember one free model name, remember this one.

### Nemotron 3 Super 120B / Nemotron Super 49B — The Gradient

The Nemotron family gives you three reasoning-capable models at different scales (253B / 120B / 49B). This gradient lets you match firepower to task difficulty. The 49B version is noticeably faster, making it ideal for development workflows where you're iterating rapidly and don't need maximum capability on every call.

**Best for:** When you need reasoning but want faster responses than Ultra 253B.

### DeepSeek V3.2 — The Developer's Weapon

DeepSeek has consistently punched above its weight on coding benchmarks. V3.2 adds reasoning capability on top of already strong code generation. It's ClawRouter's **MEDIUM-tier primary in ECO mode** — the model that handles your everyday coding tasks for free.

**Best for:** Code generation and completion, code review and refactoring, technical design, debugging and error analysis.

### Mistral Large 675B — The Largest Free Model

At 675 billion parameters, Mistral Large is the **biggest model in the free lineup by parameter count.** Mistral has always excelled at multilingual tasks, with particular strength in European languages (French, German, Spanish). Reasoning-capable and formidable on long-form content.

**Best for:** Multilingual content, long document analysis, complex instruction following, cross-language translation.

### Qwen3 Coder 480B — Brute-Force Code Generation

Alibaba's Qwen team built this 480B model specifically for code. When your task is "write a lot of correct code," raw parameter count matters — and 480B parameters dedicated to code generation produces noticeably more complete and accurate output than smaller generalist models.

**Best for:** Large-scale code generation, complex algorithm implementation, multi-file changes, codebase-level understanding.

### Devstral 2 123B — Mistral's Developer Edition

Devstral is the developer-optimized variant of Mistral, fine-tuned for code comprehension, technical documentation, and API design. Think of it as Mistral Large's more focused sibling.

**Best for:** Code understanding, technical documentation, API design, developer tooling.

### GLM-4.7 — The Chinese-English Bridge

Zhipu AI's GLM-4.7 shines in Chinese-language scenarios while maintaining strong English capability. Reasoning-capable. If your users, documentation, or codebase involves Chinese, this model deserves your attention.

**Best for:** Chinese content generation, Chinese-English translation, reasoning in Chinese context, applications targeting Chinese-speaking users.

### Llama 4 Maverick — Meta's Latest

Meta's newest open-source model represents the current state of the art in open LLMs. Reasoning-capable, well-balanced across benchmarks, and backed by Meta's massive training infrastructure.

**Best for:** General-purpose tasks where you want the most recent open-source capabilities.

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
    model="free/nemotron-ultra-253b",
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
/model free              → Nemotron Ultra 253B (strongest free)
/model deepseek-free     → DeepSeek V3.2
/model mistral-free      → Mistral Large 675B
/model glm-free          → GLM-4.7
/model llama-free        → Llama 4 Maverick
```

Seamless. No config changes. No restarts.

---

## The Honest Limitations

Free models aren't a silver bullet. Here's what you need to know:

### 1. No Verified Tool Calling

None of these 11 models have **structured function calling (tool use) enabled.** If your application depends on tool calling, you need a paid model (GPT-4o, Claude Sonnet, etc.).

### 2. Reasoning Has a Ceiling

Five models are marked reasoning-capable, and they handle most tasks well. But on the hardest problems — competition-level math, formal proofs, deep multi-step planning — they don't match Claude Opus 4 or o3. That's why ClawRouter's REASONING tier doesn't use free models.

### 3. Context Is Large, Not Largest

Most free models offer 128K–256K context (DeepSeek V4 Flash reaches 1M), which is generous for most tasks; but if you're processing entire book collections or massive monorepos, you may still want Gemini's 2M window.

---

## Best Practices: Maximizing Free Models

### Strategy 1: Match Model to Task

Don't use one model for everything. Route by task type:

```
Quick chat, formatting    → GPT-OSS 120B (fastest)
Code generation           → DeepSeek V3.2 or Qwen3 Coder 480B
Reasoning required        → Nemotron Ultra 253B
Chinese content           → GLM-4.7
Multilingual work         → Mistral Large 675B
Latest open-source        → Llama 4 Maverick
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
- **2026:** BlockRun offers 9 free models through a single API

**Nine free models isn't just a product feature — it's a signal.** Baseline AI capability is becoming infrastructure. Like internet bandwidth before it, the cost of "good enough" AI inference is converging toward zero.

BlockRun and ClawRouter exist to be the **routing layer** in this transition: not locked to any single provider, not bound to any single model, always giving developers the lowest-cost path to the right capability.

Today it's 9 free models. Tomorrow it could be 50. Prices will only drop. Capabilities will only improve.

**The one constant: your code doesn't need to change.**

---

## Start Now

```bash
npm install -g @blockrun/clawrouter
clawrouter start
```

Point your `base_url` to `http://localhost:8402/v1`. That's the whole setup.

Nine free models. Up to 1M context. Unlimited calls. Zero cost.

Go build something.

---

_Based on ClawRouter v0.12.84. Model availability may change with future releases. For the latest information, visit [blockrun.ai](https://blockrun.ai)._
