/**
 * BlockRun Model Definitions for OpenClaw
 *
 * Maps BlockRun's 55+ AI models to OpenClaw's ModelDefinitionConfig format.
 * All models use the "openai-completions" API since BlockRun is OpenAI-compatible.
 *
 * Pricing is in USD per 1M tokens. Operators pay these rates via x402;
 * they set their own markup when reselling to end users (Phase 2).
 */

import type { ModelDefinitionConfig, ModelProviderConfig } from "./types.js";
import { TOP_MODELS } from "./top-models.js";

/**
 * Model aliases for convenient shorthand access.
 * Users can type `/model claude` instead of `/model blockrun/anthropic/claude-sonnet-4-6`.
 */
export const MODEL_ALIASES: Record<string, string> = {
  // Claude - flagship opus is 5; bare sonnet stays at 4.6 (sonnet-5 is opt-in
  // via explicit `sonnet-5` — not promoted to the bare alias pending benchmarks)
  claude: "anthropic/claude-sonnet-4.6",
  "br-sonnet": "anthropic/claude-sonnet-4.6",
  sonnet: "anthropic/claude-sonnet-4.6",
  "sonnet-4": "anthropic/claude-sonnet-4.6",
  "sonnet-4.6": "anthropic/claude-sonnet-4.6",
  "sonnet-4-6": "anthropic/claude-sonnet-4.6",
  // Sonnet 5 — newest Sonnet, near-Opus quality at Sonnet cost (opt-in)
  "sonnet-5": "anthropic/claude-sonnet-5",
  "sonnet-5.0": "anthropic/claude-sonnet-5",
  "sonnet-5-0": "anthropic/claude-sonnet-5",
  // Explicit 4.5 pins (distinct model upstream, same pricing as 4.6)
  "sonnet-4.5": "anthropic/claude-sonnet-4.5",
  "sonnet-4-5": "anthropic/claude-sonnet-4.5",
  "anthropic/claude-sonnet-4-5": "anthropic/claude-sonnet-4.5",
  // claude-fable-5 RE-ENABLED 2026-07-06 — Anthropic restored the offer upstream
  // (delisted 2026-06-13, both direct-Anthropic and Bedrock re-probed HTTP 200).
  // BlockRun relisted it, so the fable → opus-4.8 redirect is retired and these
  // land on the real model again. Note: `anthropic/claude-fable-5` must NOT be an
  // alias key — it is a live catalog id, and alias keys shadow catalog entries.
  fable: "anthropic/claude-fable-5",
  "fable-5": "anthropic/claude-fable-5",
  "fable-5.0": "anthropic/claude-fable-5",
  // Opus 5 (2026-07-24) takes the bare `opus` alias: identical $5/$25 and the
  // same 1M/128K envelope as 4.8, so a wallet with a per-call cost cap sees no
  // change in how a request is priced or sized — the promotion cannot push a
  // caller through a cap. BlockRun repointed `clawrouter-premium` → opus-5 for
  // the same reason. (Unit price only: adaptive thinking may emit more output
  // tokens per call, which raises realized spend without changing the cap math.)
  // `opus-4` and
  // `anthropic/claude-opus-4` stay on 4.8 — they name the 4-series generation.
  // Note: `anthropic/claude-opus-5` must NOT be an alias key (see fable note).
  opus: "anthropic/claude-opus-5",
  "opus-5": "anthropic/claude-opus-5",
  "opus-5.0": "anthropic/claude-opus-5",
  "opus-5-0": "anthropic/claude-opus-5",
  "opus-4": "anthropic/claude-opus-4.8",
  "opus-4.8": "anthropic/claude-opus-4.8",
  "opus-4-8": "anthropic/claude-opus-4.8",
  "opus-4.7": "anthropic/claude-opus-4.7",
  "opus-4-7": "anthropic/claude-opus-4.7",
  "opus-4.6": "anthropic/claude-opus-4.6",
  "opus-4-6": "anthropic/claude-opus-4.6",
  haiku: "anthropic/claude-haiku-4.5",
  // Claude - provider/shortname patterns (common in agent frameworks)
  "anthropic/sonnet": "anthropic/claude-sonnet-4.6",
  // fable-5 relisted 2026-07-06 (see note above)
  "anthropic/fable": "anthropic/claude-fable-5",
  "anthropic/claude-fable-5.0": "anthropic/claude-fable-5",
  "anthropic/opus": "anthropic/claude-opus-5",
  "anthropic/claude-opus-5.0": "anthropic/claude-opus-5",
  "anthropic/claude-opus-5-0": "anthropic/claude-opus-5",
  "anthropic/haiku": "anthropic/claude-haiku-4.5",
  "anthropic/claude": "anthropic/claude-sonnet-4.6",
  // Backward compatibility - generic opus-4 and older flagships point at 4.8;
  // explicit version pins (claude-opus-4-7) stay on their version since server still routes them.
  "anthropic/claude-sonnet-4": "anthropic/claude-sonnet-4.6",
  "anthropic/claude-sonnet-4-6": "anthropic/claude-sonnet-4.6",
  "anthropic/claude-opus-4": "anthropic/claude-opus-4.8",
  "anthropic/claude-opus-4-8": "anthropic/claude-opus-4.8",
  "anthropic/claude-opus-4-7": "anthropic/claude-opus-4.7",
  "anthropic/claude-opus-4-6": "anthropic/claude-opus-4.6",
  "anthropic/claude-opus-4-5": "anthropic/claude-opus-4.5",
  "anthropic/claude-haiku-4": "anthropic/claude-haiku-4.5",
  "anthropic/claude-haiku-4-5": "anthropic/claude-haiku-4.5",

  // OpenAI
  gpt: "openai/gpt-4o",
  gpt4: "openai/gpt-4o",
  // GPT-5.6 (GA 2026-07-09) is the newest flagship generation. Generic shorthands
  // resolve to the STABLE Terra tier, not the deepest Sol tier — Sol has shown
  // upstream server_error/500s after ~250s waits (issue #202). Explicit tier pins
  // below stay exact so callers who want Sol/Luna can opt in.
  gpt5: "openai/gpt-5.6-terra",
  "gpt-5.6": "openai/gpt-5.6-terra",
  "openai/gpt-5.6": "openai/gpt-5.6-terra",
  "gpt-5.6-sol": "openai/gpt-5.6-sol",
  "gpt-5.6-terra": "openai/gpt-5.6-terra",
  "gpt-5.6-luna": "openai/gpt-5.6-luna",
  // Pro reasoning tiers (2026-08-03). Explicit pins only — the generic
  // shorthands above stay on standard Terra.
  "gpt-5.6-sol-pro": "openai/gpt-5.6-sol-pro",
  "gpt-5.6-terra-pro": "openai/gpt-5.6-terra-pro",
  "gpt-5.6-luna-pro": "openai/gpt-5.6-luna-pro",
  "sol-pro": "openai/gpt-5.6-sol-pro",
  "terra-pro": "openai/gpt-5.6-terra-pro",
  "luna-pro": "openai/gpt-5.6-luna-pro",
  "gpt-5.5": "openai/gpt-5.5",
  "gpt-5.5-pro": "openai/gpt-5.5-pro",
  // ChatGPT Instant. `chat-latest` is a rolling upstream id — pinning it means
  // "whatever ChatGPT's default is today", not a fixed snapshot.
  "chat-latest": "openai/chat-latest",
  chatgpt: "openai/chat-latest",
  "gpt-5.4": "openai/gpt-5.4",
  "gpt-5.4-pro": "openai/gpt-5.4-pro",
  "gpt-5.4-nano": "openai/gpt-5.4-nano",
  nano: "openai/gpt-5.4-nano",
  "gpt-5-nano": "openai/gpt-5.4-nano",
  codex: "openai/gpt-5.3-codex",
  mini: "openai/gpt-4o-mini",
  o1: "openai/o1",
  // o1-mini delisted by OpenAI 2026-06-06 — mirror the gateway redirect.
  "openai/o1-mini": "openai/o4-mini",
  "o1-mini": "openai/o4-mini",
  o3: "openai/o3",
  // OpenAI Codex prefix aliases (OpenClaw v2026.4.5 openai-codex/ model ID format)
  "openai-codex/gpt-5.4-mini": "openai/gpt-5.4-mini",
  "gpt-5.4-mini": "openai/gpt-5.4-mini",

  // DeepSeek
  deepseek: "deepseek/deepseek-chat",
  "deepseek-chat": "deepseek/deepseek-chat",
  reasoner: "deepseek/deepseek-reasoner",

  // Kimi / Moonshot — K3 is the featured flagship on BlockRun (added 2026-07-17; K2.7
  // hidden/superseded, K2.6 hidden, K2.5 hidden). K3 is ~5x K2.7's price ($3/$15 vs
  // $0.95/$4.00), so the BARE aliases deliberately STAY on K2.7 — repointing them to K3
  // would silently ~5x every generic-`kimi` quote and break per-call-cap wallets (mirrors
  // blockrun's own alias decision). Address the flagship explicitly via "kimi-k3". Explicit
  // pins for "kimi-k2.6" / "kimi-k2.5" still resolve to those exact models (K2.5 is a
  // cost-stability opt-in at $0.60/$3.00). NVIDIA-hosted K2.5 was retired 2026-04-21.
  kimi: "moonshot/kimi-k2.7",
  moonshot: "moonshot/kimi-k2.7",
  "kimi-k3": "moonshot/kimi-k3",
  "kimi-k2": "moonshot/kimi-k2.7",
  "kimi-k2.7": "moonshot/kimi-k2.7",
  "kimi-k2.6": "moonshot/kimi-k2.6",
  "kimi-k2.5": "moonshot/kimi-k2.5",
  "nvidia/kimi-k2.5": "moonshot/kimi-k2.5",

  // Qwen — Qwen3.7 Max is Alibaba's current flagship for reasoning, coding,
  // and agentic tool use. EXPLICIT PINS ONLY: bare `qwen` deliberately stays
  // unbound. Every other qwen* shorthand below points at a FREE model
  // (qwen-coder, qwen-thinking, qwen3-next, qwen3.5-122b), so binding the
  // shortest name to a $1.475/$4.425 flagship would silently charge callers
  // who typed it expecting the free tier — same rule that keeps generic
  // `kimi` on K2.7. (`grok` WAS promoted to 4.5, but only after the cost
  // tradeoff was argued explicitly; there's no such case for qwen yet.)
  "qwen3.7-max": "qwen/qwen3.7-max",
  // Qwen3.8 Flash — newer generation than the whole 3.7 line, and cheaper than
  // the 3.7-plus tier it beats. Bare `qwen` stays UNBOUND (every other qwen*
  // shorthand resolves to a free model, so binding the short name to a paid
  // flagship would bill callers expecting free).
  "qwen3.8-flash": "qwen/qwen3.8-flash",
  "qwen3-8-flash": "qwen/qwen3.8-flash",
  "qwen-vision": "qwen/qwen3.8-flash",
  // DeepSeek's first image-capable SKU. Bare `deepseek` stays on deepseek-chat.
  "deepseek-vision": "deepseek/deepseek-v4-flash-vision-exp",
  "v4-flash-vision": "deepseek/deepseek-v4-flash-vision-exp",
  // Xiaomi MiMo V2.5 — the natively multimodal SKU, distinct from mimo-v2.5-pro
  // (text-only upstream). `mimo` stays on the Pro entry it has always named.
  "mimo-vision": "xiaomi/mimo-v2.5",
  "qwen-3.7-max": "qwen/qwen3.7-max",
  "qwen3-7-max": "qwen/qwen3.7-max",
  // Plus/Flash tiers (2026-08-03) — explicit pins, same rule as Max.
  "qwen3.7-plus": "qwen/qwen3.7-plus",
  "qwen-3.7-plus": "qwen/qwen3.7-plus",
  "qwen3.7-flash": "qwen/qwen3.7-flash",
  "qwen-3.7-flash": "qwen/qwen3.7-flash",

  // Tencent + Xiaomi (2026-07-25) — each maker has exactly one model, so the
  // bare maker names are safe to bind.
  hy3: "tencent/hy3",
  tencent: "tencent/hy3",
  hunyuan: "tencent/hy3",
  mimo: "xiaomi/mimo-v2.5-pro",
  "mimo-v2.5-pro": "xiaomi/mimo-v2.5-pro",
  // RETARGETED 2026-08-30, Pro -> the real thing. This key used to point at
  // `xiaomi/mimo-v2.5-pro`, which was harmless while no model owned the name —
  // but blockrun then listed an actual `xiaomi/mimo-v2.5`, a DIFFERENT and
  // natively-multimodal SKU at $0.14/$0.28 against Pro's $0.435/$0.87. Leaving
  // it would have billed 3x for the text-only model when the caller named the
  // cheaper multimodal one. (The key itself is safe: it is not equal to the
  // catalog id, so it shadows nothing — the rule that bans `opus-5`-style keys
  // does not apply to a bare shorthand.)
  "mimo-v2.5": "xiaomi/mimo-v2.5",
  xiaomi: "xiaomi/mimo-v2.5-pro",

  // Google
  // gemini-3-pro-preview delisted by Google 2026-06-06 — mirror the gateway
  // redirect to its successor so pinned callers land on 3.1-pro, not an error.
  "google/gemini-3-pro-preview": "google/gemini-3.1-pro",
  "gemini-3-pro-preview": "google/gemini-3.1-pro",
  // Bare Pro shorthands — `gemini-3-pro` was never a real id (the 3-series Pro
  // shipped as the -preview above, then 3.1), but callers reach for it anyway.
  // Point them at the current Pro instead of a 400. (Thanks @0xCheetah1, #206.)
  "gemini-pro": "google/gemini-3.1-pro",
  "gemini-3-pro": "google/gemini-3.1-pro",
  "gemini-3.1-pro": "google/gemini-3.1-pro",
  gemini: "google/gemini-2.5-pro",
  flash: "google/gemini-2.5-flash",
  "gemini-3.1-pro-preview": "google/gemini-3.1-pro",
  "google/gemini-3.1-pro-preview": "google/gemini-3.1-pro",
  "gemini-3.6-flash": "google/gemini-3.6-flash",
  "gemini-3.6": "google/gemini-3.6-flash",
  "gemini-3.5-flash": "google/gemini-3.5-flash",
  "gemini-3.5-flash-lite": "google/gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite": "google/gemini-3.1-flash-lite",
  "gemini-2.5-flash-lite": "google/gemini-2.5-flash-lite",

  // xAI — grok-4.3 is the public flagship since 2026-06-04 (grok-3 and the
  // 4-fast/4-1-fast families are hidden in the backend catalog; direct full
  // IDs still resolve for pinned users).
  // `grok` tracks xAI's current flagship, promoted to 4.5 on 2026-07-14 (added
  // upstream 2026-07-13). This is a deliberate cost increase: 4.5 is $2.50/$9.00
  // vs 4.3's $1.50/$4.00, and upstream re-prices the WHOLE request at $5/$18 once
  // prompt tokens reach 200K. What it buys is a direct-xAI SKU — 4.3 is
  // OpenRouter-only and silently drops Live Search. Pin `grok-4.3` to opt out.
  grok: "xai/grok-4.5",
  "grok-4.5": "xai/grok-4.5",
  "grok-4-5": "xai/grok-4.5",
  "grok-4.3": "xai/grok-4.3",
  "grok-fast": "xai/grok-4-fast-reasoning",
  "grok-build": "xai/grok-build-0.1",
  "grok-code": "xai/grok-build-0.1", // xAI's agentic coding model (Build 0.1, 2026-06-04)
  // Delisted model redirects — full model IDs that were previously valid but removed
  "grok-code-fast-1": "deepseek/deepseek-chat", // bare alias (delisted SKU, kept on cheap chat)
  "xai/grok-code-fast-1": "deepseek/deepseek-chat", // delisted 2026-03-12
  "xai/grok-3-fast": "xai/grok-4-fast-reasoning", // delisted (too expensive)

  // NVIDIA — backward compat aliases (nvidia/xxx → free/xxx)
  // Default free model is nemotron-3.5-lightning — the same model
  // @blockrun/router-core opens the eco SIMPLE tier on. It replaced
  // step-3.7-flash on 2026-08-30, when NVIDIA retired FOUR of the five visible
  // free models in a single sweep (blockrun #448): step-3.7-flash,
  // nemotron-nano-9b-v2 and nemotron-nano-12b-v2-vl all published 410 Gone, and
  // mistral-nemotron went the quiet way — still listed, >150s and zero bytes.
  // We follow blockrun's own retarget of step-3.7-flash rather than picking a
  // different survivor, so the proxy and the gateway name the same model.
  //
  // gpt-oss-120b/20b RECOVERED on the same probe run and are reachable again,
  // but they stay withheld from blockrun's public catalog over NVIDIA's
  // prompt-retention terms — so pins that NAME gpt-oss stay routable below and
  // nothing generic may land on it.
  nvidia: "free/nemotron-3.5-lightning",
  "gpt-120b": "free/gpt-oss-120b", // names the model itself — gateway redirects
  "gpt-20b": "free/gpt-oss-20b",
  "nvidia/gpt-oss-120b": "free/gpt-oss-120b",
  "nvidia/gpt-oss-20b": "free/gpt-oss-20b",
  // deepseek free family: v4-flash EOL'd 2026-08-12 (HTTP 410 from NVIDIA on both
  // probe passes; prod gate fired [ALERT][free-model-dead] kind=gone twice that
  // morning). The whole nvidia/deepseek-* family is now dead upstream — blockrun
  // hid flash and retargeted v3.2/v4-pro (whose redirects chained through flash)
  // straight to gpt-oss-120b. Ids naming v4-flash itself keep the real id (the
  // gateway redirects them); the v3.2/v4-pro ids follow blockrun's retarget
  // rather than chaining through a second dead model.
  "nvidia/deepseek-v3.2": "free/nemotron-3.5-lightning",
  "free/deepseek-v3.2": "free/nemotron-3.5-lightning",
  "nvidia/deepseek-v4-pro": "free/nemotron-3.5-lightning",
  "free/deepseek-v4-pro": "free/nemotron-3.5-lightning",
  "nvidia/deepseek-v4-flash": "free/deepseek-v4-flash",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning": "free/nemotron-3-nano-omni-30b-a3b-reasoning",
  // qwen3-coder-480b retired (NVIDIA EOL 2026-06-14). Its server-side redirect used
  // to be seed-oss-36b, but that EOL'd too on 2026-08-03, so blockrun re-pointed it
  // at gpt-oss-120b. Keep the explicit id mappings for pinned callers (BlockRun still
  // resolves them); the generic coding shorthands follow the gateway to gpt-oss-120b.
  "nvidia/qwen3-coder-480b": "free/qwen3-coder-480b",
  "qwen/qwen3-coder-480b-a35b-instruct": "free/qwen3-coder-480b",
  // glm-4.7 pin keeps the real id — blockrun redirects it server-side (→ gpt-oss-120b).
  "nvidia/glm-4.7": "free/glm-4.7",
  "nvidia/llama-4-maverick": "free/llama-4-maverick",
  // qwen3-next: both variants died in the 2026-07-17 re-probe; pins keep the id
  // (blockrun redirects them server-side to gpt-oss-120b).
  "nvidia/qwen3-next-80b-a3b-thinking": "free/qwen3-next-80b-a3b-instruct",
  "nvidia/qwen3-next-80b-a3b-instruct": "free/qwen3-next-80b-a3b-instruct",
  "nvidia/seed-oss-36b": "free/seed-oss-36b",
  "nvidia/mistral-nemotron": "free/mistral-nemotron",
  "nvidia/step-3.7-flash": "free/step-3.7-flash",
  "nvidia/nemotron-nano-9b-v2": "free/nemotron-nano-9b-v2",
  "nvidia/nemotron-nano-12b-v2-vl": "free/nemotron-nano-12b-v2-vl",
  // nvidia/mistral-small-4-119b: no local redirect — recovered in the 2026-07-17
  // re-probe and blockrun removed its server redirect, so pinned callers reach the
  // real model again (upstream fallbackModel + health gate cover a relapse).
  // Retired free IDs → successors (mirror blockrun's 2026-07-17 redirect map:
  // ultra-253b redirects to gpt-oss-120b; the two supers have NO server redirect —
  // they stay hidden-but-routable, so their pins pass through to the real ids).
  "nvidia/nemotron-ultra-253b": "free/nemotron-3.5-lightning",
  // mistral-large-3-675b un-retired 2026-06-14, then EOL'd for good 2026-07-28:
  // blockrun's re-probe got HTTP 410 Gone from NVIDIA on both passes (baa967b).
  // Pin stays routable — the gateway redirects it to gpt-oss-120b.
  "nvidia/mistral-large-3-675b": "free/mistral-large-3-675b",
  "nvidia/qwen3.5-122b-a10b": "free/qwen3.5-122b-a10b",
  // devstral-2-123b died upstream; blockrun redirects it to gpt-oss-120b (2026-07-17 map)
  "nvidia/devstral-2-123b": "free/nemotron-3.5-lightning",
  "free/nemotron-ultra-253b": "free/nemotron-3.5-lightning",
  "free/devstral-2-123b": "free/nemotron-3.5-lightning",
  // Explicit-ish pins — dead upstream since 2026-07-28, gateway redirects to gpt-oss-120b
  "mistral-large": "free/mistral-large-3-675b",
  "mistral-large-3-675b": "free/mistral-large-3-675b",
  "qwen3.5-122b": "free/qwen3.5-122b-a10b",
  "qwen3-122b": "free/qwen3.5-122b-a10b",
  // Free model shorthand aliases. v4-flash EOL'd 2026-08-12 — no free DeepSeek
  // is left anywhere, so the generic "a free deepseek" shorthand follows the
  // gateway's retarget (blockrun's /free-deepseek page points at gpt-oss-120b
  // too). Shorthands naming v4-flash itself stay on the real id — the gateway
  // redirects them, same treatment as seed-oss/mistral-large pins.
  "deepseek-free": "free/nemotron-3.5-lightning",
  "deepseek-v4-pro": "free/nemotron-3.5-lightning", // free shorthand; pro dead upstream (410)
  "deepseek-v4-flash": "free/deepseek-v4-flash",
  "v4-pro": "free/nemotron-3.5-lightning",
  "v4-flash": "free/deepseek-v4-flash",
  // mistral-nemotron died 2026-08-30 and it was the LAST free Mistral anywhere —
  // blockrun's own /free-mistral page now says so plainly instead of naming one.
  // Point the generic shorthand at the free default rather than advertise a
  // Mistral we cannot serve.
  "mistral-free": "free/nemotron-3.5-lightning",
  "glm-free": "free/nemotron-3.5-lightning", // seed-oss-36b (the prior target) EOL'd 2026-08-03
  // A free Llama exists again: nemotron-super-49b (Llama-3.3-based) hit 410 on
  // 2026-08-30, and a 12-model sweep of what NVIDIA still serves found Llama 3.2
  // 11B Vision as the only one that finishes a real completion.
  "llama-free": "free/llama-3.2-11b-vision",
  // qwen3-coder-480b retired 2026-06-14 → seed-oss-36b, which then EOL'd 2026-08-03.
  // Follow the gateway's own retarget rather than chaining to a second dead model.
  "qwen-coder": "free/nemotron-3.5-lightning", // no live free Qwen; follows the free default
  "qwen-coder-free": "free/nemotron-3.5-lightning",
  "qwen-thinking": "free/nemotron-3.5-lightning", // qwen3-next died 2026-07-17; no live free Qwen left
  "qwen3-next": "free/qwen3-next-80b-a3b-instruct", // explicit-ish pin — gateway redirects
  "qwen3-next-80b": "free/qwen3-next-80b-a3b-instruct",
  "mistral-small": "free/nemotron-3.5-lightning", // no free Mistral left upstream (2026-08-30)
  // New live free models (2026-06-14 BlockRun free-tier refresh)
  // seed-oss pins name the model itself — kept routable, the gateway redirects them.
  "seed-oss": "free/seed-oss-36b",
  "seed-oss-36b": "free/seed-oss-36b",
  // A free coder exists again — two of them, both sub-second. north-mini-code is
  // the faster (607ms median) and 256K ctx against laguna's 131K.
  "coder-free": "free/north-mini-code",
  "mistral-nemotron": "free/mistral-nemotron",
  "step-flash": "free/step-3.7-flash",
  "step-3.7-flash": "free/step-3.7-flash",
  // nemotron-nano-9b-v2 hit 410 on 2026-08-30; the generic shorthands follow
  // blockrun's redirect to its replacement, while the 9b-naming pins above stay
  // on the real id (the gateway resolves them).
  "nemotron-nano-9b": "free/nemotron-3-nano-30b",
  "nemotron-nano": "free/nemotron-3-nano-30b",
  // nemotron-nano-12b-v2-vl hit 410 the same day; vision in, vision out — the
  // target is blockrun's own, and nano-omni is the only vision-capable free
  // model left.
  "nemotron-nano-vl": "free/nemotron-3-nano-omni-30b-a3b-reasoning",
  "nano-vl": "free/nemotron-3-nano-omni-30b-a3b-reasoning",
  // Vision-capable free models
  "nemotron-omni": "free/nemotron-3-nano-omni-30b-a3b-reasoning",
  "nano-omni": "free/nemotron-3-nano-omni-30b-a3b-reasoning",
  // `vision-free` kept for backward compatibility ONLY — it still resolves to
  // nano-omni, which is the strongest free model, but the free tier no longer
  // claims working image input on either chain (see the catalog note). Do not
  // advertise this alias as a way to get free vision.
  "vision-free": "free/nemotron-3-nano-omni-30b-a3b-reasoning",
  // Retired shorthand aliases redirect to live successors. The catch-all target
  // moved llama-4-maverick → gpt-oss-120b (2026-07-17) → step-3.7-flash
  // (2026-08-29) → nemotron-3.5-lightning (2026-08-30, blockrun #448).
  nemotron: "free/nemotron-3.5-lightning", // strongest live Nemotron
  "nemotron-ultra": "free/nemotron-3.5-lightning",
  "nemotron-253b": "free/nemotron-3.5-lightning",
  "nemotron-super": "free/nemotron-3.5-lightning",
  "nemotron-49b": "free/nemotron-3.5-lightning",
  "nemotron-120b": "free/nemotron-3.5-lightning",
  devstral: "free/nemotron-3.5-lightning", // seed-oss-36b EOL'd 2026-08-03
  "devstral-2": "free/nemotron-3.5-lightning",
  maverick: "free/llama-4-maverick", // explicit-ish pin — gateway redirects
  // ── The 2026-08-30 free lineup (blockrun #448) ────────────────────────────
  // nvidia/* bridges for the four NVIDIA-hosted additions.
  "nvidia/nemotron-3.5-lightning": "free/nemotron-3.5-lightning",
  "nvidia/nemotron-3-nano-30b": "free/nemotron-3-nano-30b",
  "nvidia/nemotron-3-ultra-550b": "free/nemotron-3-ultra-550b",
  "nvidia/llama-3.2-11b-vision": "free/llama-3.2-11b-vision",
  // The two non-NVIDIA free models keep the `free/` picker convention; their
  // real upstream ids are accepted as pins and rewritten in toUpstreamModelId
  // (see FREE_UPSTREAM_OVERRIDES in proxy.ts).
  "cohere/north-mini-code": "free/north-mini-code",
  "poolside/laguna-xs-2.1": "free/laguna-xs-2.1",
  // Shorthands.
  lightning: "free/nemotron-3.5-lightning",
  "nemotron-lightning": "free/nemotron-3.5-lightning",
  "nemotron-3.5-lightning": "free/nemotron-3.5-lightning",
  "nano-30b": "free/nemotron-3-nano-30b",
  "nemotron-nano-30b": "free/nemotron-3-nano-30b",
  "ultra-550b": "free/nemotron-3-ultra-550b",
  "nemotron-ultra-550b": "free/nemotron-3-ultra-550b",
  "llama-vision": "free/llama-3.2-11b-vision",
  "llama-3.2-vision": "free/llama-3.2-11b-vision",
  "north-mini": "free/north-mini-code",
  "north-mini-code": "free/north-mini-code",
  laguna: "free/laguna-xs-2.1",
  "laguna-xs": "free/laguna-xs-2.1",
  // `free` = the free-tier default. Must equal router-core's ecoTiers.SIMPLE
  // primary and the head of proxy.ts FREE_MODELS so `/model free`, the eco
  // profile and the budget-cap free fallback all agree on one live model.
  free: "free/nemotron-3.5-lightning",

  // MiniMax (minimax → current flagship: M3)
  minimax: "minimax/minimax-m3",
  "minimax-m3": "minimax/minimax-m3",
  "minimax-m2.7": "minimax/minimax-m2.7",
  "minimax-m2.5": "minimax/minimax-m2.5",

  // Z.AI GLM-5
  // Bare `glm` PROMOTED 5.2 → 5.3 (2026-08-30). Same rule as `opus` 4.8 → 5: the
  // cost tradeoff is zero — identical $1.40/$4.40 AND an identical 1M ctx /
  // 131072 maxOutput envelope, so nothing can bill or truncate differently for a
  // caller who never typed a version. blockrun's own copy already names glm-5.3
  // the Z.AI flagship, so leaving `glm` on 5.2 would make the proxy disagree
  // with the gateway it fronts. `glm-5.2` and every other version pin still
  // resolve to their own model.
  glm: "zai/glm-5.3",
  "glm-5.3": "zai/glm-5.3",
  "glm-5-3": "zai/glm-5.3",
  // GLM-5.3 Flash — Z.AI's first natively multimodal GLM-5. Also router-core's
  // eco MEDIUM and COMPLEX primary.
  "glm-5.3-flash": "zai/glm-5.3-flash",
  "glm-5-3-flash": "zai/glm-5.3-flash",
  "glm-flash": "zai/glm-5.3-flash",
  "glm-5.2": "zai/glm-5.2",
  "glm-5": "zai/glm-5",
  "glm-5.1": "zai/glm-5.1", // explicit pin: 200K-ctx predecessor, same price
  "glm-5-turbo": "zai/glm-5-turbo",

  // Routing profile aliases (common variations)
  "auto-router": "auto",
  router: "auto",

  // Note: auto, eco, premium are virtual routing profiles registered in BLOCKRUN_MODELS
  // They don't need aliases since they're already top-level model IDs

  // Image generation
  // dall-e-3 was delisted upstream 2026-05-25; legacy aliases point at its
  // OpenAI successor. flux (black-forest) has no gateway entry anymore.
  dalle: "openai/gpt-image-2",
  "dall-e": "openai/gpt-image-2",
  "gpt-image": "openai/gpt-image-1",
  "gpt-image-2": "openai/gpt-image-2",
  "nano-banana": "google/nano-banana",
  banana: "google/nano-banana",
  "banana-pro": "google/nano-banana-pro",
  "nano-banana-pro": "google/nano-banana-pro",
  // Nano Banana 2 (Gemini 3.1 Flash imagegen, 2026-08-03). Explicit pins —
  // bare `nano-banana`/`banana` stay on the original.
  "nano-banana-2": "google/nano-banana-2",
  "banana-2": "google/nano-banana-2",
  seedream: "bytedance/seedream-5-pro",
  "grok-imagine": "xai/grok-imagine-image",
  "grok-imagine-pro": "xai/grok-imagine-image-pro",
  cogview: "zai/cogview-4",

  // Video generation
  "grok-video": "xai/grok-imagine-video",
  // Bare `seedance` deliberately stays on 1.5-pro. It is the cheapest of the
  // family ($0.070/s vs 2.5's $0.315/s) and `/videogen` documents it as
  // "default — cheapest"; repointing it at the newest tier would 4.5x the
  // quote for every caller who typed the short name expecting the default.
  // Same reasoning that keeps `kimi` on K2.7. Pin 2.5 explicitly to opt in.
  seedance: "bytedance/seedance-1.5-pro",
  "seedance-1.5": "bytedance/seedance-1.5-pro",
  "seedance-2-fast": "bytedance/seedance-2.0-fast",
  "seedance-2": "bytedance/seedance-2.0",
  "seedance-2.5": "bytedance/seedance-2.5",
  "seedance-2-5": "bytedance/seedance-2.5",
  // Seedance 2.0 Mini (2026-08-12): 720p + synced audio at half the flagship
  // rate. Note it is NOT cheaper than 1.5-pro, so bare `seedance` stays put.
  "seedance-2-mini": "bytedance/seedance-2.0-mini",
  "seedance-2.0-mini": "bytedance/seedance-2.0-mini",
  "seedance-mini": "bytedance/seedance-2.0-mini",
};

