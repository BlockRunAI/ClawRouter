# ClawRouter

OpenAI-compatible LLM routing proxy that intelligently scores request complexity and routes to optimal models.

## Features

- **14-Dimension Complexity Scorer** - Analyzes requests across multiple dimensions (length, code presence, reasoning depth, etc.)
- **4-Tier Routing System** - SIMPLE, MEDIUM, COMPLEX, REASONING tiers with automatic model selection
- **3 Routing Profiles** - Auto (balanced), Eco (cost-optimized), Premium (performance-focused)
- **Session Persistence** - Maintains conversation context with SQLite-backed session tracking
- **Smart Compression** - Multi-layer compression pipeline (deduplication, whitespace, JSON compaction)
- **Response Caching** - LRU cache with configurable TTL for repeated queries
- **Shadow Analysis** - Parallel request logging for A/B testing and model comparison
- **OpenAI API Compatible** - Drop-in replacement for OpenAI API endpoints
- **Multi-Upstream Support** - Routes to OpenRouter, Ollama, or custom upstreams
- **Three-Strike Escalation** - Automatically escalates to higher tiers on repeated failures
- **Never Downgrade** - Optional session-based tier locking to prevent quality regression
- **Environment Override** - Full configuration via environment variables
- **Structured Logging** - File-based logging with rotation support
- **Health Monitoring** - Built-in health check and metrics endpoints

## Quick Start

```bash
# Install dependencies
npm install

# Configure
cp .env.example .env
# Edit .env and add your OPENROUTER_API_KEY

# Build
npm run build

# Start
npm start
```

Server runs at `http://localhost:8402`

## Configuration

Configuration is loaded from `config.yaml` with environment variable overrides. See `.env.example` for all available variables.

### Key Settings

- **Port/Host** - Server binding configuration
- **Upstreams** - OpenRouter and Ollama endpoints
- **Routing Profiles** - Model selection per tier
- **Session Management** - TTL, downgrade protection, escalation
- **Compression** - Multi-layer prompt optimization
- **Cache** - Response caching for efficiency
- **Logging** - File-based structured logs

## API Reference

### Chat Completions

```bash
curl http://localhost:8402/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-key" \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### Health Check

```bash
curl http://localhost:8402/health
```

### Session Info

```bash
curl http://localhost:8402/session/SESSION_ID
```

See `API.md` for complete endpoint documentation.

## Routing

### Complexity Scoring

Requests are scored across 14 dimensions:
- Message length and count
- Code block presence and complexity
- Technical terminology density
- Reasoning indicators (analysis, comparison, evaluation)
- Multi-step task detection
- Context window requirements
- Structured output needs
- Domain expertise requirements
- Ambiguity and clarification needs
- Creative vs analytical balance
- Time sensitivity
- Error handling complexity
- Multi-modal content
- Conversation depth

### Tier Thresholds

- **SIMPLE** (0.0-0.3) - Basic queries, greetings, simple lookups
- **MEDIUM** (0.3-0.6) - Standard questions, moderate complexity
- **COMPLEX** (0.6-0.8) - Advanced analysis, code generation, multi-step reasoning
- **REASONING** (0.8+) - Deep reasoning, complex problem-solving, research

### Profiles

- **auto** - Balanced performance and cost (default)
- **eco** - Cost-optimized with budget models
- **premium** - Performance-focused with top-tier models

## Shadow Analysis

Shadow mode logs requests to a SQLite database for offline analysis:

```bash
npm run shadow
```

Analyzes routing decisions, model performance, and cost optimization opportunities.

## Architecture

See `ARCHITECTURE.md` for detailed module breakdown.

## Systemd Service

Install as a systemd user service:

```bash
./setup.sh
systemctl --user enable clawrouter
systemctl --user start clawrouter
```

## License

MIT
