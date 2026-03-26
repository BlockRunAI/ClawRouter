# We Read 100 OpenClaw Issues About OpenRouter. Here's What We Built Instead.

> _OpenRouter is the most popular LLM aggregator. It's also the source of the most frustration in OpenClaw's issue tracker._

![Reading 100 OpenClaw Issues Built a Better Router — We searched OpenClaw's GitHub for "openrouter" and read every result. 100 issues. We didn't find edge cases — we found structural failures.](./assets/clawrouter-100-openclaw-issues-intro.png)

---

## The Data

We searched OpenClaw's GitHub issues for "openrouter" and read every result. 100 issues. Open and closed. Filed by users who ran into the same structural problems over and over:

| Category                        | Issue Count | Representative Issues                                                                                                                                                                                                                              |
| ------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Broken fallback / failover**  | ~20         | [#22136](https://github.com/openclaw/openclaw/issues/22136), [#45663](https://github.com/openclaw/openclaw/issues/45663), [#50389](https://github.com/openclaw/openclaw/issues/50389), [#49079](https://github.com/openclaw/openclaw/issues/49079) |
| **Model ID mangling**           | ~15         | [#49379](https://github.com/openclaw/openclaw/issues/49379), [#50711](https://github.com/openclaw/openclaw/issues/50711), [#25665](https://github.com/openclaw/openclaw/issues/25665), [#2373](https://github.com/openclaw/openclaw/issues/2373)   |
| **Authentication / 401 errors** | ~8          | [#51056](https://github.com/openclaw/openclaw/issues/51056), [#34830](https://github.com/openclaw/openclaw/issues/34830), [#26960](https://github.com/openclaw/openclaw/issues/26960)                                                              |
| **Cost / billing opacity**      | ~6          | [#25371](https://github.com/openclaw/openclaw/issues/25371), [#50738](https://github.com/openclaw/openclaw/issues/50738), [#38248](https://github.com/openclaw/openclaw/issues/38248)                                                              |
| **Routing opacity**             | ~5          | [#7006](https://github.com/openclaw/openclaw/issues/7006), [#35842](https://github.com/openclaw/openclaw/issues/35842)                                                                                                                             |
| **Missing feature parity**      | ~10         | [#46255](https://github.com/openclaw/openclaw/issues/46255), [#50485](https://github.com/openclaw/openclaw/issues/50485), [#30850](https://github.com/openclaw/openclaw/issues/30850)                                                              |
| **Rate limit / key exhaustion** | ~4          | [#8615](https://github.com/openclaw/openclaw/issues/8615), [#48729](https://github.com/openclaw/openclaw/issues/48729)                                                                                                                             |
| **Model catalog staleness**     | ~5          | [#10687](https://github.com/openclaw/openclaw/issues/10687), [#30152](https://github.com/openclaw/openclaw/issues/30152)                                                                                                                           |

These aren't edge cases. They're structural consequences of how OpenRouter works: a middleman that adds latency, mangles model IDs, obscures routing decisions, and introduces its own failure modes on top of the providers it aggregates.

![The Anatomy of Middleman Failure — Treemap showing issue distribution: Broken Fallback (~20), Model ID Mangling (~15), Missing Feature Parity (~10), Authentication/401s (~8), Cost Opacity (~6), Routing Opacity (~5), Model Staleness (~5), Rate Limits (~4). These are the inevitable consequences of a custodial middleman architecture.](./assets/clawrouter-anatomy-of-middleman-failure.png)

![The Architectural Shift: Middleman vs. Local Router — OpenRouter adds latency, translation errors, and hidden limits as a middleman aggregator. ClawRouter moves routing logic locally, eliminating the black box. One hop, not two. Zero translation errors. Total control.](./assets/clawrouter-architectural-shift-middleman-vs-local.png)

---

## 1. Broken Fallback — The #1 Pain Point

From [#45663](https://github.com/openclaw/openclaw/issues/45663):

> _"Provider returned error from OpenRouter does not trigger model failover."_

From [#50389](https://github.com/openclaw/openclaw/issues/50389):

> _"Rate limit errors surfaced to user instead of auto-failover."_

When OpenRouter returns a 429 or provider error, OpenClaw's failover logic often doesn't recognize it as retriable. The user sees a raw error. The agent stops. ~20 issues document variations of this: HTTP 529 (Anthropic overloaded) not triggering fallback ([#49079](https://github.com/openclaw/openclaw/issues/49079)), invalid model IDs causing 400 instead of failover ([#50017](https://github.com/openclaw/openclaw/issues/50017)), timeouts in cron sessions with no recovery ([#49597](https://github.com/openclaw/openclaw/issues/49597)).

### How ClawRouter Solves This

ClawRouter maintains 8-deep fallback chains per routing tier. When a model fails:

1. **200ms retry** — short-burst rate limits often recover in milliseconds
2. **Next model** — if retry fails, move to the next model in the chain
3. **Per-model isolation** — one provider's failure doesn't poison the others
4. **All-failed summary** — if every model in the chain fails, you get a structured error listing every attempt and failure reason

```
[ClawRouter] Trying model 1/6: google/gemini-2.5-flash
[ClawRouter] Model google/gemini-2.5-flash returned 429, retrying in 200ms...
[ClawRouter] Retry failed, trying model 2/6: deepseek/deepseek-chat
[ClawRouter] Success with model: deepseek/deepseek-chat
```

No silent failures. No raw 429s surfaced to the agent.

![Surviving the 429: Cascading Fallback Chains — OpenRouter surfaces raw HTTP 429 errors and the agent stops. ClawRouter maintains 8-deep isolated fallback chains per tier with 200ms retry, per-model isolation, and seamless cascading. No silent failures.](./assets/clawrouter-cascading-fallback-chains-429.png)

---

## 2. Model ID Mangling — Death by Prefix

From [#25665](https://github.com/openclaw/openclaw/issues/25665):

> _"Model config defaults to `openrouter/openrouter/auto` (double prefix)."_

From [#50711](https://github.com/openclaw/openclaw/issues/50711):

> _"Control UI model picker strips `openrouter/` prefix."_

OpenRouter uses nested model IDs: `openrouter/deepseek/deepseek-v3.2`. OpenClaw's UI, Discord bot, and web gateway all handle these differently. Some add the prefix. Some strip it. Some double it. 15 issues trace back to model ID confusion.

### How ClawRouter Solves This

ClawRouter uses clean aliases. You say `sonnet` and get `anthropic/claude-sonnet-4-6`. You say `flash` and get `google/gemini-2.5-flash`. No nested prefixes. No double-prefix bugs.

```typescript
// resolveModelAlias() handles all normalization
"sonnet"     → "anthropic/claude-sonnet-4-6"
"opus"       → "anthropic/claude-opus-4-6"
"flash"      → "google/gemini-2.5-flash"
"grok"       → "xai/grok-4-0314"
"deepseek"   → "deepseek/deepseek-chat"
```

One canonical format. No mangling. No UI inconsistency.

![Eliminating Model ID Mangling — OpenRouter's nested prefixes cause double-prefix bugs (openrouter/openrouter/auto) and UI stripping issues. ClawRouter uses one canonical format with clean aliases: "sonnet" → anthropic/claude-sonnet-4-6, "flash" → google/gemini-2.5-flash.](./assets/clawrouter-eliminating-model-id-mangling.png)

---

## 3. API Key Hell — 401s, Leakage, and Rotation

From [#51056](https://github.com/openclaw/openclaw/issues/51056):

> _"OpenRouter fails with '401 Missing Authentication header' despite valid key."_

From [#8615](https://github.com/openclaw/openclaw/issues/8615):

> _"Feature request: native multi-API-key support with load balancing and fallback."_

API keys are the root cause of an entire category of failures. Keys expire. Keys leak into LLM context (every provider sees every other provider's keys in the serialized request). Keys hit rate limits that can't be load-balanced. 8 issues document auth failures alone.

### How ClawRouter Solves This

ClawRouter has no API keys. Zero.

Payment happens via [x402](https://x402.org/) — a cryptographic micropayment protocol. Your agent generates a wallet on first run (BIP-44 derivation, both EVM and Solana). Each request is signed with the wallet's private key. USDC moves per-request.

```
No keys to leak.
No keys to rotate.
No keys to rate-limit.
No keys to expire.
```

The wallet is the identity. The signature is the authentication. Nothing to configure, nothing to paste into a config file, nothing for the LLM to accidentally serialize.

![Cryptographic Auth: The End of API Key Hell — API keys are exposed in config, serialized into LLM context, share rate limits, and expire. ClawRouter replaces them with BIP-44 EVM/Solana wallets and per-request cryptographic signatures via x402.](./assets/clawrouter-cryptographic-auth-x402-wallet.png)

---

## 4. Cost and Billing Opacity — Surprise Bills

From [#25371](https://github.com/openclaw/openclaw/issues/25371):

> _"OpenRouter 402 billing error misclassified as 'Context overflow', triggering auto-compaction that drains remaining credits faster."_

From [#7006](https://github.com/openclaw/openclaw/issues/7006):

> _"`openrouter/auto` doesn't expose which model was actually used or its cost."_

When OpenRouter runs out of credits, it returns a 402 that OpenClaw misreads as a context overflow. OpenClaw then auto-compacts the context and retries — on the same empty balance. Each retry charges the compaction cost. Credits drain faster. The agent burns money trying to fix a billing error it doesn't understand.

### How ClawRouter Solves This

**Per-request cost visibility.** Every response includes cost headers:

```
x-clawrouter-cost: 0.0034
x-clawrouter-savings: 82%
x-clawrouter-model: google/gemini-2.5-flash
```

**Per-request USDC payments.** No prepaid balance to drain. Each request shows its price before you pay. When the wallet is empty, requests don't fail — they fall back to the free tier (NVIDIA GPT-OSS-120B).

**Budget guard.** `maxCostPerRun` caps per-session spending. Two modes: `graceful` (downgrade to cheaper models) or `strict` (hard stop). The $248/day heartbeat scenario is structurally impossible.

**Usage logging.** Every request logs to `~/.openclaw/blockrun/logs/usage-YYYY-MM-DD.jsonl` with model, tier, cost, baseline cost, savings, and latency. `/stats` shows the breakdown.

![Absolute Cost Visibility & Session Guardrails — No prepaid balances to drain. Every response includes explicit cost headers. JSONL usage logs track every request. maxCostPerRun caps per-session spending. When your wallet empties, you downgrade to the free tier instead of crashing.](./assets/clawrouter-cost-visibility-session-guardrails.png)

---

## 5. Routing Opacity — "Which Model Did I Just Pay For?"

From [#7006](https://github.com/openclaw/openclaw/issues/7006):

> _"No visibility into which model `openrouter/auto` actually uses."_

From [#35842](https://github.com/openclaw/openclaw/issues/35842):

> _"Need explicit Claude Sonnet default instead of auto-routing."_

When you use `openrouter/auto`, you don't know what model served your request. You can't debug quality regressions. You can't understand cost spikes. You're paying for a black box.

### How ClawRouter Solves This

ClawRouter's routing is 100% local, open-source, and transparent.

**14-dimension weighted classifier** runs locally in <1ms. It scores every request across: token count, code presence, reasoning markers, technical terms, multi-step patterns, question complexity, tool signals, and more.

**Debug headers on every response:**

```
x-clawrouter-profile: auto
x-clawrouter-tier: MEDIUM
x-clawrouter-model: moonshot/kimi-k2.5
x-clawrouter-confidence: 0.87
x-clawrouter-reasoning: "Code task with moderate complexity"
```

**SSE debug comments** in streaming responses show the routing decision inline. You always know which model, why it was selected, and how confident the classifier was.

**Four routing profiles** give you explicit control:

| Profile   | Behavior                | Savings |
| --------- | ----------------------- | ------- |
| `auto`    | Balanced quality + cost | 74–100% |
| `eco`     | Cheapest possible       | 95–100% |
| `premium` | Best quality always     | 0%      |
| `free`    | NVIDIA GPT-OSS only     | 100%    |

No black box. No mystery routing. Full visibility, full control.

![Transparent Routing via 14-Dimension Classification — Radar chart showing ClawRouter's local classifier scoring across Token Count, Code Presence, Reasoning Markers, Technical Terms, Multi-step Patterns, and Tool Signals. Executes locally in <1ms with SSE debug headers. Four profiles: auto (balanced), eco (cheapest), premium (best), free (GPT-OSS).](./assets/clawrouter-14-dimension-routing-classification.png)

---

## 6. Missing Feature Parity — Images, Tools, Caching

From [#46255](https://github.com/openclaw/openclaw/issues/46255):

> _"Images not passed to OpenRouter models."_

From [#47707](https://github.com/openclaw/openclaw/issues/47707):

> _"Mistral models fail with strict tool call ID requirements."_

OpenRouter doesn't always pass through provider-specific features correctly. Image payloads get dropped. Cache retention headers get ignored. Tool call ID formats cause silent failures with strict providers.

### How ClawRouter Solves This

**Vision auto-detection.** When `image_url` content parts are detected, ClawRouter automatically filters the fallback chain to vision-capable models only. No images dropped.

**Tool calling validation.** Every model has a `toolCalling` flag. When tools are present in the request, ClawRouter forces agentic routing tiers and excludes models without tool support. No silent tool call failures.

**Direct provider routing.** ClawRouter routes through BlockRun's API directly to providers — not through a second aggregator. One hop, not two. Provider-specific features work because there's no middleman translating them.

![Guaranteed Feature Parity & Direct Connectivity — Three-panel diagram: Vision (image_url auto-detected → vision-capable models only), Tool Calling (toolCalling flag → agentic models only), Catalog (curated 55+ models with automatic legacy-to-modern redirects). Direct provider routing means no dropped payloads.](./assets/clawrouter-feature-parity-direct-connectivity.png)

---

## 7. Model Catalog Staleness — "Where's the New Model?"

From [#10687](https://github.com/openclaw/openclaw/issues/10687):

> _"Need fully dynamic model discovery."_

From [#30152](https://github.com/openclaw/openclaw/issues/30152):

> _"Allowlist silently drops models not in catalog."_

When new models launch, OpenRouter's catalog lags. Users configure a model that exists at the provider but isn't in the catalog. The request fails silently or gets rerouted.

### How ClawRouter Solves This

ClawRouter maintains a curated catalog of 55+ models across 9 providers (including 11 free NVIDIA models), updated with each release. Delisted models have automatic redirect aliases:

```typescript
// Delisted models redirect automatically
"xai/grok-code-fast-1"  → "deepseek/deepseek-chat"
"google/gemini-2.0-pro"  → "google/gemini-3.1-pro"
```

No silent drops. No stale catalog. Models are benchmarked for speed, quality, and tool support before inclusion.

![The Cost/Transparency Nexus — Local routing engine + direct connections + x402 micropayments = 100% transparency = 92% cost savings. Direct Opus routing: $25.00/M tokens. ClawRouter auto-routed: $2.05/M tokens. Transparency and cost savings are two sides of the same architectural coin.](./assets/clawrouter-cost-transparency-nexus-92-savings.png)

---

## The Full Comparison

|                     | OpenRouter                       | ClawRouter                                     |
| ------------------- | -------------------------------- | ---------------------------------------------- |
| **Authentication**  | API key (leak risk)              | Wallet signature (no keys)                     |
| **Payment**         | Prepaid balance (custodial)      | Per-request USDC (non-custodial)               |
| **Routing**         | Server-side black box            | Local 14-dim classifier, <1ms                  |
| **Fallback**        | Often broken (20+ issues)        | 8-deep chains, per-model isolation             |
| **Model IDs**       | Nested prefixes, mangling bugs   | Clean aliases, single format                   |
| **Cost visibility** | None per-request                 | Headers + JSONL logs + `/stats`                |
| **Empty wallet**    | Request fails                    | Auto-fallback to free tier                     |
| **Rate limits**     | Per-key, shared                  | Per-wallet, independent                        |
| **Vision support**  | Images sometimes dropped         | Auto-detected, vision-only fallback            |
| **Tool calling**    | Silent failures with some models | Flag-based filtering, guaranteed support       |
| **Model catalog**   | Laggy, silent drops              | Curated 55+ models, redirect aliases           |
| **Budget control**  | Monthly invoice                  | Per-session cap (`maxCostPerRun`)              |
| **Setup**           | Create account, paste key        | Agent generates wallet, auto-configured        |
| **Average cost**    | $25/M tokens (Opus direct)       | $2.05/M tokens (auto-routed) = **92% savings** |

![The Engineering Matrix — Side-by-side feature comparison: OpenRouter vs ClawRouter across Routing, Authentication, Payment, Fallback, Model IDs, Empty Wallet, Vision/Tools, and Average Cost. ClawRouter wins on every dimension.](./assets/clawrouter-engineering-matrix-comparison.png)

---

## Getting Started

```bash
# Install
npm install -g @blockrun/clawrouter

# Start (auto-configures OpenClaw)
clawrouter

# Check your wallet
# /wallet

# View routing stats
# /stats
```

ClawRouter auto-injects itself into `~/.openclaw/openclaw.json` as a provider on startup. Your existing tools, sessions, and extensions are unchanged.

Load a wallet with USDC on Base or Solana, pick a routing profile, and run.

![Frictionless Integration — npm install -g @blockrun/clawrouter, auto-injected provider into ~/.openclaw/openclaw.json. No code rewrites. Your existing tools, sessions, and extensions remain entirely unchanged.](./assets/clawrouter-frictionless-integration.png)

---

_[github.com/BlockRunAI/ClawRouter](https://github.com/BlockRunAI/ClawRouter) · [blockrun.ai](https://blockrun.ai) · `npm install -g @blockrun/clawrouter`_