/**
 * Resolve a model alias to its full model ID.
 * Also strips "blockrun/" prefix for direct model paths.
 * Examples:
 *   - "claude" -> "anthropic/claude-sonnet-4-6" (alias)
 *   - "blockrun/claude" -> "anthropic/claude-sonnet-4-6" (alias with prefix)
 *   - "blockrun/anthropic/claude-sonnet-4-6" -> "anthropic/claude-sonnet-4-6" (prefix stripped)
 *   - "openai/gpt-4o" -> "openai/gpt-4o" (unchanged)
 */
export function resolveModelAlias(model: string): string {
  const normalized = model.trim().toLowerCase();
  const resolved = MODEL_ALIASES[normalized];
  if (resolved) return resolved;

  // Check with "blockrun/" prefix stripped
  if (normalized.startsWith("blockrun/")) {
    const withoutPrefix = normalized.slice("blockrun/".length);
    const resolvedWithoutPrefix = MODEL_ALIASES[withoutPrefix];
    if (resolvedWithoutPrefix) return resolvedWithoutPrefix;

    // Even if not an alias, strip the prefix for direct model paths
    // e.g., "blockrun/anthropic/claude-sonnet-4-6" -> "anthropic/claude-sonnet-4-6"
    return withoutPrefix;
  }

  // Strip "openai/" prefix when it wraps a virtual routing profile or alias.
  // OpenClaw sends virtual models as "openai/eco", "openai/auto", etc. because
  // the provider uses the openai-completions API type.
  if (normalized.startsWith("openai/")) {
    const withoutPrefix = normalized.slice("openai/".length);
    const resolvedWithoutPrefix = MODEL_ALIASES[withoutPrefix];
    if (resolvedWithoutPrefix) return resolvedWithoutPrefix;

    // If it's a known BlockRun virtual profile (eco, auto, premium), return bare id
    const isVirtualProfile = BLOCKRUN_MODELS.some((m) => m.id === withoutPrefix);
    if (isVirtualProfile) return withoutPrefix;
  }

  // Strip "openai-codex/" prefix (OpenClaw v2026.4.5 model ID format).
  // e.g. "openai-codex/gpt-5.4-mini" -> check alias, then strip prefix.
  if (normalized.startsWith("openai-codex/")) {
    const withoutPrefix = normalized.slice("openai-codex/".length);
    const resolvedWithoutPrefix = MODEL_ALIASES[withoutPrefix];
    if (resolvedWithoutPrefix) return resolvedWithoutPrefix;

    // Fall back to checking if the bare name is a known model
    const isKnownModel = BLOCKRUN_MODELS.some((m) => m.id === withoutPrefix);
    if (isKnownModel) return withoutPrefix;
  }

  return model;
}

