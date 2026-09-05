<div align="center">

<img src="assets/banner.png" alt="ClawRouter Banner" width="600">

<h1>The LLM router built for autonomous agents</h1>

<p>Agents can't sign up for accounts. Agents can't enter credit cards.<br>
Agents can only sign transactions.<br><br>
<strong>ClawRouter is the only LLM router that lets agents operate independently.</strong><br><br>
<em>Pay however you like: <strong>credit card</strong> — sign up at <a href="https://user.blockrun.ai"><strong>user.blockrun.ai</strong></a>, top up, mint an API key<br>
or <strong>USDC</strong> on Solana or Base (x402 wallet, no account at all).<br>
Or neither — <!-- br:models.free -->7<!-- /br:models.free --> models are free, with no signup, no key and no wallet.</em></p>

<br>

<img src="https://img.shields.io/badge/🆓_7_Free_Models-success?style=for-the-badge" alt="7 free models">&nbsp;
<img src="https://img.shields.io/badge/🤖_Agent--Native-black?style=for-the-badge" alt="Agent native">&nbsp;
<img src="https://img.shields.io/badge/💳_Card_or_USDC-blue?style=for-the-badge" alt="Card or USDC">&nbsp;
<img src="https://img.shields.io/badge/⚡_Local_Routing-yellow?style=for-the-badge" alt="Local routing">&nbsp;
<img src="https://img.shields.io/badge/💰_x402_USDC-purple?style=for-the-badge" alt="x402 USDC">&nbsp;
<img src="https://img.shields.io/badge/🔓_Open_Source-green?style=for-the-badge" alt="Open source">

