# We Benchmarked 39 AI Models Through Our Payment Gateway. Here's What We Found.

_March 16, 2026 | BlockRun Engineering_

> **Numbers in this post are a snapshot from the date above.** They record what was
> measured then and are deliberately not updated — rewriting them would misrepresent
> the benchmark. For current figures see
> [blockrun.ai/brand/numbers.json](https://blockrun.ai/brand/numbers.json).

Last week we ran every model on BlockRun through a real-world latency benchmark — 39 models, same prompts, same payment pipeline, same hardware. No cherry-picked results. No synthetic lab conditions. Just cold, hard numbers from production infrastructure.

The results changed how we route requests.

## Why We Did This

BlockRun is an x402 micropayment gateway that sits between your AI agent and 39+ LLM providers. Every request flows through our payment verification layer before hitting the model API. That means our latency numbers include everything a real user experiences: payment auth, provider API call, and response delivery.

Most benchmarks measure model speed in isolation. We wanted to measure what users actually feel.

## The Leaderboard

We sent 2 coding prompts per model (256 max tokens, non-streaming) and measured end-to-end response time.

### Speed Rankings (End-to-End Latency Through BlockRun)

| #   | Model                           | Latency | Tok/s | $/1M in | $/1M out |
| --- | ------------------------------- | ------- | ----- | ------- | -------- |
| 1   | xai/grok-4-fast-non-reasoning   | 1,143ms | 224   | $0.20   | $0.50    |
| 2   | xai/grok-3-mini                 | 1,202ms | 215   | $0.30   | $0.50    |
| 3   | google/gemini-2.5-flash         | 1,238ms | 208   | $0.15   | $0.60    |
| 4   | xai/grok-3                      | 1,244ms | 207   | $3.00   | $15.00   |
| 5   | xai/grok-4-1-fast-non-reasoning | 1,244ms | 206   | $0.20   | $0.50    |
| 6   | nvidia/gpt-oss-120b             | 1,252ms | 204   | FREE    | FREE     |
| 7   | minimax/minimax-m2.5            | 1,278ms | 202   | $0.30   | $1.10    |
| 8   | google/gemini-2.5-pro           | 1,294ms | 198   | $1.25   | $10.00   |
| 9   | xai/grok-4-fast-reasoning       | 1,298ms | 198   | $0.20   | $0.50    |
| 10  | xai/grok-4-0709                 | 1,348ms | 190   | $0.20   | $1.50    |
| 11  | google/gemini-3-pro-preview     | 1,352ms | 190   | $1.25   | $10.00   |
| 12  | google/gemini-2.5-flash-lite    | 1,353ms | 193   | $0.10   | $0.40    |
| 13  | google/gemini-3-flash-preview   | 1,398ms | 183   | $0.15   | $0.60    |
| 14  | deepseek/deepseek-chat          | 1,431ms | 179   | $0.27   | $1.10    |
| 15  | deepseek/deepseek-reasoner      | 1,454ms | 183   | $0.55   | $2.19    |
| 16  | xai/grok-4-1-fast-reasoning     | 1,454ms | 176   | $0.20   | $0.50    |
| 17  | google/gemini-3.1-pro           | 1,609ms | 167   | $1.25   | $10.00   |
| 18  | moonshot/kimi-k2.5              | 1,646ms | 156   | $0.60   | $3.00    |
| 19  | anthropic/claude-sonnet-4.6     | 2,110ms | 121   | $3.00   | $15.00   |
| 20  | anthropic/claude-opus-4.6       | 2,139ms | 120   | $15.00  | $75.00   |
| 21  | openai/o3-mini                  | 2,260ms | 114   | $1.10   | $4.40    |
| 22  | openai/gpt-5-mini               | 2,264ms | 114   | $1.10   | $4.40    |
| 23  | anthropic/claude-haiku-4.5      | 2,305ms | 141   | $0.80   | $4.00    |
| 24  | openai/o4-mini                  | 2,328ms | 111   | $1.10   | $4.40    |
| 25  | openai/gpt-4.1-mini             | 2,340ms | 109   | $0.40   | $1.60    |
| 26  | openai/o1                       | 2,562ms | 100   | $15.00  | $60.00   |
| 27  | openai/gpt-4.1-nano             | 2,640ms | 97    | $0.10   | $0.40    |
| 28  | openai/o1-mini                  | 2,746ms | 93    | $1.10   | $4.40    |
| 29  | openai/gpt-4o-mini              | 2,764ms | 93    | $0.15   | $0.60    |
| 30  | openai/o3                       | 2,862ms | 90    | $2.00   | $8.00    |
| 31  | openai/gpt-5-nano               | 3,187ms | 81    | $0.50   | $2.00    |
| 32  | openai/gpt-5.2-pro              | 3,546ms | 73    | $2.50   | $10.00   |
| 33  | openai/gpt-4o                   | 5,378ms | 48    | $2.50   | $10.00   |
| 34  | openai/gpt-4.1                  | 5,477ms | 47    | $2.00   | $8.00    |
| 35  | openai/gpt-5.3                  | 5,910ms | 43    | $2.50   | $10.00   |
| 36  | openai/gpt-5.4                  | 6,213ms | 41    | $2.50   | $15.00   |
| 37  | openai/gpt-5.2                  | 6,507ms | 40    | $2.50   | $10.00   |
| 38  | openai/gpt-5.4-pro              | 6,671ms | 40    | $2.50   | $15.00   |
| 39  | openai/gpt-5.3-codex            | 7,935ms | 32    | $2.50   | $10.00   |

## Three Things That Surprised Us

### 1. xAI Grok is Absurdly Fast

Grok 4 Fast clocked in at **1,143ms** end-to-end. That's the full round trip: payment verification, API call, response. For context, OpenAI's GPT-5.4 took **6,213ms** for the same request — nearly **6x slower**.

The entire xAI lineup dominated the top of the leaderboard. Five of the top 10 fastest models are from xAI. At $0.20 per million input tokens, they're also among the cheapest.

### 2. Google Gemini Owns the Efficiency Frontier

Gemini 2.5 Flash delivered **1,238ms** latency at **$0.15/$0.60** per million tokens. For simple tasks, it's the clear winner on cost-per-quality.

But here's what's more impressive: Gemini 2.5 Pro came in at **1,294ms** — barely slower than Flash — while scoring significantly higher on intelligence benchmarks. Google's infrastructure advantage is showing.

Six Google models landed in the top 13. No other provider came close to that kind of lineup depth.

### 3. OpenAI Flagship Models Are Surprisingly Slow

Every OpenAI model with "5.x" in the name landed in the bottom third of the leaderboard. GPT-5.3 Codex was dead last at **7,935ms**. Even GPT-4o, a model from 2024, took over 5 seconds.

OpenAI's "mini" and "nano" variants are faster (2.2-3.2s range) but still 2x slower than the fastest competitors. The speed gap is real and consistent across their entire lineup.

## Speed vs. Intelligence: The Tradeoff That Broke Our Routing

We cross-referenced our latency data with quality scores from [Artificial Analysis](https://artificialanalysis.ai/leaderboards/models) (Intelligence Index v4.0):

| Model                  | BlockRun Latency | Intelligence Index | Price Tier  |
| ---------------------- | ---------------- | ------------------ | ----------- |
| Gemini 3.1 Pro         | 1,609ms          | 57                 | $1.25/$10   |
| GPT-5.4                | 6,213ms          | 57                 | $2.50/$15   |
| GPT-5.3 Codex          | 7,935ms          | 54                 | $2.50/$10   |
| Claude Opus 4.6        | 2,139ms          | 53                 | $15/$75     |
| Claude Sonnet 4.6      | 2,110ms          | 52                 | $3/$15      |
| Kimi K2.5              | 1,646ms          | 47                 | $0.60/$3    |
| Gemini 3 Flash Preview | 1,398ms          | 46                 | $0.15/$0.60 |
| Grok 4                 | 1,348ms          | 41                 | $0.20/$1.50 |
| Grok 4.1 Fast          | 1,244ms          | 41                 | $0.20/$0.50 |
| DeepSeek V3            | 1,431ms          | 32                 | $0.27/$1.10 |
| Grok 3                 | 1,244ms          | 32                 | $3/$15      |
| Grok 4 Fast            | 1,143ms          | 23                 | $0.20/$0.50 |
| Gemini 2.5 Flash       | 1,238ms          | 20                 | $0.15/$0.60 |

**Gemini 3.1 Pro** is the standout: highest intelligence score (57) at just 1.6 seconds. GPT-5.4 matches its intelligence but takes **4x longer**.

We initially used these numbers to promote fast models (Grok 4 Fast, Grok 4.1 Fast) as our default routing targets. It backfired. Users reported that the fast models were refusing complex tasks and giving shallow responses. Fast and cheap doesn't mean capable.

The fix: we now weight **quality and user retention** alongside speed in our routing algorithm. Gemini 2.5 Flash became our default for simple tasks (fast, cheap, reliable), while Kimi K2.5 handles medium-complexity work and Claude/GPT flagships handle the hard stuff.

## What This Means for Developers

**If you're building agents:** Don't default to GPT. At 5-7 seconds per call, your agent's chain-of-actions will feel sluggish. Route simple subtasks to Grok/Gemini Flash and save the flagships for reasoning-heavy steps.

**If you're cost-sensitive:** Gemini 2.5 Flash-Lite at $0.10/$0.40 with 1.35s latency is the budget king. DeepSeek Chat at $0.27/$1.10 with 1.43s is a close second.

**If you need peak intelligence:** Gemini 3.1 Pro (IQ 57, 1.6s) gives you the same quality as GPT-5.4 (IQ 57, 6.2s) at one-quarter the latency and lower cost. Claude Opus 4.6 (IQ 53, 2.1s) is the best option if you need Anthropic-family capabilities.

**If you want it all handled for you:** That's what BlockRun's smart router does. Set your profile to `auto` and we'll pick the right model based on task complexity, balancing speed, quality, and cost automatically.

## Methodology

- **Date:** March 16, 2026
- **Setup:** BlockRun ClawRouter v0.12.47 proxy on localhost, connected to BlockRun's x402 payment gateway on Base (EVM)
- **Prompts:** 3 Python coding tasks (IPv4 validation, LCS algorithm, LRU cache), 2 requests per model
- **Config:** 256 max tokens, non-streaming, temperature 0.7
- **Latency:** End-to-end wall clock time including x402 payment verification (~50-100ms overhead)
- **Intelligence scores:** [Artificial Analysis Intelligence Index v4.0](https://artificialanalysis.ai/leaderboards/models) (March 2026)

Raw benchmark data: [benchmark-results.json](https://github.com/BlockRunAI/ClawRouter/blob/main/benchmark-results.json)

---

_BlockRun is the x402 micropayment gateway for AI. One wallet, 39+ models, pay-per-request with USDC. [Get started](https://blockrun.ai)_

---

## Twitter Thread

**Thread: We benchmarked 39 AI models through our payment gateway. The speed differences are wild. (thread)**

**1/** We ran every model on @BlockRunAI through a real-world latency benchmark. 39 models, same prompts, full payment pipeline included.

The fastest model (Grok 4 Fast) was 7x faster than the slowest (GPT-5.3 Codex). Here's the full breakdown:

**2/** Top 5 fastest (end-to-end latency):

1. xai/grok-4-fast — 1,143ms
2. xai/grok-3-mini — 1,202ms
3. google/gemini-2.5-flash — 1,238ms
4. xai/grok-3 — 1,244ms
5. nvidia/gpt-oss-120b — 1,252ms (FREE)

**3/** Bottom 5 (all OpenAI): 35. openai/gpt-5.3 — 5,910ms 36. openai/gpt-5.4 — 6,213ms 37. openai/gpt-5.2 — 6,507ms 38. openai/gpt-5.4-pro — 6,671ms 39. openai/gpt-5.3-codex — 7,935ms

Every OpenAI 5.x model: 5-8 seconds. Every Grok/Gemini model: ~1.2 seconds.

**4/** But speed isn't everything.

We tried routing all requests to the fastest models. Users complained the "fast" models refused complex tasks and gave shallow answers.

Lesson: you need to balance speed, quality, AND cost.

**5/** The efficiency frontier winners:

- Best overall: Gemini 3.1 Pro (IQ 57, 1.6s, $1.25/M)
- Best budget: Gemini 2.5 Flash (IQ 20, 1.2s, $0.15/M)
- Best reasoning: Claude Opus 4.6 (IQ 53, 2.1s, $15/M)
- Best speed/quality: Kimi K2.5 (IQ 47, 1.6s, $0.60/M)

**6/** This is why we built smart routing into BlockRun.

Set `model: "auto"` and we pick the right model based on task complexity. Simple tasks get Gemini Flash. Complex reasoning gets Claude/GPT flagships.

One wallet. 39 models. The router handles the rest.

**7/** Full leaderboard, methodology, and raw data in our blog post: [link]

All 39 models benchmarked through real x402 micropayment infrastructure. No synthetic lab conditions.

Build with @BlockRunAI: blockrun.ai