type BlockRunModel = {
  id: string;
  name: string;
  /** Model version (e.g., "4.6", "3.1", "5.2") for tracking updates */
  version?: string;
  inputPrice: number;
  outputPrice: number;
  contextWindow: number;
  maxOutput: number;
  reasoning?: boolean;
  vision?: boolean;
  /** Models optimized for agentic workflows (multi-step autonomous tasks) */
  agentic?: boolean;
  /**
   * Model supports OpenAI-compatible structured function/tool calling.
   * Models without this flag output tool invocations as plain text JSON,
   * which leaks raw {"command":"..."} into visible chat messages.
   * Default: false (must opt-in to prevent silent regressions on new models).
   */
  toolCalling?: boolean;
  /** Model is deprecated — will be routed to fallbackModel if set */
  deprecated?: boolean;
  /** Model ID to route to when this model is deprecated */
  fallbackModel?: string;
  /** Time-limited promotional pricing — auto-expires after endDate */
  promo?: {
    /** Flat price per request in USD (replaces token-based pricing) */
    flatPrice: number;
    /** ISO date, promo starts (inclusive). e.g. "2026-04-01" */
    startDate: string;
    /** ISO date, promo ends (exclusive). e.g. "2026-04-15" */
    endDate: string;
  };
  /**
   * Permanent flat per-request price in USD (backend billingMode: "flat").
   * Unlike promo, this never expires. Takes precedence over promo.
   */
  flatPrice?: number;
};

