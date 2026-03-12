# ClawRouter

OpenAI-compatible LLM routing proxy that scores request complexity and routes to the optimal model to save costs.

```
Client → Proxy (TypeScript) → Scorer (Python/ML) → selects model → LLM Provider
```

## Architecture

ClawRouter is split into two components:

- **`proxy/`** — TypeScript HTTP proxy. Handles OpenAI API compatibility, streaming, sessions, caching, compression, and upstream routing. Calls the scorer to decide which model to use.
- **`scorer/`** — Python FastAPI service. Uses ML (ridge regression on embeddings) to classify requests by complexity tier and knowledge domain. Runs on a local Ollama embedding model.

The proxy sends each request's text to the scorer, gets back a tier (SIMPLE/MEDIUM/COMPLEX/REASONING) and domain, then routes to the appropriate model.

## Quick Start

### 1. Prerequisites

- [Ollama](https://ollama.ai) running locally with an embedding model
- Node.js 18+ and Python 3.10+
- [uv](https://docs.astral.sh/uv/) (recommended for Python)

```bash
# Pull the default embedding model
ollama pull qwen3-embedding:4b
```

### 2. Start the scorer

```bash
cd scorer
uv sync
uv run server.py
# Runs on http://localhost:8403
```

### 3. Start the proxy

```bash
cd proxy
npm install
cp .env.example .env  # Edit with your OpenRouter API key
npm run build
npm start
# Runs on http://localhost:8402
```

### 4. Use it

Point any OpenAI-compatible client at `http://localhost:8402`. Set the model to `auto`, `eco`, or `premium` to enable routing:

```bash
curl http://localhost:8402/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "What is 2+2?"}]
  }'
```

Simple questions route to cheap models. Complex ones route to powerful models. You save money.

## Using a Different Embedding Model

The scorer ships with pre-trained weights for `qwen3-embedding:4b` (2560-dim). To use a different model:

```bash
# 1. Pull your preferred model
ollama pull nomic-embed-text

# 2. Retrain weights (requires ~30 min for 14k MMLU questions)
cd scorer
pip install datasets  # one-time, for MMLU data
EMBED_MODEL=nomic-embed-text python retrain.py

# 3. Update scorer config and restart
EMBED_MODEL=nomic-embed-text uv run server.py
```

The retraining script downloads MMLU data, embeds all training questions with your model, trains ridge regression classifiers, and exports new `weights.json`. The scorer validates on startup that the weights match the configured embedding model.

## Configuration

### Scorer (`scorer/`)

| Env var | Default | Description |
|---|---|---|
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server URL |
| `WEIGHTS_PATH` | `./weights.json` | Path to trained weights |
| `SCORER_PORT` | `8403` | Scorer HTTP port |

### Proxy (`proxy/`)

| Env var | Default | Description |
|---|---|---|
| `SCORER_URL` | `http://localhost:8403` | Scorer service URL |
| `OPENROUTER_API_KEY` | — | OpenRouter API key (required) |
| `CLAW_PROXY_PORT` | `8402` | Proxy HTTP port |

See `proxy/.env.example` for the full list.

### Model Routing

Edit `proxy/config.yaml` to configure which models handle each tier:

```yaml
routing:
  profiles:
    auto:
      SIMPLE: google/gemini-flash-1.5          # cheap, fast
      MEDIUM: anthropic/claude-3-5-haiku-20241022
      COMPLEX: anthropic/claude-3-5-sonnet-20241022
      REASONING: anthropic/claude-3-opus-20240229  # expensive, powerful
```

## How the Scorer Works

1. The request text is sent to Ollama to get an embedding vector
2. A ridge regression classifier predicts the MMLU subject (57 categories)
3. The predicted subject maps to a domain (stem/humanities/social_sciences/other)
4. For tier: if the subject classifier is confident (margin > 0.28), the subject's tier is used; otherwise a quadratic tier classifier decides
5. High-precision keyword patterns can override the ML prediction for known patterns
6. Domain overrides apply for specific detected subjects

Trained on 14,042 MMLU questions. Achieves 95.6% combined accuracy on the validation set.

## License

MIT
