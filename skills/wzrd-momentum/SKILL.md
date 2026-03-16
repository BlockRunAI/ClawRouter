---
name: wzrd-momentum
description: Use when routing model selection, evaluating model adoption trends, or deciding which AI model to prioritize for a task based on real-world usage momentum
---

# WZRD Momentum Signal

Real-time adoption velocity for AI models across HuggingFace, GitHub, and OpenRouter. Credibility-weighted — prioritizes integration signals (dependents, routing share) over vanity metrics (downloads, stars).

## When to Use

- Choosing between models for a task and wanting the one with rising adoption
- Evaluating whether a model is gaining or losing real-world traction
- Routing decisions where adoption momentum is a quality proxy
- Checking if a model's popularity is real (integration) vs inflated (bot downloads)

## API

Base URL: `https://api.twzrd.xyz`

### Get momentum rankings (no auth required)

```bash
curl https://api.twzrd.xyz/v1/signals/momentum
```

Returns models ranked by credibility-weighted velocity:
```json
{
  "models": [
    {
      "channel_id": "Qwen/Qwen3.5-9B",
      "platform": "huggingface",
      "velocity_ema": 1964599,
      "multiplier_bps": 46367,
      "trend": "rising",
      "confidence": "high"
    }
  ]
}
```

### Get leaderboard by platform

```bash
# All platforms
curl https://api.twzrd.xyz/v1/leaderboard?limit=20

# Specific platform
curl https://api.twzrd.xyz/v1/leaderboard?platform=openrouter&limit=10
curl https://api.twzrd.xyz/v1/leaderboard?platform=github&limit=10
```

### Get single market detail

```bash
curl https://api.twzrd.xyz/v1/markets/14
```

## Interpreting the Signal

- **multiplier_bps**: 10,000 = 1.0x (baseline). 50,000 = 5.0x (max). Higher = more real adoption.
- **velocity_ema**: Exponentially smoothed velocity (6h halflife). Higher = faster growing.
- **platform**: Where the signal comes from. OpenRouter = inference spend (hardest to fake). GitHub = integration (dependents, commits). HuggingFace = downloads (easiest to fake, lowest weight).

## Credibility Weighting

Signals are weighted by cost-to-fake, following OpenSSF Criticality Score methodology:

| Signal | Weight | Why |
|--------|--------|-----|
| OpenRouter routing share | Highest | Real inference spend |
| GitHub dependents | High | Requires real projects |
| GitHub releases | High | Shipping is truth |
| PyPI installs | Medium | Integration commitment |
| HF derivatives/spaces | Medium | Real adaptation effort |
| HF downloads | Low | Bot-inflatable |
| GitHub stars | Low | Vanity metric |

A model with high dependents but low downloads scores HIGHER than one with high downloads but no integration.

## Use in Routing

When selecting between models:

1. Fetch momentum for candidate models
2. Prefer models with `trend: "rising"` and `confidence: "high"`
3. Use `multiplier_bps` as a tiebreaker — higher = more real adoption
4. Check platform breakdown: OpenRouter signal is most reliable for inference quality

## On-Chain Verification

All velocity data is published on-chain via Solana merkle roots (every 5 minutes) and Switchboard oracle feeds. Any program can verify the signal independently.

- Program: `GnGzNdsQMxMpJfMeqnkGPsvHm8kwaDidiKjNU2dCVZop`
- Switchboard feeds: 5 on mainnet (pull model)
- SDK: `npm install @wzrd_sol/sdk`

## Source

- API docs: https://twzrd.xyz/openapi.json
- MCP server: https://app.twzrd.xyz/api/mcp
- Source: https://github.com/twzrd-sol/attention-oracle-program