[![npm version](https://img.shields.io/npm/v/@blockrun/clawrouter.svg?style=flat-square&color=cb3837)](https://npmjs.com/package/@blockrun/clawrouter)
[![npm downloads](https://img.shields.io/npm/dm/@blockrun/clawrouter.svg?style=flat-square&color=blue)](https://npmjs.com/package/@blockrun/clawrouter)
[![GitHub stars](https://img.shields.io/github/stars/BlockRunAI/ClawRouter?style=flat-square&label=GitHub%20stars)](https://github.com/BlockRunAI/ClawRouter)
[![CI](https://img.shields.io/github/actions/workflow/status/BlockRunAI/ClawRouter/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/BlockRunAI/ClawRouter/actions)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)

[![USDC Hackathon Winner](https://img.shields.io/badge/🏆_USDC_Hackathon-Agentic_Commerce_Winner-gold?style=flat-square)](https://x.com/USDC/status/2021625822294216977)
[![x402 Protocol](https://img.shields.io/badge/x402-Micropayments-purple?style=flat-square)](https://x402.org)
[![Base Network](https://img.shields.io/badge/Base-USDC-0052FF?style=flat-square&logo=coinbase&logoColor=white)](https://base.org)
[![Solana](https://img.shields.io/badge/Solana-USDC-9945FF?style=flat-square&logo=solana&logoColor=white)](https://solana.com)
[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-orange?style=flat-square)](https://openclaw.ai)
[![Telegram](https://img.shields.io/badge/Telegram-Community-26A5E4?style=flat-square&logo=telegram)](https://t.me/blockrunAI)

</div>

> **ClawRouter** is an open-source smart LLM router that reduces AI API costs by up to <!-- br:savings.autoVsBaselinePct -->84<!-- /br:savings.autoVsBaselinePct -->%. It analyzes each request across <!-- br:clawrouter.dimensions -->15<!-- /br:clawrouter.dimensions --> dimensions and routes to the cheapest capable model in under 1ms, entirely locally. It is the only LLM router that an autonomous agent can pay for by itself — a wallet signature is the account, and USDC micropayments over the x402 protocol are the billing — and it takes an ordinary credit card too: sign up at [user.blockrun.ai](https://user.blockrun.ai), top up, and run the same router on an API key. <!-- br:models.chatVisible -->76<!-- /br:models.chatVisible --> models from OpenAI, Anthropic, Google, xAI, DeepSeek, and more. MIT licensed.

---

## What BlockRun is

> **BlockRun lets agents pay for the outcome — every LLM, tool and data source, best value per dollar.**

Not a seat, not a subscription, not a monthly minimum you keep paying while the agent idles. An agent asks for one thing — an answer, an image, a transcript, a price, a call placed — and pays for that one thing at the moment it happens. Nothing to sign up for, nothing to cancel.

|                           |                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Every LLM**             | <!-- br:models.chatVisible -->76<!-- /br:models.chatVisible --> chat models across 9 providers, behind one endpoint and one balance                                                                                                                                                                                                                           |
| **Every tool**            | <!-- br:models.image -->9<!-- /br:models.image --> image models, <!-- br:models.video -->8<!-- /br:models.video --> video models, music, <!-- br:models.speech -->5<!-- /br:models.speech --> voices, img2img editing, and outbound phone calls that come back as transcripts                                                                                 |
| **Every data source**     | web, news and neural search; prediction markets; live crypto and equity quotes; on-chain SQL over 100M+ labeled wallets; DEX routing; RPC across <!-- br:chains.rpc -->40<!-- /br:chains.rpc --> chains                                                                                                                                                       |
| **Best value per dollar** | <!-- br:clawrouter.dimensions -->15<!-- /br:clawrouter.dimensions -->-dimension local routing sends each request to the cheapest model that can actually do it — <!-- br:savings.autoVsBaselinePct -->84<!-- /br:savings.autoVsBaselinePct -->% below pinning Claude Opus 5 on the same traffic, computed from a published workload mix rather than estimated |

**ClawRouter is how an agent reaches it.** BlockRun is the gateway and the billing; ClawRouter is the MIT-licensed router that runs on your machine, decides which model each request deserves, and settles the bill — a wallet signature in USDC, or a credit-card-funded API key. The rest of this README is about ClawRouter.

---

## Why ClawRouter exists

Every other LLM router was built for **human developers** — create an account, get an API key, pick a model from a dashboard, pay with a credit card.

**Agents can't do any of that.**

ClawRouter is built for the agent-first world:

- **Starts at $0** — <!-- br:models.free -->7<!-- /br:models.free --> open-weight models are free forever (incl. a 1M-context reasoner and two sub-second coders). Image turns route to paid models — see the free-tier note below.
- **No accounts needed** — a wallet is generated locally, no signup
- **No API keys needed** — your wallet signature IS authentication
- **No model selection** — <!-- br:clawrouter.dimensions -->15<!-- /br:clawrouter.dimensions -->-dimension scoring + constraint-first ranking ([router-core](https://github.com/BlockRunAI/router-core)) picks the right model automatically
- **No credit card needed** — agents pay per-request with USDC via [x402](https://x402.org)
- **No trust required** — runs locally, <1ms routing, zero external dependencies

This is the stack that lets agents operate autonomously: **x402 + USDC + local routing**.

### …and if you are a human, not an agent

Every "no X needed" above is a capability, not a restriction. **ClawRouter takes a credit card too.** Sign up at **[user.blockrun.ai](https://user.blockrun.ai)**, top up, mint an API key, and run `clawrouter login brk_live_…`. Same router, same <!-- br:models.chatVisible -->76<!-- /br:models.chatVisible --> models, same local routing — calls go to `api.blockrun.ai` on a bearer token and bill your account credit. No crypto, no gas, no seed phrase.

| You are             | Pay with                                | Setup                                                                                       |
| ------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------- |
| Just trying it      | Nothing                                 | Install and pin a free model                                                                |
| A person            | **Credit card** → account credit        | **Sign up at [user.blockrun.ai](https://user.blockrun.ai)** → `clawrouter login brk_live_…` |
| An autonomous agent | **USDC** on Solana or Base, per request | Nothing — a wallet is generated on first run (Solana by default)                            |

Full walkthrough: [Paying with a credit card](#paying-with-a-credit-card-api-key).

---

## How it compares

|                  | OpenRouter        | LiteLLM          | Martian           | Portkey           | **ClawRouter**                                                         |
| ---------------- | ----------------- | ---------------- | ----------------- | ----------------- | ---------------------------------------------------------------------- |
| **Models**       | 200+              | 100+             | Smart routing     | Gateway           | **<!-- br:models.chatVisible -->76<!-- /br:models.chatVisible -->**    |
| **Free tier**    | Rate-limited      | BYO keys         | No                | No                | **<!-- br:models.free -->7<!-- /br:models.free --> models, no signup** |
| **Routing**      | Manual selection  | Manual selection | Smart (closed)    | Observability     | **Smart (open source)**                                                |
| **Auth**         | Account + API key | Your API keys    | Account + API key | Account + API key | **Wallet signature _or_ API key**                                      |
| **Payment**      | Credit card       | BYO keys         | Credit card       | $49-499/mo        | **USDC per-request _or_ card credit**                                  |
| **Runs locally** | No                | Yes              | No                | No                | **Yes**                                                                |
| **Open source**  | No                | Yes              | No                | Partial           | **Yes**                                                                |
| **Agent-ready**  | No                | No               | No                | No                | **Yes**                                                                |

✓ Open source · ✓ Smart routing · ✓ Runs locally · ✓ Crypto native · ✓ Agent ready

**We're the only one that checks all five boxes.**

---

## Quick Start

> **No wallet? <!-- br:models.free -->7<!-- /br:models.free --> models work free out of the box.** Install, run, and pin `free/nemotron-3.5-lightning` (or any of the <!-- br:models.free -->7<!-- /br:models.free -->) — no crypto, no signup, no balance required. Add a credit card or USDC later when you want paid models.

**Two ways to pay for the paid ones — pick one, the rest of ClawRouter is identical:**

|                   | Wallet (default)                                           | API key                                                                                                    |
| ----------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Who it is for** | Autonomous agents, and anyone happy holding USDC           | People who would rather pay with a card                                                                    |
| **Setup**         | Nothing — a wallet is generated on first run               | Sign up at [user.blockrun.ai](https://user.blockrun.ai), top up, mint a key, `clawrouter login brk_live_…` |
| **Auth**          | An x402 signature per request                              | `Authorization: Bearer brk_live_…`                                                                         |
| **Gateway**       | `sol.blockrun.ai` (Solana, default) / `blockrun.ai` (Base) | `api.blockrun.ai`                                                                                          |
| **Billing**       | USDC leaves your wallet per call, non-custodial            | Card-funded account credit, drawn down at exact usage                                                      |
| **Fees**          | $0.001/tx settlement fee (covers on-chain gas)             | 5.5% + $0.30 on the top-up, then list price with **nothing per call**                                      |

ClawRouter prefers the API key whenever one is configured, so `clawrouter login`
is all it takes to switch and `clawrouter logout` is all it takes to switch back.

> **Where do I sign up?** [**user.blockrun.ai**](https://user.blockrun.ai) — sign in with
> Google, add credit with a card under **Credits**, mint a key under **API Keys**. That
> one key covers all <!-- br:models.chatVisible -->76<!-- /br:models.chatVisible --> chat models
> plus images, video, speech and the live-data APIs. No wallet, no crypto, no seed phrase.

### Desktop control plane (macOS)

The Electron app in [`apps/desktop`](apps/desktop) provides one-click connections
for OpenClaw, Codex, Hermes, DeepSeek Harness, and Pi, plus model pricing/context,
wallet balances, Solana/Base switching, and Coinbase Onramp. It snapshots each
agent's existing config before changing it and restores the original bytes when
you disconnect. Wallets are shared through `~/.blockrun`; older ClawRouter
wallets are copied there automatically without overwriting existing Core files.

### Option A — OpenClaw Agent

[OpenClaw](https://openclaw.ai) is an AI coding agent. If you're using it, ClawRouter installs as a plugin. **Two paths:**

**A1. Recommended — one-shot install script:**

```bash
curl -fsSL https://blockrun.ai/ClawRouter-update | bash
openclaw gateway restart
```

This handles everything: registration, models config, auth profile, wallet setup. Smart routing (`blockrun/auto`) is now your default model.

> OpenClaw now also bundles an unrelated plugin named `clawrouter`
> (`@openclaw/clawrouter`). BlockRun uses the distinct plugin id
> `blockrun-clawrouter`; the installer preserves the official plugin and allows
> both products to coexist.

**A2. If you prefer pure npm:**

```bash
npm install -g @blockrun/clawrouter
clawrouter setup            # finishes OpenClaw integration — REQUIRED
openclaw gateway restart
```

> ⚠️ **Skipping `clawrouter setup` will leave you broken.** Bare `npm install -g` only puts the package on disk; it does NOT register the plugin with OpenClaw, sync the models allowlist, or write the auth profile. Symptom: `/models` in your bot shows only OpenClaw's defaults instead of the 55 BlockRun models. Run `clawrouter setup` to repair, or use path A1 to begin with.

### Option B — Standalone (continue.dev, Cursor, VS Code, any OpenAI-compatible client)

> **Using Claude Code?** Check out [BRCC](https://github.com/BlockRunAI/brcc) — it's purpose-built for Claude Code with the same smart routing and x402 payments.
>
> **Using NousResearch Hermes?** See [ClawRouter-Hermes](https://github.com/BlockRunAI/ClawRouter-Hermes) — a Python plugin that wires Hermes into the ClawRouter proxy. Same wallet, same <!-- br:models.chatVisible -->76<!-- /br:models.chatVisible --> models, same x402 USDC settlement on Solana & Base.

No OpenClaw required. ClawRouter runs as a local proxy on port 8402.

**1. Start the proxy**

```bash
npx @blockrun/clawrouter
```

**2. Fund your wallet** — optional, skip for free tier
Your wallet address is printed on first run. For paid models, send a few USDC on Solana (the default chain) or Base — $5 covers thousands of requests. Prefer a card? [Sign up at user.blockrun.ai](https://user.blockrun.ai) and run `clawrouter login brk_live_…` instead. To stay at $0, pin any of the <!-- br:models.free -->7<!-- /br:models.free --> free models (e.g. `free/nemotron-3.5-lightning`) or use `/model free` inside OpenClaw.

**3. Point your client at `http://localhost:8402`**

<details>
<summary><strong>continue.dev</strong> — <code>~/.continue/config.yaml</code></summary>

> **Important:** `apiBase` must end with `/v1/` (including the trailing slash). Without it, continue.dev constructs the URL as `/chat/completions` instead of `/v1/chat/completions`, and the proxy returns 404.

```yaml
models:
  - name: ClawRouter Auto
    provider: openai
    model: blockrun/auto
    apiBase: http://localhost:8402/v1/
    apiKey: x402
    roles:
      - chat
      - edit
      - apply
```

To pin a specific model, replace `blockrun/auto` with any model from [blockrun.ai/models](https://blockrun.ai/models), e.g. `anthropic/claude-opus-5`, `xai/grok-4.5`.

Both `provider: openai` and `provider: clawrouter` work — just make sure `apiBase` ends with `/v1/`.

<details>
<summary>Legacy JSON format (<code>~/.continue/config.json</code>)</summary>

```json
{
  "models": [
    {
      "title": "ClawRouter Auto",
      "provider": "openai",
      "model": "blockrun/auto",
      "apiBase": "http://localhost:8402/v1/",
      "apiKey": "x402"
    }
  ]
}
```

</details>
</details>

<details>
<summary><strong>Cursor</strong> — Settings → Models → OpenAI-compatible</summary>

Set base URL to `http://localhost:8402`, API key to `x402`, model to `blockrun/auto`.

</details>

<details>
<summary><strong>Any OpenAI SDK</strong></summary>

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8402", api_key="x402")
response = client.chat.completions.create(model="blockrun/auto", messages=[...])
```

</details>

---

## Routing Profiles

Choose your routing strategy with `/model <profile>`:

| Profile          | Strategy           | Savings                                                                            | Best For             |
| ---------------- | ------------------ | ---------------------------------------------------------------------------------- | -------------------- |
| `/model free`    | Free NVIDIA models | **100%**                                                                           | $0 balance, learning |
| `/model auto`    | Balanced (default) | **<!-- br:savings.autoVsBaselinePct -->84<!-- /br:savings.autoVsBaselinePct -->%** | General use          |
| `/model eco`     | Cheapest possible  | **<!-- br:savings.ecoVsBaselinePct -->98<!-- /br:savings.ecoVsBaselinePct -->%**   | Maximum savings      |
| `/model premium` | Best quality       | 0%                                                                                 | Mission-critical     |

**Shortcuts:** `/model grok`, `/model br-sonnet`, `/model gpt5`, `/model o3`

---

## How It Works

**100% local routing. <1ms latency. Zero external API calls.**

Routing decisions come from [`@blockrun/router-core`](https://github.com/BlockRunAI/router-core) — Router Core **V3.5**, the constraint-first portfolio router shared by every BlockRun product (ClawRouter, Franklin, the `@blockrun/llm` SDKs, ClawRouter-Hermes). ClawRouter inlines it at build time, pinned to an exact commit, and injects its live model catalog at startup.

```
Request → 15-dimension scorer → tier + task shape
        → hard filters (tools · vision · context · max-output · structured output)
        → rank survivors (quality · capability · cost · speed · reliability)
        → winner + ordered fallback chain → Response
```

1. **Classify** — a <!-- br:clawrouter.dimensions -->15<!-- /br:clawrouter.dimensions -->-dimension weighted scorer picks a tier (`SIMPLE` / `MEDIUM` / `COMPLEX` / `REASONING`); a task classifier labels the shape of the work (`code_agent`, `tool_agent`, `reasoning_math`, `long_context`, `vision`, …). Turns that actually need their tools switch to agent-tuned tiers automatically.
2. **Filter** — every model that cannot satisfy the request is dropped _before_ anything is scored. A model that can't call tools, can't read the image, or can't hold the conversation never gets to win on price.
3. **Rank** — survivors are scored on task quality, capability, estimated cost, speed and reliability, with per-profile weights (`eco` leans on cost, `premium` on quality and reliability).
4. **Recover** — the whole ranked list rides along as the fallback chain, so a provider timeout or 5xx costs a retry, not the task.

| Tier      | ECO Model                         | AUTO Model                      | PREMIUM Model                | AGENTIC Model ‡           |
| --------- | --------------------------------- | ------------------------------- | ---------------------------- | ------------------------- |
| SIMPLE    | nemotron-3.5-lightning (**FREE**) | gemini-2.5-flash ($0.30/$2.50)  | gemini-3.5-flash ($1.50/$9)  | gpt-4o-mini ($0.15/$0.60) |
| MEDIUM    | glm-5.3-flash ($0.15/$0.50)       | gemini-3.5-flash ($1.50/$9)     | gpt-5.3-codex ($1.75/$14.00) | gpt-5-mini ($0.25/$2)     |
| COMPLEX   | glm-5.3-flash ($0.15/$0.50)       | gemini-3.1-pro ($2/$12)         | claude-fable-5 ($10/$50)     | claude-sonnet-5 ($3/$15)  |
| REASONING | deepseek-reasoner ($0.14/$0.28)   | deepseek-reasoner ($0.14/$0.28) | claude-sonnet-5 ($3/$15)     | claude-sonnet-5 ($3/$15)  |

† Withheld from `/v1/models` — since Router Core V3.5 no chain names such a model: every primary and every fallback rung above is a model you can find on the public pricing page. [savings-mix.json](https://github.com/BlockRunAI/blockrun/blob/main/src/brand/savings-mix.json) prices the published savings claim on the same visible models.
‡ Auto-selected in any profile when the turn actually needs its attached tools; prefers models that keep going instead of stopping to ask.

These are the curated primaries; every tier carries a benchmark-ordered fallback chain — full chains and per-profile ranking weights in [docs/routing-profiles.md](docs/routing-profiles.md). On router-core's frozen three-arm agent benchmark (τ-bench, BrowseComp, Terminal-Bench) the V3.4 policy (the last one benchmarked; V3.5 is a catalog refresh on the same scorer and weights) completed **57%** of tasks vs **49%** for the previous rules router, at **6.4%** lower cost per successful task — and spent **8.9%** of the tokens a pinned flagship would have.

**<!-- br:savings.autoVsBaselinePct -->84<!-- /br:savings.autoVsBaselinePct -->% cheaper than pinning Claude Opus 5** for the same traffic, on `auto`; **<!-- br:savings.ecoVsBaselinePct -->98<!-- /br:savings.ecoVsBaselinePct -->%** on `eco`.

Not an "up to" figure. The baseline, the workload mix and the token ratio are
published in [`savings-mix.json`](https://github.com/BlockRunAI/blockrun/blob/main/src/brand/savings-mix.json),
priced against the live catalog, so anyone can recompute it and get the same
answer. Models withheld from `/v1/models` are excluded from the mix — pricing a
public claim on a model you cannot look up is not defensible — which makes the
number conservative.

Rollback lever: `routing.strategy: "rules"` restores the V2 primary-first selector; `routing.shadow` compares both locally without a second paid call.

---

## Image Generation

Generate images directly from chat with `/cr-imagegen`:

```
/cr-imagegen a dog dancing on the beach
/cr-imagegen --model gpt-image-2 a futuristic city at sunset
/cr-imagegen --model banana-pro --size 2048x2048 mountain landscape
```

> The slash command is `/cr-imagegen` to avoid colliding with Telegram channel commands. Typing `/imagegen` in chat still works for backward compatibility.

| Model                        | Provider             | Price        | Max Size  |
| ---------------------------- | -------------------- | ------------ | --------- |
| `nano-banana`                | Google Gemini Flash  | $0.05/image  | 1024x1024 |
| `banana-2`                   | Google Nano Banana 2 | $0.09/image  | 1024x1024 |
| `banana-pro`                 | Google Gemini Pro    | $0.10/image  | 4096x4096 |
| `gpt-image`                  | OpenAI GPT Image 1   | $0.02/image  | 1536x1024 |
| `gpt-image-2`                | OpenAI GPT Image 2   | $0.06/image  | 1536x1024 |
| `seedream`                   | ByteDance Seedream 5 | $0.045/image | 2848x1600 |
| `xai/grok-imagine-image`     | xAI Grok Imagine     | $0.02/image  | 1024x1024 |
| `xai/grok-imagine-image-pro` | xAI Grok Imagine Pro | $0.07/image  | 1024x1024 |
| `zai/cogview-4`              | Zhipu CogView-4      | $0.015/image | 1440x1440 |

## Video Generation

Generate short AI videos directly from chat with `/videogen`:

```
/videogen a red apple slowly spinning
/videogen --model seedance-2-fast --duration=5 a cat waving
/videogen --model grok-video a neon city at night
```

Or drive it over HTTP — ClawRouter proxies the BlockRun gateway, handles x402 payment, and downloads the returned MP4 to local disk, rewriting `url` to `http://localhost:8402/videos/<file>.mp4` so the asset survives past the upstream's temporary bucket.

```bash
curl -X POST http://localhost:8402/v1/videos/generations \
  -H "Content-Type: application/json" \
  -d '{"model":"bytedance/seedance-2.0-fast","prompt":"a red apple slowly spinning","duration_seconds":5}'
```

| Model                         | Provider            | 5s text-to-video | 5s image-to-video | Duration              |
| ----------------------------- | ------------------- | ---------------- | ----------------- | --------------------- |
| `bytedance/seedance-1.5-pro`  | ByteDance Seedance  | ~$0.46           | ~$0.46 (flat)     | 5s default, up to 10s |
| `bytedance/seedance-2.0-fast` | ByteDance Seedance  | ~$1.19           | ~$1.19 (flat)     | 5s default, up to 10s |
| `bytedance/seedance-2.0`      | ByteDance Seedance  | ~$1.49           | ~$1.49 (flat)     | 5s default, up to 10s |
| `azure/sora-2`                | OpenAI Sora (Azure) | ~$0.42 (4s)      | ~$0.42 (4s, flat) | 4s default; 4/8/12s   |
| `xai/grok-imagine-video`      | xAI Grok Imagine    | ~$0.42 (8s)      | n/a               | 8s default            |

Seedance is **token-priced upstream** at ~20,256 tokens/sec — the blockrun videos route now defaults Seedance to `resolution=720p` with `generate_audio=true` for text-to-video (2× the per-second token count of the older 480p baseline; audio is included in that rate). The quote is `duration × tokens/sec × $/1M tokens × 1.05 margin`. Image-to-video is priced the same as text-to-video (the earlier ~40% i2v discount was removed upstream on 2026-06-01; only video-to-video remains cheaper). Sora 2 is flat-priced at $0.10/sec for both t2v and i2v — note it rejects human faces in reference images (use Seedance + RealFace for real people). Calls block for 30–120s while the upstream polls the job. Seedance 2.0 Fast typically returns in 60–80s; 2.0 Pro trades latency for quality.

### BytePlus RealFace (Seedance 2.0 only)

For real-person character consistency across frames, pass `real_face_asset_id` (format `ta_xxxxxxxx`) on **2.0 Fast** or **2.0 Pro**. Asset IDs come from token360's Asset UI after H5 face verification — see blockrun's [/docs/video/real-person-ip](https://blockrun.ai/docs/video/real-person-ip) for the enrollment walkthrough. Cannot be combined with `image_url` (both seed the first frame — pick one). Pricing is unchanged.

```bash
curl -X POST http://localhost:8402/v1/videos/generations \
  -H "Content-Type: application/json" \
  -d '{"model":"bytedance/seedance-2.0","prompt":"the person walks through a forest","real_face_asset_id":"ta_abc123def","duration_seconds":5}'
```

## Image Editing (img2img)

Edit existing images with `/img2img`:

```
/img2img --image ~/photo.png change the background to a starry sky
/img2img --image ./cat.jpg --mask ./mask.png remove the background
```

| Option            | Required | Description                           |
| ----------------- | -------- | ------------------------------------- |
| `--image <path>`  | Yes      | Local image file path (supports `~/`) |
| `--mask <path>`   | No       | Mask image (white = area to edit)     |
| `--model <model>` | No       | Model to use (default: `gpt-image-1`) |
| `--size <WxH>`    | No       | Output size (default: `1024x1024`)    |

**API endpoint:** `POST http://localhost:8402/v1/images/image2image` — see [full docs](docs/image-generation.md#post-v1imagesimage2image).

## Phone & Voice Calls

Verify phone numbers and place AI-powered outbound voice calls directly from chat. Phone intelligence runs on Twilio; voice calls use Bland.ai. Payment is automatic via x402 from the wallet.

```
/cr-call +14155552671 "Hi, this is calling to confirm tomorrow's 3pm meeting"
/cr-call +14155552671 "Order a large pepperoni for delivery" --voice josh --max-duration 10
```

Calls are **fire-and-forget**: the request returns a `call_id` and `poll_url` immediately. The call itself runs in the cloud for up to 30 minutes. Poll `GET /v1/voice/call/{call_id}` (or `clawrouter share`/transcripts dashboard) to retrieve the transcript and recording when status is `completed`.

| Operation                         | Provider | Price                   |
| --------------------------------- | -------- | ----------------------- |
| Phone lookup (carrier, line type) | Twilio   | $0.01                   |
| Fraud check (SIM-swap, fwd)       | Twilio   | $0.05                   |
| Buy phone number (30-day lease)   | Twilio   | $5.00                   |
| Renew lease (+30 days)            | Twilio   | $5.00                   |
| List wallet's owned numbers       | Twilio   | $0.001                  |
| Release a number                  | Twilio   | free                    |
| **AI voice call (≤30 min)**       | Bland.ai | **$0.54 flat per call** |
| Poll call status / transcript     | Bland.ai | free                    |

**CLI for wallet-owned numbers:**

```bash
clawrouter phone numbers list                              # See active numbers + expiry
clawrouter phone numbers buy US --area-code 415            # Provision a SF number
clawrouter phone numbers renew +14155551234                # Extend 30 days
clawrouter phone numbers release +14155551234              # Release
clawrouter phone lookup +14155552671                       # Carrier + line type
clawrouter phone fraud +14155552671                        # SIM-swap + fwd signals
```

**HTTP API:**

```bash
# Place a call
curl -X POST http://localhost:8402/v1/voice/call \
  -H "Content-Type: application/json" \
  -d '{"to":"+14155552671","task":"Confirm the 3pm Thursday meeting.","max_duration":5}'
# → { "call_id": "call_abc123", "poll_url": "/v1/voice/call/call_abc123", "status": "queued" }

# Poll for transcript
curl http://localhost:8402/v1/voice/call/call_abc123
```

LLM agents discover all eight operations as `blockrun_phone_*` / `blockrun_voice_*` tools (see `/partners`).

> ⚠️ `blockrun_voice_call` and `/cr-call` place a **real** outbound phone call. Server enforces an emergency-number blocklist; choose `--from` from wallet-owned numbers via `phone numbers list`.

---

## Crypto Data (Surf)

Surf is BlockRun's unified crypto data API — **84 endpoints across 13 domains**: CEX/DEX markets, on-chain SQL over 80+ ClickHouse tables (Ethereum, Base, Arbitrum, BSC, TRON, HyperEVM, Tempo), 100M+ labeled wallets, prediction markets (Polymarket + Kalshi), social/CT mindshare, news, project/DeFi metrics, token analytics, unified search, VC fund intelligence. The killer feature is ad-hoc `POST /surf/onchain/sql` — agents query the warehouse directly without running an indexer.

ClawRouter ships Surf as a **skill, not as typed wrappers**. The proxy whitelists `/v1/surf/*` so any call through the local proxy is paid x402 from the same wallet; the agent reads `skills/surf/SKILL.md` for the endpoint catalog and crafts the HTTP call. No `blockrun_surf_*` tool definitions to maintain; a new Surf endpoint requires zero ClawRouter release.

| Tier |       Cost | Examples                                                      |
| ---- | ---------: | ------------------------------------------------------------- |
| 1    | **$0.001** | prices, rankings, lists, news                                 |
| 2    | **$0.005** | orderbooks, candles, search, wallet details, social mindshare |
| 3    | **$0.020** | on-chain SQL / query / schema, chat completions               |

**Usage (HTTP):**

```bash
# Aggregated BTC spot price (Tier 1, $0.001)
curl 'http://localhost:8402/v1/surf/market/price?symbol=BTC'

# Bulk wallet labels over 100M+ labeled wallets (Tier 2, $0.005)
curl 'http://localhost:8402/v1/surf/wallet/labels/batch?addresses=0xabc,0xdef,0x123'

# Ad-hoc on-chain SQL (Tier 3, $0.020)
curl -X POST 'http://localhost:8402/v1/surf/onchain/sql' \
  -H 'content-type: application/json' \
  -d '{"sql":"SELECT count() FROM ethereum.transactions WHERE block_timestamp >= now() - INTERVAL 1 HOUR"}'
```

No Surf account, no API key — settles directly to Surf's Base treasury in USDC via the same wallet as LLM calls. Full endpoint reference: [`skills/surf/SKILL.md`](skills/surf/SKILL.md). Upstream marketplace: <https://blockrun.ai/marketplace/surf>.

---

## Models & Pricing

<!-- br:models.chatVisible -->76<!-- /br:models.chatVisible --> models across 9 providers, one wallet. **<!-- br:models.free -->7<!-- /br:models.free --> models are $0 — paid models start at fractions of a cent.**

> **💡 "Cost per request"** = estimated cost for a typical chat message (~500 input + 500 output tokens). Paid requests also carry a flat **$0.001/tx settlement fee** (covers on-chain gas; already included in the price the gateway quotes). Free models never pay it.

### Budget Models (under $0.001/request)

| Model                                       | Input $/M | Output $/M | ~$/request | Context | Features                                     |
| ------------------------------------------- | --------: | ---------: | ---------: | ------- | -------------------------------------------- |
| free/nemotron-3.5-lightning                 |  **FREE** |   **FREE** |     **$0** | 1M      | reasoning (thinking mode) — the free default |
| free/nemotron-3-nano-30b                    |  **FREE** |   **FREE** |     **$0** | 131K    | fastest free model (~121 tok/s)              |
| free/laguna-xs-2.1                          |  **FREE** |   **FREE** |     **$0** | 131K    | coding (Poolside, ~161 tok/s)                |
| free/north-mini-code                        |  **FREE** |   **FREE** |     **$0** | 256K    | coding (Cohere, sub-second)                  |
| free/nemotron-3-nano-omni-30b-a3b-reasoning |  **FREE** |   **FREE** |     **$0** | 256K    | reasoning (text only — see note)             |
| free/nemotron-3-ultra-550b                  |  **FREE** |   **FREE** |     **$0** | 1M      | largest free model (550B/55B MoE)            |
| free/llama-3.2-11b-vision                   |  **FREE** |   **FREE** |     **$0** | 128K    | Meta Llama (text only — see note)            |
| qwen/qwen3.7-flash                          |     $0.03 |      $0.13 |    $0.0001 | 1M      | reasoning, tools (fastest Qwen tier)         |
| openai/gpt-5-nano                           |     $0.05 |      $0.40 |    $0.0002 | 128K    | tools                                        |
| openai/gpt-5.6-luna-pro                     |     $0.10 |      $0.60 |    $0.0004 | 1M      | reasoning, vision, agentic, tools            |
| openai/gpt-4.1-nano                         |     $0.10 |      $0.40 |    $0.0003 | 128K    | tools                                        |
| google/gemini-2.5-flash-lite                |     $0.10 |      $0.40 |    $0.0003 | 1M      | tools                                        |
| openai/gpt-4o-mini                          |     $0.15 |      $0.60 |    $0.0004 | 128K    | tools                                        |
| tencent/hy3                                 |    $0.132 |     $0.528 |    $0.0003 | 262K    | reasoning (Tencent Hy3)                      |
| xai/grok-4-fast                             |     $0.20 |      $0.50 |    $0.0004 | 131K    | tools                                        |
| openai/gpt-5.6-luna                         |     $0.20 |      $1.20 |    $0.0007 | 1M      | vision, agentic, tools                       |
| xai/grok-4-fast-reasoning                   |     $0.20 |      $0.50 |    $0.0004 | 131K    | reasoning, tools                             |
| xai/grok-4-1-fast                           |     $0.20 |      $0.50 |    $0.0004 | 131K    | tools                                        |
| openai/gpt-5-mini                           |     $0.25 |      $2.00 |    $0.0011 | 200K    | tools                                        |
| qwen/qwen3.7-plus                           |     $0.32 |      $1.28 |    $0.0008 | 1M      | reasoning, agentic, tools (balanced Qwen)    |
| deepseek/deepseek-chat                      |     $0.14 |      $0.28 |    $0.0002 | 1M      | tools (V4 Flash chat)                        |
| deepseek/deepseek-reasoner                  |     $0.14 |      $0.28 |    $0.0002 | 1M      | reasoning, tools (V4 Flash thinking)         |
| deepseek/deepseek-v4-pro                    |    $0.435 |      $0.87 |    $0.0007 | 1M      | reasoning, agentic, tools (V4 flagship)      |
| xiaomi/mimo-v2.5-pro                        |    $0.435 |      $0.87 |    $0.0007 | 1M      | reasoning (Xiaomi MiMo-V2.5 Pro)             |
| zai/glm-5-turbo                             |     $1.20 |      $4.00 |    $0.0026 | 200K    | tools                                        |
| minimax/minimax-m3                          |     $0.30 |      $1.20 |    $0.0008 | 1M      | reasoning, agentic, tools                    |
| minimax/minimax-m2.7                        |     $0.30 |      $1.20 |    $0.0008 | 205K    | reasoning, agentic, tools                    |
| minimax/minimax-m2.5                        |     $0.30 |      $1.20 |    $0.0008 | 205K    | reasoning, agentic, tools                    |
| google/gemini-2.5-flash                     |     $0.30 |      $2.50 |    $0.0014 | 1M      | vision, tools                                |
| google/gemini-3.5-flash-lite                |     $0.30 |      $2.50 |    $0.0014 | 1M      | reasoning, tools (thinking built-in)         |
| openai/gpt-4.1-mini                         |     $0.40 |      $1.60 |    $0.0010 | 128K    | tools                                        |
| google/gemini-3-flash-preview               |     $0.50 |      $3.00 |    $0.0018 | 1M      | vision                                       |
| moonshot/kimi-k2.5                          |     $0.60 |      $3.00 |    $0.0018 | 262K    | reasoning, vision, agentic, tools            |
| moonshot/kimi-k2.7                          |     $0.95 |      $4.00 |    $0.0025 | 262K    | reasoning, vision, agentic, tools            |

### Mid-Range Models ($0.001–$0.01/request)

| Model                       | Input $/M | Output $/M | ~$/request | Context | Features                                  |
| --------------------------- | --------: | ---------: | ---------: | ------- | ----------------------------------------- |
| anthropic/claude-haiku-4.5  |     $1.00 |      $5.00 |    $0.0030 | 200K    | vision, agentic, tools                    |
| zai/glm-5                   |     $1.00 |      $3.20 |    $0.0021 | 200K    | reasoning, tools                          |
| openai/gpt-5.6-terra-pro    |     $1.00 |      $6.00 |    $0.0035 | 1M      | reasoning, vision, agentic, tools         |
| openai/o1-mini              |     $1.10 |      $4.40 |    $0.0028 | 128K    | reasoning, tools                          |
| openai/o3-mini              |     $1.10 |      $4.40 |    $0.0028 | 128K    | reasoning, tools                          |
| openai/o4-mini              |     $1.10 |      $4.40 |    $0.0028 | 128K    | reasoning, tools                          |
| google/gemini-2.5-pro       |     $1.25 |     $10.00 |    $0.0056 | 1M      | reasoning, vision, tools                  |
| zai/glm-5.2                 |     $1.40 |      $4.40 |    $0.0029 | 1M      | reasoning, coding, tools (flagship)       |
| zai/glm-5.1                 |     $1.40 |      $4.40 |    $0.0029 | 200K    | reasoning, tools (promo ended 2026-06-05) |
| qwen/qwen3.7-max            |    $1.475 |     $4.425 |    $0.0030 | 1M      | reasoning, agentic, tools (Qwen flagship) |
| xai/grok-4.3                |     $1.25 |      $2.50 |    $0.0019 | 1M      | reasoning, vision, agentic, tools         |
| google/gemini-3.6-flash     |     $1.50 |      $7.50 |    $0.0045 | 1M      | reasoning, vision, tools (newest Flash)   |
| google/gemini-3.5-flash     |     $1.50 |      $9.00 |    $0.0053 | 1M      | reasoning, vision, tools (thinking)       |
| xai/grok-4.5                |     $2.00 |      $6.00 |    $0.0040 | 500K    | reasoning, vision, agentic, tools         |
| xai/grok-build-0.1          |     $1.00 |      $2.00 |    $0.0015 | 256K    | agentic coding, tools                     |
| openai/gpt-5.2              |     $1.75 |     $14.00 |    $0.0079 | 400K    | reasoning, vision, agentic, tools         |
| openai/gpt-5.3              |     $1.75 |     $14.00 |    $0.0079 | 128K    | reasoning, vision, agentic, tools         |
| openai/gpt-5.3-codex        |     $1.75 |     $14.00 |    $0.0079 | 400K    | agentic, tools                            |
| openai/gpt-4.1              |     $2.00 |      $8.00 |    $0.0050 | 128K    | vision, tools                             |
| openai/o3                   |     $2.00 |      $8.00 |    $0.0050 | 200K    | reasoning, tools                          |
| google/gemini-3-pro-preview |     $2.00 |     $12.00 |    $0.0070 | 1M      | reasoning, vision, tools                  |
| google/gemini-3.1-pro       |     $2.00 |     $12.00 |    $0.0070 | 1M      | reasoning, vision, tools                  |
| xai/grok-2-vision           |     $2.00 |     $10.00 |    $0.0060 | 131K    | vision, tools                             |
| openai/gpt-4o               |     $2.50 |     $10.00 |    $0.0063 | 128K    | vision, agentic, tools                    |
| openai/gpt-5.4              |     $2.50 |     $15.00 |    $0.0088 | 400K    | reasoning, vision, agentic, tools         |
| openai/gpt-5.6-terra        |     $2.00 |     $12.00 |    $0.0070 | 1M      | reasoning, vision, agentic, tools         |

### Premium Models ($0.01+/request)

| Model                       | Input $/M | Output $/M | ~$/request | Context | Features                          |
| --------------------------- | --------: | ---------: | ---------: | ------- | --------------------------------- |
| anthropic/claude-sonnet-5   |     $3.00 |     $15.00 |    $0.0090 | 1M      | reasoning, vision, agentic, tools |
| anthropic/claude-sonnet-4.6 |     $3.00 |     $15.00 |    $0.0090 | 200K    | reasoning, vision, agentic, tools |
| anthropic/claude-opus-5     |     $5.00 |     $25.00 |    $0.0150 | 1M      | reasoning, vision, agentic, tools |
| anthropic/claude-opus-4.8   |     $5.00 |     $25.00 |    $0.0150 | 1M      | reasoning, vision, agentic, tools |
| openai/gpt-5.6-sol          |     $5.00 |     $30.00 |    $0.0175 | 1M      | reasoning, vision, agentic, tools |
| openai/gpt-5.6-sol-pro      |     $5.00 |     $30.00 |    $0.0175 | 1M      | reasoning, vision, agentic, tools |
| openai/gpt-5.5              |     $5.00 |     $30.00 |    $0.0175 | 1M      | reasoning, vision, agentic, tools |
| moonshot/kimi-k3            |     $3.00 |     $15.00 |    $0.0110 | 1M      | reasoning, vision, agentic, tools |
| openai/chat-latest          |     $5.00 |     $30.00 |    $0.0175 | 128K    | vision, tools                     |
| openai/o1                   |    $15.00 |     $60.00 |    $0.0375 | 200K    | reasoning, tools                  |
| openai/gpt-5.2-pro          |    $21.00 |    $168.00 |    $0.0945 | 400K    | reasoning, tools                  |
| openai/gpt-5.4-pro          |    $30.00 |    $180.00 |    $0.1050 | 400K    | reasoning, tools                  |
| openai/gpt-5.5-pro          |    $30.00 |    $180.00 |    $0.1050 | 1M      | reasoning, vision, tools          |

> **Free tier:** <!-- br:models.free -->7<!-- /br:models.free --> open-weight models cost nothing — `/model free` pins the free default (`nemotron-3.5-lightning`, with the other six as fallbacks), `/model eco` opens on it, or pick one directly (e.g., `/model lightning` for 1M-context reasoning, `/model north-mini` or `/model laguna` for fast coding, `/model nano-30b` for the fastest).
>
> **No free vision.** Two free models are catalogued as vision-capable and neither reliably is: on a 64×64 solid-colour probe `nemotron-3-nano-omni` was right 1 of 4 times on Base and answered "white" for red on Solana, and `llama-3.2-11b-vision` replied "I'm unable to see the image" 3 of 3 while answering text fine. Both return HTTP 200, so a wrong answer arrives with no error to branch on. ClawRouter therefore does not flag them for vision, and requests carrying an `image_url` route to a paid vision model instead.
> **Best value:** `gpt-5-nano` and `gemini-2.5-flash-lite` deliver strong results at ~$0.0003/request.

---

## Payment

Two rails. This section covers the wallet one; the card/API-key one is
[below](#paying-with-a-credit-card-api-key).

Here, no account and no API key are needed at all — **payment IS authentication**, via [x402](https://x402.org).

```
Request → 402 (price: $0.003) → wallet signs USDC → retry → response
```

USDC stays in your wallet until spent — non-custodial. Price is visible in the 402 header before signing.

**Dual-chain support:** Pay with **USDC on Solana** (the default) or **USDC on Base (EVM)**. Both wallets are derived from a single BIP-39 mnemonic on first run. New installs get **Solana**; an install that predates the Solana default keeps its **Base** wallet — its USDC is there — until you switch with `/wallet solana`.

```bash
/wallet              # Check balance and address (both chains)
/wallet export       # Export mnemonic + keys for backup
/wallet recover      # Restore wallet from mnemonic on a new machine
/wallet solana       # Switch to Solana USDC payments
/wallet base         # Switch to Base (EVM) USDC payments
/stats               # View usage and savings
/stats clear         # Reset usage statistics
/exclude             # Show excluded models
/exclude add <model> # Block a model from routing (aliases work: "grok-4", "free")
/exclude remove <model> # Unblock a model
/exclude clear       # Remove all exclusions
```

**Fund your wallet:**

- **Solana (default):** Send USDC on Solana to your Solana address
- **Base (EVM):** Send USDC on Base to your EVM address
- **Coinbase/CEX:** Withdraw USDC to either network
- **Credit card:** don't fund a wallet at all — [sign up at user.blockrun.ai](https://user.blockrun.ai) and use an API key instead (below)

---

## Paying with a credit card (API key)

Wallets are what let an _agent_ pay for itself. If you are a person and would
rather pay the way you pay for everything else, BlockRun issues API keys backed
by card-funded credit — and ClawRouter speaks that too.

**1. Sign up and get a key**

Go to **[user.blockrun.ai](https://user.blockrun.ai)**:

1. **Sign in with Google.** That is the whole signup — no invite, no sales call.
2. **Credits** → top up with a credit card. The processing fee is **5.5% + $0.30**,
   charged at purchase, not on inference: you pay it once on the top-up and every
   model then bills at **provider list price with no markup**, with **no per-call
   minimum and no per-call fee**.
3. **API Keys** → create a key. It is shown once and looks like
   `brk_live_…` — copy it before you leave the page.

**2. Tell ClawRouter about it**

```bash
clawrouter login brk_live_...     # stores it in ~/.blockrun/.api-key (chmod 600)
clawrouter login                  # or run bare and paste at the prompt
```

Or, for CI and containers where you would rather not write a file:

```bash
export BLOCKRUN_API_KEY=brk_live_...
```

Either way, restart the proxy. That is the whole change — routing, model names,
the free tier, `/model auto`, exclusions and the OpenAI-compatible surface all
behave exactly as before:

```bash
npx @blockrun/clawrouter
# [ClawRouter] Using BlockRun API key brk_live_Ab3xQ9…f8c1 (from ~/.blockrun/.api-key)
# [ClawRouter] Billing: account credit — top up at https://user.blockrun.ai/dashboard/credits
```

**3. Check it, and switch back whenever**

```bash
clawrouter status     # names the mode, the gateway, and the masked key
clawrouter doctor     # verifies the key against the gateway (401 = revoked or mistyped)
clawrouter logout     # delete the key and go back to paying from the wallet
```

**Using it directly, without ClawRouter.** The same key works against
`api.blockrun.ai` from any OpenAI or Anthropic SDK — `Authorization: Bearer` for
OpenAI clients, `x-api-key` for Anthropic ones:

```bash
curl https://api.blockrun.ai/v1/chat/completions \
  -H "Authorization: Bearer brk_live_..." \
  -H "Content-Type: application/json" \
  -d '{"model": "anthropic/claude-sonnet-5", "messages": [{"role": "user", "content": "hello"}]}'
```

Running it through ClawRouter is what adds the smart routing, the fallback
chains, the response cache and the local spend controls.

**What to know**

- **The key wins.** If a wallet and a key are both present, ClawRouter uses the
  key. A machine with both means "bill my account", not "keep spending my USDC".
  `clawrouter logout` (and unsetting `BLOCKRUN_API_KEY`) reverses it.
- **No wallet is created.** In API-key mode ClawRouter never generates, reads or
  signs with a private key — `clawrouter doctor` will not mint one either.
- **Balance lives server-side.** There is no local balance to check: a call that
  outruns your credit comes back as HTTP `402 insufficient_quota`, naming the
  top-up page. Free models stay free and need no credit at all — all
  <!-- br:models.free -->7<!-- /br:models.free --> are served on the API-key gateway too.
- **One key covers nearly everything.** Verified live against `api.blockrun.ai`
  on 2026-09-05: chat completions (`/v1/chat/completions`), the Anthropic-shaped
  `/v1/messages`, `/v1/models`, image generation, speech, video, and the partner
  APIs — Surf crypto data, Exa search, prediction markets, and phone lookup and
  fraud checks.
- **The wallet-only exceptions** are the routes that bind a lease or a position
  to a payer address, because there is no address to bind to without a wallet:
  buying, renewing, listing and releasing **phone numbers** (the gateway answers
  those with a raw `402` on a key), and **Polymarket trading**, which ClawRouter
  signs locally with the wallet key. Phone lookups, fraud checks and outbound
  voice calls are fine on a key; only owning a number is not.
- **`maxCostPerRun` and `/exclude` still apply**, along with the router's own
  budget filter — they live in the router, not the signer. **`clawrouter policy`
  limits do not**: they are enforced in the x402 pre-sign hook, and nothing is
  signed here. Your account balance is the cap instead, and ClawRouter warns at
  startup if you have one of those limits configured.

---

## Screenshots

<table>
<tr>
<td width="50%" align="center">
<strong>Smart Routing in Action</strong><br><br>
<img src="docs/clawrouter-savings.png" alt="ClawRouter savings" width="400">
</td>
<td width="50%" align="center">
<strong>Telegram Integration</strong><br><br>
<img src="assets/telegram-demo.png" alt="Telegram demo" width="400">
</td>
</tr>
</table>

---

## Configuration

For basic usage, no configuration needed. For advanced options:

| Variable                    | Default                               | Description                                                                                                                 |
| --------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `BLOCKRUN_API_KEY`          | unset                                 | BlockRun API key (`brk_live_…`). Set it and ClawRouter pays from account credit via `api.blockrun.ai` instead of the wallet |
| `BLOCKRUN_WALLET_KEY`       | auto-generated                        | Your wallet private key                                                                                                     |
| `BLOCKRUN_PROXY_PORT`       | `8402`                                | Local proxy port                                                                                                            |
| `CLAWROUTER_DISABLED`       | `false`                               | Disable smart routing                                                                                                       |
| `CLAWROUTER_DEBUG_HEADERS`  | `on`                                  | Set to `off` to suppress `x-clawrouter-*` debug response headers                                                            |
| `CLAWROUTER_SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | Solana RPC endpoint                                                                                                         |

**Full reference:** [docs/configuration.md](docs/configuration.md)

### Model Exclusion

Block specific models from being routed to. Useful if a model doesn't follow your agent instructions or you want to control costs.

```bash
/exclude add free/nemotron-3.5-lightning   # Block a free model (e.g. not for your workload)
/exclude add grok-4                # Aliases work — blocks all grok-4 variants
/exclude add gpt-5.4               # Skip expensive models
/exclude                           # Show current exclusions
/exclude remove grok-4             # Unblock a model
/exclude clear                     # Remove all exclusions
```

Exclusions persist across restarts (`~/.openclaw/blockrun/exclude-models.json`). If all models in a tier are excluded, the safety net ignores the filter so routing never breaks.

---

## Troubleshooting

**When things go wrong, run the doctor:**

```bash
npx @blockrun/clawrouter doctor
```

This collects diagnostics and sends them to Claude Sonnet for AI-powered analysis:

```
🩺 BlockRun Doctor v0.12.24

System
  ✓ OS: darwin arm64
  ✓ Node: v22.14.0

Wallet
  ✓ Address: 0x1234...abcd
  ✓ Balance: $12.50

Network
  ✓ BlockRun API: reachable (142ms)
  ✗ Local proxy: not running on :8402

📤 Sending to Claude Sonnet 4.6 (~$0.003)...

🤖 AI Analysis:
The local proxy isn't running. Run `openclaw gateway restart` to fix.
```

**Use Opus for complex issues:**

```bash
npx @blockrun/clawrouter doctor opus
```

**Ask a specific question:**

```bash
npx @blockrun/clawrouter doctor "why is my request failing?"
npx @blockrun/clawrouter doctor opus "深度分析我的配置"
```

**Cost:** Sonnet ~$0.003 (default) | Opus ~$0.01

---

## Development

```bash
git clone https://github.com/BlockRunAI/ClawRouter.git
cd ClawRouter
npm install
npm run build
npm test
```

---

## Support

| Channel               | Link                                                                             |
| --------------------- | -------------------------------------------------------------------------------- |
| 🔑 Sign up / API keys | [user.blockrun.ai](https://user.blockrun.ai)                                     |
| 💳 Add credit         | [user.blockrun.ai/dashboard/credits](https://user.blockrun.ai/dashboard/credits) |
| 📅 Schedule Demo      | [calendly.com/vickyfu9/30min](https://calendly.com/vickyfu9/30min)               |
| 💬 Community Telegram | [t.me/blockrunAI](https://t.me/blockrunAI)                                       |
| 🐦 X / Twitter        | [x.com/blockrunai](https://x.com/blockrunai)                                     |
| 📱 Founder Telegram   | [@bc1max](https://t.me/bc1max)                                                   |
| ✉️ Email              | vicky@blockrun.ai                                                                |

---

## From the BlockRun Ecosystem

<table>
<tr>
<td width="50%">

### ⚡ ClawRouter

**The LLM router built for autonomous agents**

You're here. <!-- br:models.chatVisible -->76<!-- /br:models.chatVisible --> models, local smart routing, and two ways to pay — a credit-card-funded API key, or x402 USDC from a wallet, which is what lets an agent operate independently.

`curl -fsSL https://blockrun.ai/ClawRouter-update | bash`

</td>
<td width="50%">

### 🤖 [BRCC](https://github.com/BlockRunAI/brcc)

**BlockRun for Claude Code**

Run Claude Code with <!-- br:models.chatVisible -->76<!-- /br:models.chatVisible --> models, no rate limits, no Anthropic account, no phone verification. Pay per request with USDC — your wallet is your identity.

`curl -fsSL https://blockrun.ai/brcc-install | bash`

</td>
</tr>
<tr>
<td width="50%">

### 🐍 [ClawRouter-Hermes](https://github.com/BlockRunAI/ClawRouter-Hermes)

**ClawRouter for NousResearch Hermes**

Python plugin that wraps the ClawRouter proxy for `hermes-agent`. Same <!-- br:models.chatVisible -->76<!-- /br:models.chatVisible --> models, same x402 USDC payments on Solana & Base, native Hermes ergonomics.

`pip install hermes-plugin-clawrouter`

</td>
<td width="50%">

<!-- next ecosystem entry goes here -->

</td>
</tr>
</table>

---

## More Resources

| Resource                                               | Description                                                             |
| ------------------------------------------------------ | ----------------------------------------------------------------------- |
| [Documentation](https://blockrun.ai/docs)              | Full docs                                                               |
| [Model Pricing](https://blockrun.ai/models)            | All models & prices                                                     |
| [Image Generation & Editing](docs/image-generation.md) | API examples, <!-- br:models.image -->9<!-- /br:models.image --> models |
| [Routing Profiles](docs/routing-profiles.md)           | ECO/AUTO/PREMIUM/AGENTIC tiers, fallback chains, ranking weights        |
| [Architecture](docs/architecture.md)                   | Technical deep dive                                                     |
| [Configuration](docs/configuration.md)                 | Environment variables                                                   |
| [Troubleshooting](docs/troubleshooting.md)             | Common issues                                                           |

### Blog

| Article                                                                                            | Topic                                                   |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| [9 Free AI Models, Zero Cost](docs/9-free-ai-models-zero-cost-blockrun.md)                         | How BlockRun gives developers top-tier LLMs for nothing |
| [ClawRouter Cuts LLM API Costs 500×](docs/clawrouter-cuts-llm-api-costs-500x.md)                   | Deep dive into cost savings                             |
| [ClawRouter vs OpenRouter](docs/clawrouter-vs-openrouter-llm-routing-comparison.md)                | Head-to-head comparison                                 |
| [Smart LLM Router: 14-Dimension Classifier](docs/smart-llm-router-14-dimension-classifier.md)      | How the routing engine works                            |
| [LLM Router Benchmark: 46 Models, Sub-1ms](docs/llm-router-benchmark-46-models-sub-1ms-routing.md) | Performance benchmarks                                  |
| [Anthropic Cost Savings](docs/anthropic-cost-savings.md)                                           | Reducing Claude API spend                               |

---

## Frequently Asked Questions

### What is BlockRun?

BlockRun lets agents pay for the outcome — every LLM, tool and data source, best value per dollar. One endpoint and one balance covering <!-- br:models.chatVisible -->76<!-- /br:models.chatVisible --> chat models plus image, video, music and speech generation, search, market data and multi-chain RPC, billed per call with USDC over [x402](https://x402.org) or a credit-card-funded API key — no seat, no subscription, no minimum. ClawRouter is the open-source local router agents use to reach it.

### What is ClawRouter?

ClawRouter is an open-source (MIT licensed) smart LLM router built for autonomous AI agents. It analyzes each request across <!-- br:clawrouter.dimensions -->15<!-- /br:clawrouter.dimensions --> dimensions and routes to the cheapest capable model in under 1ms, entirely locally — no external API calls needed for routing decisions.

### How much can ClawRouter save on LLM costs?

On the `auto` profile ClawRouter costs <!-- br:savings.autoVsBaselinePct -->84<!-- /br:savings.autoVsBaselinePct -->% less than pinning Claude Opus 5 for every request, and <!-- br:savings.ecoVsBaselinePct -->98<!-- /br:savings.ecoVsBaselinePct -->% less on `eco`. That is computed from a published workload mix rather than estimated — see [savings-mix.json](https://github.com/BlockRunAI/blockrun/blob/main/src/brand/savings-mix.json) for the baseline and assumptions. Actual savings depend on your workload — simple queries are routed to free models ($0/request), while complex tasks get premium models.

### How does ClawRouter compare to OpenRouter?

ClawRouter is open source and runs locally. It supports wallet-based authentication with USDC per-request payments — which OpenRouter cannot do, and which is what lets an agent pay for itself with no account at all — _and_ the ordinary path of an API key funded by credit card at [user.blockrun.ai](https://user.blockrun.ai). OpenRouter only offers the second. ClawRouter also features smart routing — it automatically picks the best model for each request, while OpenRouter requires manual model selection.

### How does ClawRouter compare to LiteLLM?

Both are open source and run locally. But ClawRouter adds smart routing (automatic model selection) and its own billing — a credit-card-funded API key, or a wallet paying USDC per request. LiteLLM has no billing of its own: you bring your own provider API keys and manually choose models.

### What agents does ClawRouter work with?

ClawRouter works with any tool that makes OpenAI-compatible API calls — point it at `http://localhost:8402`. This includes continue.dev, Cursor, VS Code extensions, ElizaOS, and custom agents. It also integrates as a plugin with [OpenClaw](https://openclaw.ai) (an AI coding agent), which enables additional features like slash commands and usage reports.

### Do I need a crypto wallet to use ClawRouter?

No. A wallet is the default because it is what lets an _agent_ pay for itself,
but you can sign up at **[user.blockrun.ai](https://user.blockrun.ai)**, top up
with a credit card, mint an API key and run `clawrouter login brk_live_…`. Calls
then go to `api.blockrun.ai` on a bearer token and bill your account credit — no
crypto, no gas, no seed phrase. And the <!-- br:models.free -->7<!-- /br:models.free --> free models need neither: no
wallet, no key, no signup. See [Paying with a credit card](#paying-with-a-credit-card-api-key).

### Is ClawRouter free?

ClawRouter itself is free and MIT licensed. You pay only for the LLM API calls routed through it — and several open-weight models (`nemotron-3.5-lightning`, `nemotron-3-nano-30b`, `laguna-xs-2.1`, `north-mini-code`, `nemotron-3-nano-omni-30b-a3b-reasoning`, `nemotron-3-ultra-550b`, `llama-3.2-11b-vision`) are completely free (text only). Use `/model free` to smart-route across them, or pick any by name.

---

<div align="center">

**MIT License** · [BlockRun](https://blockrun.ai) — Agent-native AI infrastructure

⭐ If ClawRouter powers your agents, consider starring the repo!

</div>
