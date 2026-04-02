---
name: tx402ai
description: Agent-native LLM inference via x402 micropayments. 20+ EU-hosted models (DeepSeek, Qwen, Llama, GLM, Mixtral) with USDC on Base. No API keys, no accounts — wallet is auth. OpenAI-compatible drop-in replacement. GDPR-compliant, zero data retention.
homepage: https://tx402.ai
metadata: { "openclaw": { "emoji": "⚡", "tags": ["llm", "inference", "x402", "eu", "gdpr"] } }
---

# tx402.ai — Agent-Native LLM Gateway

x402 payment gateway for EU-sovereign LLM inference. AI agents pay per-request with USDC on Base. No API keys, no accounts, no KYC. Wallet = authentication.

## Quick Start

```typescript
import { wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";

const paidFetch = wrapFetchWithPayment(fetch, signer, [new ExactEvmScheme()]);

const res = await paidFetch("https://tx402.ai/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "deepseek/deepseek-v3.2",
    messages: [{ role: "user", content: "Hello from an autonomous agent" }],
  }),
});
```

## Available Models (20+)

| Model | Type | Est. Cost/Request |
|-------|------|-------------------|
| DeepSeek V3.2 | Chat | ~$0.0003 |
| DeepSeek R1 | Reasoning | ~$0.001 |
| Qwen3-235B | Chat | ~$0.0003 |
| Llama 4 Maverick | Chat | ~$0.0003 |
| GLM-5 | Chat | ~$0.001 |
| Mixtral | Chat | ~$0.0003 |
| GPT-OSS-120B | Chat | ~$0.001 |

Full model list with live pricing: https://tx402.ai/v1/models

## Model Aliases

Use short names for convenience: `deepseek`, `deepseek-r1`, `qwen`, `llama`, `llama-70b`, `glm`, `glm-5`, `minimax`, `kimi`, `mixtral`, `gpt-oss`

## Features

- **x402 protocol** — USDC micropayments on Base
- **OpenAI-compatible** — same API format, drop-in replacement
- **SSE streaming** — real-time token streaming
- **Dynamic pricing** — live from Tensorix, auto-refreshed every 6h
- **EU-sovereign** — GDPR-compliant, zero data retention
- **Agent discovery** — llms.txt, ai-plugin.json, .well-known/x402, OpenAPI 3.1

## Endpoints

- `POST /v1/chat/completions` — chat (x402 payment required)
- `POST /v1/completions` — text completions (x402 payment required)
- `POST /v1/embeddings` — embeddings (x402 payment required)
- `GET /v1/models` — model list with pricing (free)
- `GET /openapi.json` — OpenAPI 3.1 spec (free)
- `GET /llms.txt` — agent discovery file (free)

## How Payment Works

1. Agent sends request without `X-PAYMENT` header → gets 402 with pricing + nonce
2. Agent signs USDC payment using `@x402/fetch`
3. Agent retries with `X-PAYMENT` header → gets LLM response
4. Total round-trip: ~2 seconds including payment verification

## Links

- Website: https://tx402.ai
- Models: https://tx402.ai/v1/models
- Health: https://tx402.ai/health
- OpenAPI: https://tx402.ai/openapi.json
- Protocol: https://x402.org