export const BLOCKRUN_MODELS: BlockRunModel[] = [
  // Smart routing meta-models — proxy replaces with actual model
  // NOTE: Model IDs are WITHOUT provider prefix (OpenClaw adds "blockrun/" automatically)
  {
    id: "auto",
    name: "Auto (Smart Router - Balanced)",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 1_050_000,
    maxOutput: 128_000,
  },
  {
    id: "free",
    name: "Free → Nemotron 3.5 Lightning",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 1_000_000,
    maxOutput: 16_384,
    reasoning: true,
  },
  {
    id: "eco",
    name: "Eco (Smart Router - Cost Optimized)",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 1_050_000,
    maxOutput: 128_000,
  },
  {
    id: "premium",
    name: "Premium (Smart Router - Best Quality)",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 2_000_000,
    maxOutput: 200_000,
  },

  // OpenAI GPT-5 Family
  {
    id: "openai/gpt-5.2",
    name: "GPT-5.2",
    version: "5.2",
    inputPrice: 1.75,
    outputPrice: 14.0,
    contextWindow: 400000,
    maxOutput: 128000,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },
  {
    id: "openai/gpt-5-mini",
    name: "GPT-5 Mini",
    version: "5.0",
    inputPrice: 0.25,
    outputPrice: 2.0,
    contextWindow: 200000,
    maxOutput: 128000,
    toolCalling: true,
  },
  {
    id: "openai/gpt-5-nano",
    name: "GPT-5 Nano",
    version: "5.0",
    inputPrice: 0.05,
    outputPrice: 0.4,
    contextWindow: 128000,
    maxOutput: 128000,
    toolCalling: true,
    deprecated: true,
    fallbackModel: "openai/gpt-5.4-nano",
  },
  {
    id: "openai/gpt-5.2-pro",
    name: "GPT-5.2 Pro",
    version: "5.2",
    inputPrice: 21.0,
    outputPrice: 168.0,
    contextWindow: 400000,
    maxOutput: 128000,
    reasoning: true,
    vision: true,
    toolCalling: true,
  },
  // GPT-5.6 Family — GA 2026-07-09. Three fixed tiers (Sol/Terra/Luna) replace the
  // single-model-plus-effort-knob line (blockrun source-of-truth models.ts). Sol is
  // the deepest-reasoning flagship; Terra is the balanced everyday tier; Luna is the
  // cost-efficient/latency tier. Generic `gpt5`/`gpt-5.6` aliases resolve to Terra,
  // NOT Sol: Sol's long-horizon reasoning has shown upstream server_error/500s after
  // very long (~250s) waits on release-window traffic (issue #202), so the stable
  // Terra tier is the sane default. Sol stays reachable via the explicit
  // `gpt-5.6-sol` pin for callers who want the deepest tier and accept the risk.
  {
    id: "openai/gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    version: "5.6",
    inputPrice: 4.0,
    outputPrice: 20.0,
    contextWindow: 1050000,
    maxOutput: 128000,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },
  {
    // Terra/Luna repriced 2026-07-30 (OpenAI price cut, blockrun #326).
    id: "openai/gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    version: "5.6",
    inputPrice: 2.0,
    outputPrice: 12.0,
    contextWindow: 1050000,
    maxOutput: 128000,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },
  {
    id: "openai/gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    version: "5.6",
    inputPrice: 0.2,
    outputPrice: 1.2,
    contextWindow: 1050000,
    maxOutput: 128000,
    vision: true,
    agentic: true,
    toolCalling: true,
  },
  // GPT-5.6 Pro tiers (blockrun #329, 2026-08-03): each base tier with pro
  // reasoning mode. Terra Pro lands at half the standard Terra rate; Luna Pro
  // is the budget deep-reasoning tier.
  {
    id: "openai/gpt-5.6-sol-pro",
    name: "GPT-5.6 Sol Pro",
    version: "5.6",
    inputPrice: 4.0,
    outputPrice: 20.0,
    contextWindow: 1050000,
    maxOutput: 128000,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },
  {
    id: "openai/gpt-5.6-terra-pro",
    name: "GPT-5.6 Terra Pro",
    version: "5.6",
    inputPrice: 2.0,
    outputPrice: 12.0,
    contextWindow: 1050000,
    maxOutput: 128000,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },
  {
    id: "openai/gpt-5.6-luna-pro",
    name: "GPT-5.6 Luna Pro",
    version: "5.6",
    inputPrice: 0.2,
    outputPrice: 1.2,
    contextWindow: 1050000,
    maxOutput: 128000,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },

  // GPT-5.5 — first fully retrained base since GPT-4.5; 1M+ context, native agent +
  // computer use. Costs 2x gpt-5.4 — routing tiers still default to gpt-5.4 because
  // it's benchmarked; users can pin 5.5. Superseded as flagship by GPT-5.6 (above).
  {
    id: "openai/gpt-5.5",
    name: "GPT-5.5",
    version: "5.5",
    inputPrice: 5.0,
    outputPrice: 30.0,
    contextWindow: 1050000,
    maxOutput: 128000,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },
  // GPT-5.5 Pro — max-compute tier of the 5.5 family, mirrors the gpt-5.4-pro
  // shape. Upstream also has an OpenAI long-context tier (2x in / 1.5x out above
  // 272K prompt tokens) that this registry cannot express; as with grok, that
  // skews `logUsage` only — the charge is server-dictated via 402.
  {
    id: "openai/gpt-5.5-pro",
    name: "GPT-5.5 Pro",
    version: "5.5",
    inputPrice: 30.0,
    outputPrice: 180.0,
    contextWindow: 1050000,
    maxOutput: 128000,
    reasoning: true,
    vision: true,
    toolCalling: true,
  },
  // ChatGPT Instant — upstream exposes ChatGPT's default model ONLY as the
  // rolling version-less `chat-latest` id, so that is the honest catalog id: it
  // stays correct when OpenAI rolls the default to the next Instant. The display
  // name tracks whichever snapshot is current and must be refreshed on each roll.
  // Chat/vision only upstream — no reasoning or agentic categories.
  {
    id: "openai/chat-latest",
    name: "ChatGPT Instant (GPT-5.5)",
    version: "5.5",
    inputPrice: 5.0,
    outputPrice: 30.0,
    contextWindow: 128000,
    maxOutput: 128000,
    vision: true,
    toolCalling: true,
  },
  // GPT-5.4 — flagship benchmarked into routing tiers
  {
    id: "openai/gpt-5.4",
    name: "GPT-5.4",
    version: "5.4",
    inputPrice: 2.5,
    outputPrice: 15.0,
    contextWindow: 1050000,
    maxOutput: 128000,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },
  {
    id: "openai/gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    version: "5.4",
    inputPrice: 0.75,
    outputPrice: 4.5,
    contextWindow: 400000,
    maxOutput: 128000,
    vision: true,
    agentic: true,
    toolCalling: true,
  },
  {
    id: "openai/gpt-5.4-pro",
    name: "GPT-5.4 Pro",
    version: "5.4",
    inputPrice: 30.0,
    outputPrice: 180.0,
    contextWindow: 1050000,
    maxOutput: 128000,
    reasoning: true,
    vision: true,
    toolCalling: true,
  },
  {
    id: "openai/gpt-5.4-nano",
    name: "GPT-5.4 Nano",
    version: "5.4",
    inputPrice: 0.2,
    outputPrice: 1.25,
    contextWindow: 1050000,
    maxOutput: 128000,
    toolCalling: true,
  },

  // OpenAI GPT-5.3 Family
  {
    id: "openai/gpt-5.3",
    name: "GPT-5.3",
    version: "5.3",
    inputPrice: 1.75,
    outputPrice: 14.0,
    contextWindow: 128000,
    maxOutput: 128000,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },

  // OpenAI Codex Family
  {
    id: "openai/gpt-5.3-codex",
    name: "GPT-5.3 Codex",
    version: "5.3",
    inputPrice: 1.75,
    outputPrice: 14.0,
    contextWindow: 400000,
    maxOutput: 128000,
    agentic: true,
    toolCalling: true,
  },

  // OpenAI GPT-4 Family
  {
    id: "openai/gpt-4.1",
    name: "GPT-4.1",
    version: "4.1",
    inputPrice: 2.0,
    outputPrice: 8.0,
    contextWindow: 128000,
    maxOutput: 32768,
    vision: true,
    toolCalling: true,
  },
  {
    id: "openai/gpt-4.1-mini",
    name: "GPT-4.1 Mini",
    version: "4.1",
    inputPrice: 0.4,
    outputPrice: 1.6,
    contextWindow: 128000,
    maxOutput: 32768,
    toolCalling: true,
  },
  {
    id: "openai/gpt-4.1-nano",
    name: "GPT-4.1 Nano",
    version: "4.1",
    inputPrice: 0.1,
    outputPrice: 0.4,
    contextWindow: 128000,
    maxOutput: 32768,
    toolCalling: true,
  },
  {
    id: "openai/gpt-4o",
    name: "GPT-4o",
    version: "4o",
    inputPrice: 2.5,
    outputPrice: 10.0,
    contextWindow: 128000,
    maxOutput: 16384,
    vision: true,
    agentic: true,
    toolCalling: true,
  },
  {
    id: "openai/gpt-4o-mini",
    name: "GPT-4o Mini",
    version: "4o-mini",
    inputPrice: 0.15,
    outputPrice: 0.6,
    contextWindow: 128000,
    maxOutput: 16384,
    toolCalling: true,
  },

  // OpenAI O-series (Reasoning)
  {
    id: "openai/o1",
    name: "o1",
    version: "1",
    inputPrice: 15.0,
    outputPrice: 60.0,
    contextWindow: 200000,
    maxOutput: 100000,
    reasoning: true,
    toolCalling: true,
  },
  {
    id: "openai/o1-mini",
    name: "o1-mini",
    version: "1-mini",
    inputPrice: 1.1,
    outputPrice: 4.4,
    contextWindow: 128000,
    maxOutput: 65536,
    reasoning: true,
    toolCalling: true,
  },
  {
    id: "openai/o3",
    name: "o3",
    version: "3",
    inputPrice: 2.0,
    outputPrice: 8.0,
    contextWindow: 200000,
    maxOutput: 100000,
    reasoning: true,
    toolCalling: true,
  },
  {
    id: "openai/o3-mini",
    name: "o3-mini",
    version: "3-mini",
    inputPrice: 1.1,
    outputPrice: 4.4,
    contextWindow: 128000,
    maxOutput: 100000,
    reasoning: true,
    toolCalling: true,
  },
  {
    id: "openai/o4-mini",
    name: "o4-mini",
    version: "4-mini",
    inputPrice: 1.1,
    outputPrice: 4.4,
    contextWindow: 128000,
    maxOutput: 100000,
    reasoning: true,
    toolCalling: true,
  },

  // Anthropic - all Claude models excel at agentic workflows
  // Use newest versions (4.6) with full provider prefix
  {
    id: "anthropic/claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    version: "4.5",
    inputPrice: 1.0,
    outputPrice: 5.0,
    contextWindow: 200000,
    maxOutput: 64000,
    vision: true,
    agentic: true,
    toolCalling: true,
  },
  {
    id: "anthropic/claude-sonnet-4.5",
    name: "Claude Sonnet 4.5",
    version: "4.5",
    inputPrice: 3.0,
    outputPrice: 15.0,
    contextWindow: 200000,
    maxOutput: 64000,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },
  {
    id: "anthropic/claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
    version: "4.6",
    inputPrice: 3.0,
    outputPrice: 15.0,
    contextWindow: 1000000,
    maxOutput: 128000,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },
  {
    // Newest Sonnet — near-Opus coding/agentic quality at Sonnet cost. Same
    // price as 4.6 ($3/$15) but 1M ctx / 128K out / adaptive thinking. Kept as
    // an opt-in distinct model (bare `sonnet`/`claude` still resolve to 4.6);
    // primaries not promoted pending benchmarks. BlockRun fallback → sonnet-4.6.
    id: "anthropic/claude-sonnet-5",
    name: "Claude Sonnet 5",
    version: "5",
    inputPrice: 3.0,
    outputPrice: 15.0,
    contextWindow: 1000000,
    maxOutput: 128000,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },
  {
    id: "anthropic/claude-opus-4.5",
    name: "Claude Opus 4.5",
    version: "4.5",
    inputPrice: 5.0,
    outputPrice: 25.0,
    contextWindow: 200000,
    maxOutput: 64000,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },
  {
    id: "anthropic/claude-opus-4.6",
    name: "Claude Opus 4.6",
    version: "4.6",
    inputPrice: 5.0,
    outputPrice: 25.0,
    contextWindow: 1000000,
    maxOutput: 128000,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },
  // claude-fable-5 relisted 2026-07-06 after Anthropic restored the offer
  // (delisted 2026-06-13). Mythos-class tier above Opus; thinking is always on
  // upstream, so there is no non-reasoning mode to model here.
  {
    id: "anthropic/claude-fable-5",
    name: "Claude Fable 5",
    version: "5",
    inputPrice: 10.0,
    outputPrice: 50.0,
    contextWindow: 1000000,
    maxOutput: 128000,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },
  {
    id: "anthropic/claude-opus-4.7",
    name: "Claude Opus 4.7",
    version: "4.7",
    inputPrice: 5.0,
    outputPrice: 25.0,
    contextWindow: 1000000,
    maxOutput: 128000,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },
  {
    id: "anthropic/claude-opus-4.8",
    name: "Claude Opus 4.8",
    version: "4.8",
    inputPrice: 5.0,
    outputPrice: 25.0,
    contextWindow: 1000000,
    maxOutput: 128000,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },
  // claude-opus-5 added 2026-07-24 (BlockRun launch-day sync, PR #283).
  // Same $5/$25 as Opus 4.8 — Anthropic bills the 1M window at standard rates,
  // so there is no long-context premium to model here.
  {
    id: "anthropic/claude-opus-5",
    name: "Claude Opus 5",
    version: "5",
    inputPrice: 5.0,
    outputPrice: 25.0,
    contextWindow: 1000000,
    maxOutput: 128000,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },

  // Google
  {
    id: "google/gemini-3.1-pro",
    name: "Gemini 3.1 Pro",
    version: "3.1",
    inputPrice: 2.0,
    outputPrice: 12.0,
    contextWindow: 1048576,
    maxOutput: 65536,
    reasoning: true,
    vision: true,
    toolCalling: true,
  },
  {
    id: "google/gemini-3-pro-preview",
    name: "Gemini 3 Pro Preview",
    version: "3.0",
    inputPrice: 2.0,
    outputPrice: 12.0,
    contextWindow: 1048576,
    maxOutput: 65536,
    reasoning: true,
    vision: true,
    toolCalling: true,
  },
  {
    // Newest-generation Flash with built-in thinking mode (blockrun #329,
    // 2026-08-03). 17% cheaper output than 3.5 Flash.
    id: "google/gemini-3.6-flash",
    name: "Gemini 3.6 Flash",
    version: "3.6",
    inputPrice: 0.75,
    outputPrice: 3.75,
    contextWindow: 1048576,
    maxOutput: 65536,
    reasoning: true,
    vision: true,
    toolCalling: true,
  },
  {
    // Repriced 0.5/3.0 → 1.5/9.0 (blockrun #304: it was billed at 1/3 of
    // Google's real rate).
    id: "google/gemini-3.5-flash",
    name: "Gemini 3.5 Flash",
    version: "3.5",
    inputPrice: 1.5,
    outputPrice: 9.0,
    contextWindow: 1048576,
    maxOutput: 65536,
    reasoning: true,
    vision: true,
    toolCalling: true,
  },
  {
    // Ultra-fast lightweight tier with thinking mode (blockrun #329).
    id: "google/gemini-3.5-flash-lite",
    name: "Gemini 3.5 Flash Lite",
    version: "3.5",
    inputPrice: 0.3,
    outputPrice: 2.5,
    contextWindow: 1048576,
    maxOutput: 65536,
    reasoning: true,
    toolCalling: true,
  },
  {
    id: "google/gemini-3-flash-preview",
    name: "Gemini 3 Flash Preview",
    version: "3.0",
    inputPrice: 0.5,
    outputPrice: 3.0,
    contextWindow: 1048576,
    maxOutput: 65536,
    reasoning: true,
    vision: true,
  },
  {
    id: "google/gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    version: "2.5",
    inputPrice: 1.25,
    outputPrice: 10.0,
    contextWindow: 1048576,
    maxOutput: 65536,
    reasoning: true,
    vision: true,
    toolCalling: true,
  },
  {
    id: "google/gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    version: "2.5",
    inputPrice: 0.3,
    outputPrice: 2.5,
    contextWindow: 1048576,
    maxOutput: 65536,
    vision: true,
    toolCalling: true,
  },
  {
    // vision LIVE-VERIFIED 2026-08-31: 3 of 3 proxy probes with a 64x64 solid-red
    // PNG answered "Red", each served as itself. blockrun's catalog does not tag
    // it (same under-claim class as the Claude models below), and without the
    // flag filterByVision() excluded the CHEAPEST paid model in the catalog from
    // every image request — so image turns escalated past a $0.10/$0.40 rung that
    // handles them. It is also router-core's eco SIMPLE cheapest-paid fallback.
    // Unrelated to its presence in TOOL_NONCOMPLIANT_MODELS (proxy.ts), which is
    // about tool schemas, not image input.
    id: "google/gemini-2.5-flash-lite",
    name: "Gemini 2.5 Flash Lite",
    version: "2.5",
    inputPrice: 0.1,
    outputPrice: 0.4,
    contextWindow: 1048576,
    maxOutput: 65536,
    vision: true,
    toolCalling: true,
  },
  {
    id: "google/gemini-3.1-flash-lite",
    name: "Gemini 3.1 Flash Lite",
    version: "3.1",
    inputPrice: 0.25,
    outputPrice: 1.5,
    contextWindow: 1048576,
    maxOutput: 65536,
    toolCalling: true,
  },

  // DeepSeek — V4 family (2026-04-24). The legacy deepseek-chat/reasoner
  // aliases are served upstream as V4 Flash non-thinking / thinking modes.
  // Repriced 0.20/0.40 → 0.14/0.28 (blockrun #354: DeepSeek's published
  // deepseek-v4-flash rate; the old numbers were 1.43x the real rate).
  {
    id: "deepseek/deepseek-chat",
    name: "DeepSeek V4 Flash Chat",
    version: "4-flash",
    inputPrice: 0.14,
    outputPrice: 0.28,
    contextWindow: 1048576,
    maxOutput: 65536,
    toolCalling: true,
  },
  {
    id: "deepseek/deepseek-reasoner",
    name: "DeepSeek V4 Flash Reasoner",
    version: "4-flash",
    inputPrice: 0.14,
    outputPrice: 0.28,
    contextWindow: 1048576,
    maxOutput: 65536,
    reasoning: true,
    toolCalling: true,
  },
  {
    // V4 flagship — strongest open-weight reasoner. The 75% launch promo
    // became DeepSeek's permanent list price after 2026-05-31. Resold via
    // BlockRun's OpenRouter credit pool. Was listed in top-models.json
    // without a catalog entry, which silently dropped it from the picker.
    id: "deepseek/deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    version: "4-pro",
    inputPrice: 1.32,
    outputPrice: 3.96,
    contextWindow: 1048576,
    maxOutput: 65536,
    reasoning: true,
    agentic: true,
    toolCalling: true,
  },

  // Kimi K3 — Moonshot's flagship (blockrun added 2026-07-17, live-probed same day).
  // 2.8T-param open MoE, 1M context, image + text input, returns reasoning_content.
  // Priced at COGS + BlockRun's 5% margin: users pay ~$3.15/$15.75 per 1M; the fields
  // here store the raw $3.00/$15.00 COST (server applies margin at billing). ~5x K2.7,
  // so the generic `kimi` alias deliberately stays on K2.7 — address k3 explicitly.
  {
    id: "moonshot/kimi-k3",
    name: "Kimi K3",
    version: "k3",
    inputPrice: 3.0,
    outputPrice: 15.0,
    contextWindow: 1048576,
    maxOutput: 65536,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },

  // Kimi K2.7 — previous-gen flagship (added 2026-06-13); superseded by K3 + hidden on
  // BlockRun 2026-07-17 but kept routable. 256K context, multi-modal (image + VIDEO
  // input), returns reasoning_content. Served via BlockRun's OpenRouter credit pool
  // (slug moonshotai/kimi-k2.7-code) failing over to direct Moonshot. AT-COST pricing
  // ($0.95/$4.00 = OpenRouter COGS, zero margin) — same as K2.6.
  {
    id: "moonshot/kimi-k2.7",
    name: "Kimi K2.7",
    version: "k2.7",
    inputPrice: 0.95,
    outputPrice: 4.0,
    contextWindow: 262144,
    maxOutput: 65536,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },

  // Qwen3.7 Max — BlockRun's paid Qwen flagship, served through its
  // OpenRouter credit pool. The gateway applies its standard 5% margin at
  // settlement, so keep the catalog rates at the upstream $1.475/$4.425 COGS.
  // NOTE: `reasoning: true` also enrolls this id in REASONING_MODEL_IDS
  // (proxy.ts), which raises its per-model timeout from 60s to 180s.
  // `toolCalling: true` is LIVE-VERIFIED (2026-07-20): a real request through
  // the gateway returned a structured tool_calls array (name + valid JSON
  // arguments, finish_reason "tool_calls"), not the textual leak that Kimi K3
  // (#213), Gemini (#189) and GPT (#193) produce. Don't downgrade on a hunch.
  {
    id: "qwen/qwen3.7-max",
    name: "Qwen3.7 Max",
    version: "3.7-max",
    inputPrice: 1.475,
    outputPrice: 4.425,
    contextWindow: 1000000,
    maxOutput: 65536,
    reasoning: true,
    agentic: true,
    toolCalling: true,
  },
  // Qwen3.7 Plus/Flash (blockrun #329, 2026-08-03): the balanced and
  // latency tiers under Max. Plus genuinely caps output at 131072 while
  // Flash and Max cap at 65536 (endpoint-probed upstream).
  {
    id: "qwen/qwen3.7-plus",
    name: "Qwen3.7 Plus",
    version: "3.7-plus",
    inputPrice: 0.32,
    outputPrice: 1.28,
    contextWindow: 1000000,
    maxOutput: 131072,
    reasoning: true,
    agentic: true,
    toolCalling: true,
  },
  {
    id: "qwen/qwen3.7-flash",
    name: "Qwen3.7 Flash",
    version: "3.7-flash",
    inputPrice: 0.03,
    outputPrice: 0.13,
    contextWindow: 1000000,
    maxOutput: 65536,
    reasoning: true,
    toolCalling: true,
  },

  // Kimi K2.6 — superseded by K2.7 (2026-06-13), hidden on BlockRun but still routable.
  {
    id: "moonshot/kimi-k2.6",
    name: "Kimi K2.6",
    version: "k2.6",
    inputPrice: 0.95,
    outputPrice: 4.0,
    contextWindow: 262144,
    maxOutput: 65536,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },

  // Kimi K2.5 — Moonshot direct is primary (better SLA). NVIDIA-hosted variant
  // retired 2026-04-21 (slow throughput) and now redirects to moonshot.
  {
    id: "moonshot/kimi-k2.5",
    name: "Kimi K2.5",
    version: "k2.5",
    inputPrice: 0.6,
    outputPrice: 3.0,
    contextWindow: 262144,
    maxOutput: 65536,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },
  {
    id: "nvidia/kimi-k2.5",
    name: "Kimi K2.5 (NVIDIA, retired)",
    version: "k2.5",
    inputPrice: 0.6,
    outputPrice: 3.0,
    contextWindow: 262144,
    maxOutput: 16384,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
    deprecated: true,
    fallbackModel: "moonshot/kimi-k2.5",
  },

  // xAI / Grok
  {
    id: "xai/grok-3",
    name: "Grok 3",
    version: "3",
    inputPrice: 3.0,
    outputPrice: 15.0,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true,
    toolCalling: true,
  },
  // grok-3-fast removed - too expensive ($5/$25), use grok-4-fast instead
  {
    id: "xai/grok-3-mini",
    name: "Grok 3 Mini",
    version: "3-mini",
    inputPrice: 0.3,
    outputPrice: 0.5,
    contextWindow: 131072,
    maxOutput: 16384,
    toolCalling: true,
  },

  // xAI Grok 4 Family - Ultra-cheap fast models
  {
    id: "xai/grok-4-fast-reasoning",
    name: "Grok 4 Fast Reasoning",
    version: "4",
    inputPrice: 0.2,
    outputPrice: 0.5,
    contextWindow: 2000000,
    maxOutput: 16384,
    reasoning: true,
    toolCalling: true,
  },
  {
    id: "xai/grok-4-fast-non-reasoning",
    name: "Grok 4 Fast",
    version: "4",
    inputPrice: 0.2,
    outputPrice: 0.5,
    contextWindow: 2000000,
    maxOutput: 16384,
    toolCalling: true,
  },
  {
    id: "xai/grok-4-1-fast-reasoning",
    name: "Grok 4.1 Fast Reasoning",
    version: "4.1",
    inputPrice: 0.2,
    outputPrice: 0.5,
    contextWindow: 2000000,
    maxOutput: 16384,
    reasoning: true,
    toolCalling: true,
  },
  {
    id: "xai/grok-4-1-fast-non-reasoning",
    name: "Grok 4.1 Fast",
    version: "4.1",
    inputPrice: 0.2,
    outputPrice: 0.5,
    contextWindow: 2000000,
    maxOutput: 16384,
    toolCalling: true,
  },
  // xai/grok-code-fast-1 delisted 2026-03-12: poor retention (coding users churn),
  // no structured tool calling, alias "grok-code" redirected to deepseek-chat
  {
    id: "xai/grok-4-0709",
    name: "Grok 4 (0709)",
    version: "4-0709",
    inputPrice: 3.0,
    outputPrice: 15.0,
    contextWindow: 256000,
    maxOutput: 16384,
    reasoning: true,
    toolCalling: true,
  },
  {
    id: "xai/grok-2-vision",
    name: "Grok 2 Vision",
    version: "2",
    inputPrice: 2.0,
    outputPrice: 10.0,
    contextWindow: 32768,
    maxOutput: 16384,
    vision: true,
    toolCalling: true,
  },

  // xAI Grok 4.20 Family (hidden in picker; explicit-only — mirrors BlockRun hidden:true)
  {
    id: "xai/grok-4.20-reasoning",
    name: "Grok 4.20 Reasoning",
    version: "4.20",
    inputPrice: 2.0,
    outputPrice: 6.0,
    contextWindow: 2000000,
    maxOutput: 16384,
    reasoning: true,
    toolCalling: true,
  },
  {
    id: "xai/grok-4.20-non-reasoning",
    name: "Grok 4.20",
    version: "4.20",
    inputPrice: 2.0,
    outputPrice: 6.0,
    contextWindow: 2000000,
    maxOutput: 16384,
    toolCalling: true,
  },
  {
    id: "xai/grok-4.20-multi-agent",
    name: "Grok 4.20 Multi-Agent",
    version: "4.20",
    inputPrice: 2.0,
    outputPrice: 6.0,
    contextWindow: 2000000,
    maxOutput: 16384,
    reasoning: true,
    toolCalling: true,
  },

  // xAI flagship (added upstream 2026-07-13). Direct-xAI SKU, so Live Search works.
  // inputPrice/outputPrice are the base rates only: upstream re-prices the WHOLE
  // request at $5.00/$18.00 once prompt tokens reach 200K, which this registry has
  // no field to express. That skews `logUsage` telemetry on long-context calls, not
  // the charge — payment is server-dictated via 402.
  {
    id: "xai/grok-4.5",
    name: "Grok 4.5",
    version: "4.5",
    inputPrice: 2.0,
    outputPrice: 6.0,
    contextWindow: 500000,
    maxOutput: 16384,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },

  // xAI via BlockRun's OpenRouter credit pool (public in backend catalog,
  // added 2026-06-04). Picker-visible — listed in top-models.json.
  {
    id: "xai/grok-4.3",
    name: "Grok 4.3",
    version: "4.3",
    inputPrice: 1.25,
    outputPrice: 2.5,
    contextWindow: 1000000,
    maxOutput: 16384,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },
  {
    id: "xai/grok-build-0.1",
    name: "Grok Build 0.1",
    version: "0.1",
    inputPrice: 1.0,
    outputPrice: 2.0,
    contextWindow: 256000,
    maxOutput: 16384,
    agentic: true,
    toolCalling: true,
  },

  // Tencent + Xiaomi (blockrun 2026-07-25): the two largest real demand gaps
  // in the catalog — Hy3 held the #1 usage slot on the biggest public
  // aggregator for 19 days; MiMo ran ~22% weekly share in April. Both are
  // reasoning models resold via blockrun's OpenRouter pool. toolCalling
  // LIVE-VERIFIED 2026-08-12: both returned a structured tool_calls array
  // (name + valid JSON args, finish_reason "tool_calls") through the gateway.
  {
    id: "tencent/hy3",
    name: "Tencent Hy3",
    version: "hy3",
    inputPrice: 0.132,
    outputPrice: 0.528,
    contextWindow: 262144,
    maxOutput: 128000,
    reasoning: true,
    toolCalling: true,
  },
  {
    id: "xiaomi/mimo-v2.5-pro",
    name: "Xiaomi MiMo-V2.5 Pro",
    version: "v2.5-pro",
    inputPrice: 0.435,
    outputPrice: 0.87,
    contextWindow: 1048576,
    maxOutput: 131072,
    reasoning: true,
    toolCalling: true,
  },

  // MiniMax
  {
    id: "minimax/minimax-m3",
    name: "MiniMax M3",
    version: "m3",
    inputPrice: 0.3,
    outputPrice: 1.2,
    contextWindow: 1048576,
    maxOutput: 65536,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },
  {
    id: "minimax/minimax-m2.7",
    name: "MiniMax M2.7",
    version: "m2.7",
    inputPrice: 0.3,
    outputPrice: 1.2,
    contextWindow: 204800,
    maxOutput: 16384,
    reasoning: true,
    agentic: true,
    toolCalling: true,
  },
  {
    id: "minimax/minimax-m2.5",
    name: "MiniMax M2.5",
    version: "m2.5",
    inputPrice: 0.3,
    outputPrice: 1.2,
    contextWindow: 204800,
    maxOutput: 16384,
    reasoning: true,
    agentic: true,
    toolCalling: true,
    deprecated: true,
    fallbackModel: "minimax/minimax-m2.7",
  },

  // Free models (hosted by NVIDIA, billingMode: "free" on server)
  // IDs use "free/" prefix so users see them as free in the /model picker.
  // ClawRouter maps free/xxx → nvidia/xxx before sending to BlockRun upstream
  // (see toUpstreamModelId in src/proxy.ts). BlockRun's NVIDIA_MODEL_MAP in
  // src/lib/ai-providers.ts maps known IDs to upstream NIM names; for IDs not
  // in the map, BlockRun falls through to the bare name (modelMap[k] || k),
  // so new entries here only need to match BlockRun's catalog ID — NVIDIA NIM
  // accepts the bare name directly.
  // toolCalling intentionally omitted: structured function calling unverified.
  // 2026-04-29: kept gpt-oss-120b/20b as defaults (heavy user demand); added
  //   v4-pro / v4-flash (1M context, ~5x speed split) and nemotron-3-nano-omni
  //   (first vision-capable free model, 256K context, accepts text/image/video/audio).
  // 2026-04-21: slimmed to 8 models, retired nemotron family + mistral-large-3-675b
  //   + devstral-2-123b with successor redirects.
  {
    id: "free/gpt-oss-120b",
    name: "[Free] GPT-OSS 120B",
    version: "120b",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 128000,
    maxOutput: 16384,
  },
  {
    id: "free/gpt-oss-20b",
    name: "[Free] GPT-OSS 20B",
    version: "20b",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 128000,
    maxOutput: 16384,
  },
  {
    // V4 Flash: 284B / 13B active MoE, 1M context. EOL'd 2026-08-12 — NVIDIA
    // published 410 Gone ("has reached its end of life") on both probe passes
    // and blockrun's prod gate fired [ALERT][free-model-dead] kind=gone twice
    // that morning. The whole nvidia/deepseek-* family is dead upstream; there
    // is no free DeepSeek left anywhere. Blockrun hid it and redirects calls to
    // gpt-oss-120b. Entry kept so explicit pins stay routable; off the picker,
    // the FREE_MODELS cascade, and the router fallback chains.
    id: "free/deepseek-v4-flash",
    name: "[Free] DeepSeek V4 Flash",
    version: "v4-flash",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 1000000,
    maxOutput: 16384,
    reasoning: true,
  },
  {
    id: "free/qwen3-coder-480b",
    name: "[Free] Qwen3 Coder 480B",
    version: "480b",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 131072,
    maxOutput: 16384,
  },
  {
    id: "free/glm-4.7",
    name: "[Free] GLM-4.7",
    version: "4.7",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true,
  },
  {
    id: "free/llama-4-maverick",
    name: "[Free] Llama 4 Maverick",
    version: "4-maverick",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true,
  },
  {
    // Nemotron 3 Nano Omni: first vision-capable free model. 31B / 3.2B active
    // MoE, 256K context. ChartQA 90.3, DocVQA 95.6, MMMU 70.8. Accepts text,
    // images, video (up to 2min), audio (up to 1hr). Released 2026-04-27.
    id: "free/nemotron-3-nano-omni-30b-a3b-reasoning",
    name: "[Free] Nemotron 3 Nano Omni",
    version: "30b-a3b-omni-reasoning",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 256000,
    maxOutput: 16384,
    reasoning: true,
    // NO `vision: true` — 2026-08-31. Both catalogs advertise vision on this
    // model and blockrun #448 cites an 8x8 PNG answering "Red", but a 64x64
    // solid-red probe does not hold up: 1 of 4 correct on Base (the others
    // "I'm not able to view the image" or leaked reasoning), and on sol it
    // answered "white" twice, once with the response's own `model` field
    // reading `nemotron-3-super-120b (fallback: ...nano-omni)` — the image is
    // silently dropped and a text model answers.
    //
    // `vision: true` is what makes filterByVision() route real image turns
    // here, so the flag does not merely describe the model, it aims traffic at
    // it. HTTP 200 with a confident wrong colour is worse than no free vision:
    // there is no error for a caller to branch on. Image turns go to paid
    // vision models until a correctly-sized probe comes back right on both
    // chains. Independently confirmed on Solana by the blockrun-sol owner.
  },
  // 2026-06-14: BlockRun re-featured these two as free flagships (catalog sweep).
  // Added to the auto-pick set behind gpt-oss to strengthen the mid/back of the
  // free cascade with strong general models.
  {
    // Mistral Large 3: 675B dense flagship. Un-retired 2026-06-14, EOL'd again
    // 2026-07-28 — blockrun's re-probe got HTTP 410 Gone from NVIDIA (baa967b);
    // upstream now hides it and redirects calls to gpt-oss-120b. Entry kept so
    // explicit pins stay routable; off the picker and the FREE_MODELS cascade.
    id: "free/mistral-large-3-675b",
    name: "[Free] Mistral Large 3 675B",
    version: "3-675b",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true,
  },
  {
    // Qwen3.5 122B (A10B active MoE): newest-gen Qwen, strong general capability.
    id: "free/qwen3.5-122b-a10b",
    name: "[Free] Qwen3.5 122B",
    version: "3.5-122b",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true,
  },
  // 2026-06-16: BlockRun's 2026-06-14 free-tier refresh (self-healing health gate
  // + probe-verified lineup, blockrun commit 5817ecd) added these live NVIDIA free
  // models. Status per blockrun's 2026-07-17 live re-probe: qwen3-coder-480b and
  // glm-4.7 stay dead (server-redirected); deepseek-v4-flash recovered then
  // EOL'd for good 2026-08-12 (see above).
  {
    // Qwen3-Next 80B (A3B active MoE): 262K context. DIED in the 2026-07-17
    // re-probe (">60s / DEGRADED") — hidden upstream, gateway redirects pinned
    // callers to gpt-oss-120b. Entry kept so pins stay routable; off the picker.
    id: "free/qwen3-next-80b-a3b-instruct",
    name: "[Free] Qwen3-Next 80B Instruct",
    version: "next-80b-a3b",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 262144,
    maxOutput: 16384,
    reasoning: true,
  },
  {
    // ByteDance Seed-OSS 36B: was the free coder, and the redirect target for the
    // retired qwen3-coder-480b. EOL'd 2026-08-03 — blockrun's probe got HTTP 410
    // Gone from NVIDIA on both passes and the prod health gate fired
    // [ALERT][free-model-dead] kind=gone the same day; upstream now hides it and
    // re-pointed its own dependents (qwen3-coder-480b, devstral-2) at gpt-oss-120b.
    // Entry kept so explicit pins stay routable; off the picker, the FREE_MODELS
    // cascade, and the router fallback chains.
    id: "free/seed-oss-36b",
    name: "[Free] Seed-OSS 36B",
    version: "oss-36b",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 131072,
    maxOutput: 16384,
  },
  {
    // Mistral × NVIDIA hybrid, 131K context. DEAD 2026-08-30 — the QUIET kind:
    // NVIDIA still LISTS it but a completion returns zero bytes after >150s on
    // both of blockrun's probe passes (blockrun #448, the #391 shape). Upstream
    // hid it and redirects callers to a live workhorse. Entry kept so explicit
    // pins stay routable; off the picker and the FREE_MODELS cascade.
    // There is no free Mistral left on NVIDIA — do not point a generic
    // "a free mistral" shorthand at one.
    id: "free/mistral-nemotron",
    name: "[Free] Mistral Nemotron",
    version: "nemotron",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 131072,
    maxOutput: 16384,
  },
  {
    // StepFun Step 3.7 Flash: reasoning-focused, 131K context. EOL'd 2026-08-30
    // — NVIDIA published 410 Gone on both of blockrun's probe passes (#448), in
    // the same sweep that took nemotron-nano-9b-v2, nemotron-nano-12b-v2-vl and
    // (hidden) nemotron-super-49b. It had been ClawRouter's free default since
    // 2026-08-29; the gateway redirects it to nemotron-3.5-lightning, which is
    // exactly why nothing looked broken. Entry kept so explicit pins stay
    // routable; off the picker and the FREE_MODELS cascade.
    id: "free/step-3.7-flash",
    name: "[Free] StepFun Step 3.7 Flash",
    version: "3.7-flash",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true,
  },
  {
    // NVIDIA Nemotron Nano 9B v2: fast lightweight generalist, 131K context.
    // EOL'd 2026-08-30 (410 Gone, same sweep). Gateway redirects it to
    // nemotron-3-nano-30b. Entry kept for pins; off the picker and the cascade.
    id: "free/nemotron-nano-9b-v2",
    name: "[Free] Nemotron Nano 9B v2",
    version: "nano-9b-v2",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true,
  },
  {
    // NVIDIA Nemotron Nano 12B v2 VL: vision-language (text + image), 131K context.
    // EOL'd 2026-08-30 (410 Gone, same sweep). Gateway redirects it to
    // nemotron-3-nano-omni, the only vision-capable free model left. Entry kept
    // for pins; off the picker and the cascade.
    id: "free/nemotron-nano-12b-v2-vl",
    name: "[Free] Nemotron Nano 12B v2 VL",
    version: "nano-12b-v2-vl",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true,
    // Vision flag dropped 2026-08-31 with the rest of the free tier: this id is
    // 410 Gone and the gateway redirects it to nano-omni, whose image path does
    // not work either (see above). A pinned caller sending an image would have
    // been told, by the flag, that it would be seen.
  },

  // ── 2026-08-30 free-tier rebuild (blockrun #448) ─────────────────────────
  // NVIDIA retired FOUR of the five VISIBLE free models in one sweep. blockrun
  // replaced them and moved two survivors onto OpenRouter's $0 ":free" pool,
  // taking the visible free set from 5 to 7 and spanning three hosts for the
  // first time (NVIDIA, OpenRouter, and two non-NVIDIA makers).
  //
  // All seven live free models were tool-probed through the gateway on
  // 2026-08-30 and every one returned a structured `tool_calls` array with
  // valid JSON args and finish_reason: "tool_calls" (nemotron-3-nano-30b looked
  // like a textual leak at max_tokens:120 — that was truncation; at 300 it is
  // structured). The evidence is recorded here on purpose, but `toolCalling` is
  // deliberately NOT set: no free entry has ever carried it, filterByToolCalling
  // keeps the free tier out of tool-bearing requests, and the budget pre-check
  // at proxy.ts:5217 is written on the same assumption. Flipping the tier into
  // agentic eligibility is its own change with its own evidence bar.
  {
    // Nemotron 3.5 Lightning 30B-A3B — the new free default. blockrun's own
    // redirect target for the retired step-3.7-flash, so following it keeps the
    // proxy and the gateway naming the same model. Served from OpenRouter's $0
    // pool (4.9s median vs 16.3s direct) which also publishes a 1M window
    // against the 131K the NVIDIA NIM path gives; blockrun carries a hidden
    // "-nim" twin as its fallback. Probed 1.3s with tools.
    id: "free/nemotron-3.5-lightning",
    name: "[Free] Nemotron 3.5 Lightning",
    version: "3.5-lightning",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 1000000,
    maxOutput: 16384,
    reasoning: true,
  },
  {
    // Nemotron 3 Nano 30B-A3B — the fastest free model in the catalog
    // (~121 tok/s on a realistic workload, not a 16-token ping). Returns
    // reasoning_content. Also the tertiary rung of blockrun's own free cascade.
    id: "free/nemotron-3-nano-30b",
    name: "[Free] Nemotron 3 Nano 30B",
    version: "3-nano-30b",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true,
  },
  {
    // Nemotron 3 Ultra 550B-A55B — the largest free model ever listed, 1M ctx,
    // reachable ONLY through OpenRouter's $0 pool (build.nvidia.com answers 503).
    // Deliberately LOW in the cascade: 16.8s on the tools probe, and blockrun
    // measured 3 of 15 calls coming back as an HTTP 200 carrying an upstream
    // 502/503 error object instead of choices.
    id: "free/nemotron-3-ultra-550b",
    name: "[Free] Nemotron 3 Ultra 550B",
    version: "3-ultra-550b",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 1000000,
    maxOutput: 16384,
    reasoning: true,
  },
  {
    // Meta Llama 3.2 11B Vision — restores a free Llama after nemotron-super-49b
    // (Llama-3.3-based) hit NVIDIA's 410 EOL. A 12-model sweep found exactly two
    // survivors and only the 11B finishes a real completion. Older than the rest
    // of the tier and deliberately so: it is a real Llama that actually answers.
    // Slowest in the tier (~18 tok/s) — last rung of the cascade.
    id: "free/llama-3.2-11b-vision",
    name: "[Free] Llama 3.2 11B Vision",
    version: "3.2-11b-vision",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 128000,
    maxOutput: 16384,
    // NO `vision: true` despite the name and blockrun's `categories:
    // ["chat","vision"]` — 2026-08-31, three consecutive 64x64 PNG probes came
    // back "I'm unable to see the image" / "you haven't provided an image",
    // while a plain-text control on the same id answered fine. The model is
    // alive; the image path is not. Mirroring the catalog's claim here would
    // have routed image turns to it. See the nano-omni note above.
  },
  {
    // Cohere North Mini Code, on OpenRouter's $0 pool — 607ms median, the
    // fastest thing in the tier. Emits reasoning_content (content is clean once
    // the budget is large enough to finish, verified live).
    // NOTE: NOT an nvidia/* id upstream — see FREE_UPSTREAM_OVERRIDES in proxy.ts.
    id: "free/north-mini-code",
    name: "[Free] Cohere North Mini Code",
    version: "north-mini-code",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 256000,
    maxOutput: 16384,
    reasoning: true,
  },
  {
    // Poolside Laguna XS 2.1 on OUR NVIDIA key (~161 tok/s). Deliberately not
    // the OpenRouter twin, which 429s on every attempt — so this rung and
    // north-mini-code sit on DIFFERENT capacity pools, which is why they are
    // adjacent in the cascade.
    // NOTE: NOT an nvidia/* id upstream — see FREE_UPSTREAM_OVERRIDES in proxy.ts.
    id: "free/laguna-xs-2.1",
    name: "[Free] Poolside Laguna XS 2.1",
    version: "xs-2.1",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 131072,
    maxOutput: 16384,
  },

  // ── 2026-08-30 paid catalog refresh (blockrun #449) ─────────────────────
  // Three additions, each probe-verified upstream with a real completion AND a
  // real image before listing. All three carry `vision: true` on that evidence
  // — unlike the free tier, where the same claim did not survive a probe.
  {
    // Alibaba's 3.8 generation: 125B MoE, one tier above the whole 3.7 line and
    // cheaper than the qwen3.7-plus ($0.32/$1.28) it outperforms.
    // Vision took two probes to establish upstream: the first 400'd with
    // `invalid_parameter_error` on an 8x8 PNG because the model requires >10px
    // per side; 64x64 answered correctly. A single 400 is not a capability gap.
    id: "qwen/qwen3.8-flash",
    name: "Qwen3.8 Flash",
    version: "3.8-flash",
    inputPrice: 0.15,
    outputPrice: 0.47,
    contextWindow: 1000000,
    maxOutput: 131072,
    reasoning: true,
    vision: true,
    toolCalling: true,
  },
  {
    // The first DeepSeek SKU that takes images. Priced at DeepSeek's PEAK rate
    // on purpose: they now split peak/off-peak and off-peak is half, so listing
    // the lower number would sell under cost for seven hours every weekday.
    id: "deepseek/deepseek-v4-flash-vision-exp",
    name: "DeepSeek V4 Flash Vision",
    version: "v4-flash-vision-exp",
    inputPrice: 0.44,
    outputPrice: 1.32,
    contextWindow: 1048576,
    maxOutput: 65536,
    reasoning: true,
    vision: true,
    toolCalling: true,
  },
  {
    // NOT a cheaper mimo-v2.5-pro — a different, natively multimodal SKU. The
    // Pro entry is text-only upstream while this one takes images, at a third
    // of the price. Keep both.
    id: "xiaomi/mimo-v2.5",
    name: "Xiaomi MiMo V2.5",
    version: "2.5",
    inputPrice: 0.14,
    outputPrice: 0.28,
    contextWindow: 1048576,
    maxOutput: 131072,
    reasoning: true,
    vision: true,
    toolCalling: true,
  },

  // Z.AI GLM-5 Models
  {
    // Z.AI's flagship, live-probed by blockrun 2026-08-19 against api.z.ai
    // (real completion in 2s, content alongside reasoning tokens). $1.40/$4.40,
    // cached input $0.26, off the international USD price list.
    // maxOutput is 131072, NOT the 1M context: that is the hard ceiling the API
    // enforces (error 1210 above it), the same on every GLM-5 SKU.
    // Thinking is ALWAYS ON here and cannot be disabled.
    id: "zai/glm-5.3",
    name: "GLM-5.3",
    version: "5.3",
    inputPrice: 1.4,
    outputPrice: 4.4,
    contextWindow: 1000000,
    maxOutput: 131072,
    reasoning: true,
    toolCalling: true,
  },
  {
    // Z.AI's first natively multimodal GLM-5 — 320B/18B MoE. blockrun probed
    // text, vision (base64 data URL → correct answer), tools
    // (finish_reason=tool_calls with well-formed arguments) and streaming live
    // on 2026-08-27 before listing it.
    //
    // MUST be in this catalog, not just router-core's: it is router-core's eco
    // MEDIUM and COMPLEX primary, and estimateAmount() returns undefined for an
    // id we do not carry — which makes the request skip the maxCostPerRun filter
    // AND never accumulate into session cost. An uncatalogued routing target is
    // a cost-cap hole, not a logging gap.
    //
    // Price is the LIST rate. Z.AI is running a 50% launch promo ($0.075/$0.25)
    // that ENDS 2026-09-09; listing the promo rate would put us under COGS the
    // morning it lapses. Thinking is always on, as on glm-5.3.
    id: "zai/glm-5.3-flash",
    name: "GLM-5.3 Flash",
    version: "5.3-flash",
    inputPrice: 0.15,
    outputPrice: 0.5,
    contextWindow: 1000000,
    maxOutput: 131072,
    reasoning: true,
    vision: true,
    toolCalling: true,
  },
  {
    // Launched 2026-06-16. Was Z.AI's flagship until glm-5.3 (above) took the
    // slot on 2026-08-19. 1M-token context,
    // beats GPT-5.5 on long-horizon coding at a fraction of the cost.
    // Paid per-token at $1.40/$4.40 (same as glm-5.1, cached $0.26).
    id: "zai/glm-5.2",
    name: "GLM-5.2",
    version: "5.2",
    inputPrice: 1.4,
    outputPrice: 4.4,
    contextWindow: 1000000,
    maxOutput: 131072,
    reasoning: true,
    toolCalling: true,
  },
  {
    // Launch promo (flat $0.001/call) ended 2026-06-05 — backend now bills
    // glm-5.1 per-token at $1.40/$4.40 (billingMode: "paid").
    id: "zai/glm-5.1",
    name: "GLM-5.1",
    version: "5.1",
    inputPrice: 1.4,
    outputPrice: 4.4,
    contextWindow: 200000,
    maxOutput: 128000,
    reasoning: true,
    toolCalling: true,
    promo: { flatPrice: 0.001, startDate: "2026-04-01", endDate: "2026-06-05" },
  },
  {
    // Flat-rate launch promo ended 2026-06-06 — backend bills per-token now.
    // Repriced 0.60/1.92 → 1.00/3.20 (blockrun #354 correction).
    id: "zai/glm-5",
    name: "GLM-5",
    version: "5",
    inputPrice: 1.0,
    outputPrice: 3.2,
    contextWindow: 200000,
    maxOutput: 128000,
    reasoning: true,
    toolCalling: true,
  },
  {
    // Flat-rate launch promo ended 2026-06-06 — backend bills per-token now.
    id: "zai/glm-5-turbo",
    name: "GLM-5 Turbo",
    version: "5-turbo",
    inputPrice: 1.2,
    outputPrice: 4.0,
    contextWindow: 200000,
    maxOutput: 128000,
    reasoning: true,
    toolCalling: true,
  },
];

/**
 * Get the active flat price for a model, or undefined if none.
 * Permanent flat pricing (flatPrice) never expires; promos auto-expire
 * after their endDate.
 */
export function getActivePromoPrice(
  model: BlockRunModel,
  now: Date = new Date(),
): number | undefined {
  if (model.flatPrice !== undefined) return model.flatPrice;
  if (!model.promo) return undefined;
  const start = new Date(model.promo.startDate);
  const end = new Date(model.promo.endDate);
  if (now >= start && now < end) return model.promo.flatPrice;
  return undefined;
}

/**
 * Convert BlockRun model definitions to OpenClaw ModelDefinitionConfig format.
 */
function toOpenClawModel(m: BlockRunModel): ModelDefinitionConfig {
  return {
    id: m.id,
    name: m.name,
    api: "openai-completions",
    reasoning: m.reasoning ?? false,
    input: m.vision ? ["text", "image"] : ["text"],
    cost: {
      input: m.inputPrice,
      output: m.outputPrice,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: m.contextWindow,
    maxTokens: m.maxOutput,
  };
}

/**
 * Alias models that map to real models.
 * These allow users to use friendly names like "free" or "gpt-120b".
 *
 * Only friendly short names are advertised. Full `provider/model` keys in
 * MODEL_ALIASES are backward-compat / delisted redirects whose target is a real
 * model that is already listed — surfacing them as their own entries is wrong
 * (e.g. `free/deepseek-v4-pro` was delisted 2026-04-30 and redirects to
 * `free/deepseek-v4-flash`, yet showed up as a listable "V4 Pro" model). They
 * stay fully callable via resolveModelAlias(); they just must not appear in
 * `/v1/models` or any picker.
 */
const ALIAS_MODELS: ModelDefinitionConfig[] = Object.entries(MODEL_ALIASES)
  .filter(([alias]) => !alias.includes("/"))
  .map(([alias, targetId]) => {
    const target = BLOCKRUN_MODELS.find((m) => m.id === targetId);
    if (!target) return null;
    return toOpenClawModel({ ...target, id: alias, name: `${alias} → ${target.name}` });
  })
  .filter((m): m is ModelDefinitionConfig => m !== null);

/**
 * All BlockRun models in OpenClaw format (including aliases).
 * Used for proxy-side resolution (alias → target ID), tool routing, etc.
 *
 * Catalog entries shadowed by an identically-keyed alias are excluded:
 * resolveModelAlias checks MODEL_ALIASES first, so those catalog entries are
 * unreachable and their metadata (name/pricing) would misadvertise what
 * callers actually get. The alias-derived entry carries the redirect
 * target's real metadata instead.
 */
export const OPENCLAW_MODELS: ModelDefinitionConfig[] = [
  ...BLOCKRUN_MODELS.filter((m) => !(m.id in MODEL_ALIASES)).map(toOpenClawModel),
  ...ALIAS_MODELS,
];

/**
 * Subset of OPENCLAW_MODELS the OpenClaw `/model` picker advertises —
 * driven by `src/top-models.json`. Hidden entries remain callable via direct
 * ID and via aliases; they just don't clutter the picker.
 */
const OPENCLAW_MODEL_BY_ID = new Map(OPENCLAW_MODELS.map((m) => [m.id, m]));
export const VISIBLE_OPENCLAW_MODELS: ModelDefinitionConfig[] = TOP_MODELS.flatMap((id) => {
  const model = OPENCLAW_MODEL_BY_ID.get(id);
  return model ? [model] : [];
});

/**
 * Build a ModelProviderConfig for BlockRun.
 *
 * Returns only the TOP_MODELS-listed subset so the OpenClaw picker stays
 * focused. Hidden models are still resolvable through the proxy.
 *
 * @param baseUrl - The proxy's local base URL (e.g., "http://127.0.0.1:12345")
 */
export function buildProviderModels(baseUrl: string): ModelProviderConfig {
  return {
    baseUrl: `${baseUrl}/v1`,
    api: "openai-completions",
    models: VISIBLE_OPENCLAW_MODELS,
  };
}

/**
 * Check if a model is optimized for agentic workflows.
 * Agentic models continue autonomously with multi-step tasks
 * instead of stopping and waiting for user input.
 */
export function isAgenticModel(modelId: string): boolean {
  const model = BLOCKRUN_MODELS.find(
    (m) => m.id === modelId || m.id === modelId.replace("blockrun/", ""),
  );
  return model?.agentic ?? false;
}

/**
 * Get all agentic-capable models.
 */
export function getAgenticModels(): string[] {
  return BLOCKRUN_MODELS.filter((m) => m.agentic).map((m) => m.id);
}

/**
 * Check if a model supports OpenAI-compatible structured tool/function calling.
 * Models without this flag (e.g. grok-code-fast-1) output tool invocations as
 * plain text JSON, which leaks {"command":"..."} into visible chat messages.
 */
export function supportsToolCalling(modelId: string): boolean {
  const normalized = modelId.replace("blockrun/", "");
  const model = BLOCKRUN_MODELS.find((m) => m.id === normalized);
  return model?.toolCalling ?? false;
}

/**
 * Check if a model supports vision (image inputs).
 * Models without this flag cannot process image_url content parts.
 */
export function supportsVision(modelId: string): boolean {
  const normalized = modelId.replace("blockrun/", "");
  const model = BLOCKRUN_MODELS.find((m) => m.id === normalized);
  return model?.vision ?? false;
}

/**
 * Get context window size for a model.
 * Returns undefined if model not found.
 */
export function getModelContextWindow(modelId: string): number | undefined {
  const normalized = modelId.replace("blockrun/", "");
  const model = BLOCKRUN_MODELS.find((m) => m.id === normalized);
  return model?.contextWindow;
}

/**
 * Check if a model has reasoning/thinking capabilities.
 * Reasoning models may require reasoning_content in assistant tool_call messages.
 */
export function isReasoningModel(modelId: string): boolean {
  const normalized = modelId.replace("blockrun/", "");
  const model = BLOCKRUN_MODELS.find((m) => m.id === normalized);
  return model?.reasoning ?? false;
}
