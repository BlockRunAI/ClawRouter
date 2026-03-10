# ClawRouter Architecture

Module-by-module breakdown of ClawRouter's architecture.

## Overview

ClawRouter is a TypeScript-based proxy server that sits between clients and LLM providers, intelligently routing requests based on complexity analysis.

```
Client → ClawRouter → [Scorer → Router → Upstream] → LLM Provider
                    ↓
                [Cache, Session, Compression]
```

## Core Modules

### index.ts

Entry point that initializes the HTTP server and wires up all components.

**Responsibilities:**
- Load configuration
- Initialize database and session manager
- Set up HTTP routes
- Start server

**Key Routes:**
- `POST /v1/chat/completions` - Main chat endpoint
- `GET /health` - Health check
- `GET /session/:id` - Session info
- `DELETE /session/:id` - Delete session
- `GET /metrics` - Proxy metrics

### config.ts

Configuration loader with environment variable override support.

**Features:**
- YAML config file parsing
- Environment variable substitution
- Type-safe configuration schema
- Default value handling

**Configuration Sections:**
- Server (port, host)
- Upstreams (OpenRouter, Ollama)
- Routing (profiles, tiers, thresholds)
- Session (TTL, escalation)
- Cache (size, TTL)
- Compression (layers)
- Logging (directory, rotation)

### proxy.ts

Main request handler that orchestrates the routing pipeline.

**Flow:**
1. Parse incoming request
2. Extract/create session ID
3. Load session state
4. Apply compression to messages
5. Score request complexity
6. Select model based on tier and profile
7. Check cache
8. Forward to upstream
9. Update session
10. Return response

**Features:**
- OpenAI API compatibility
- Streaming support
- Error handling and retry logic
- Three-strike escalation
- Never-downgrade enforcement

## Routing System

### router/scorer.ts

14-dimension complexity scorer that analyzes requests.

**Dimensions:**
1. **Message Length** - Total character count
2. **Message Count** - Conversation depth
3. **Code Blocks** - Presence and complexity
4. **Technical Terms** - Domain-specific vocabulary
5. **Reasoning Keywords** - Analysis, comparison, evaluation
6. **Multi-step Tasks** - Sequential operations
7. **Context Window** - Token requirements
8. **Structured Output** - JSON, tables, lists
9. **Domain Expertise** - Specialized knowledge
10. **Ambiguity** - Clarification needs
11. **Creative vs Analytical** - Task type balance
12. **Time Sensitivity** - Urgency indicators
13. **Error Handling** - Debugging complexity
14. **Multi-modal** - Image/file references

**Output:** Normalized score (0.0-1.0)

### router/selector.ts

Model selection based on tier and profile.

**Tiers:**
- `SIMPLE` (0.0-0.3) - Fast, cheap models
- `MEDIUM` (0.3-0.6) - Balanced models
- `COMPLEX` (0.6-0.8) - Advanced models
- `REASONING` (0.8+) - Top-tier models

**Profiles:**
- `auto` - Balanced cost/performance
- `eco` - Minimize cost
- `premium` - Maximize quality

### router/config.ts

Routing configuration and tier definitions.

## Session Management

### session.ts

SQLite-backed session persistence.

**Features:**
- Session creation and retrieval
- Tier tracking and escalation
- Failure counting (three-strike rule)
- Never-downgrade enforcement
- TTL-based expiration
- Message history tracking

**Schema:**
```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  tier TEXT,
  message_count INTEGER,
  failure_count INTEGER,
  created_at INTEGER,
  last_accessed_at INTEGER
)
```

## Compression

### compression/pipeline.ts

Multi-layer compression orchestrator.

**Layers:**
1. **Deduplication** - Remove repeated messages
2. **Whitespace** - Normalize spacing
3. **JSON Compact** - Minify JSON blocks

### compression/dedup.ts

Removes duplicate consecutive messages.

### compression/whitespace.ts

Normalizes whitespace and removes excess newlines.

### compression/json-compact.ts

Detects and minifies JSON code blocks.

## Caching

### cache.ts

LRU cache for response reuse.

**Features:**
- Content-based cache keys (hash of messages)
- TTL expiration
- Size-based eviction
- Hit/miss metrics

**Cache Key:** `SHA256(JSON.stringify(messages))`

## Upstream Integration

### upstream.ts

HTTP client for LLM provider communication.

**Supported Upstreams:**
- OpenRouter (primary)
- Ollama (local)
- Custom endpoints

**Features:**
- Request forwarding
- Response streaming
- Error handling
- Timeout management
- Header passthrough

## Shadow Analysis

### shadow/db.ts

SQLite database for request logging.

**Schema:**
```sql
CREATE TABLE requests (
  id TEXT PRIMARY KEY,
  timestamp INTEGER,
  messages TEXT,
  tier TEXT,
  model TEXT,
  score REAL,
  tokens_prompt INTEGER,
  tokens_completion INTEGER,
  cost REAL
)
```

### shadow/parser.ts

Log file parser for shadow analysis.

**Extracts:**
- Request metadata
- Routing decisions
- Token usage
- Cost estimates

### shadow/runner.ts

Offline analysis tool.

**Reports:**
- Tier distribution
- Model usage
- Cost breakdown
- Optimization opportunities
- Escalation patterns

### shadow/pricing.ts

Model pricing database for cost calculation.

## Logging

### logger.ts

Structured file-based logging.

**Features:**
- JSON log format
- Log rotation
- Configurable directory
- Multiple log levels (debug, info, warn, error)

**Log Entry:**
```json
{
  "timestamp": "2026-03-09T21:00:00Z",
  "level": "info",
  "message": "Request routed",
  "tier": "COMPLEX",
  "model": "claude-3-5-sonnet",
  "score": 0.72
}
```

## Data Flow

### Request Flow

```
1. Client Request
   ↓
2. Parse & Validate
   ↓
3. Session Lookup/Create
   ↓
4. Compression Pipeline
   ↓
5. Complexity Scoring
   ↓
6. Tier Selection
   ↓
7. Model Selection (Profile)
   ↓
8. Cache Check
   ↓
9. Upstream Request
   ↓
10. Cache Store
   ↓
11. Session Update
   ↓
12. Response to Client
```

### Session Escalation Flow

```
Request → Score → Tier
                   ↓
         Session Tier Check
                   ↓
         Never Downgrade?
         ↓           ↓
        Yes         No
         ↓           ↓
    Max(Current,   Use Scored
        Scored)      Tier
         ↓           ↓
    Failure Count
         ↓
    3+ Failures?
         ↓
    Escalate Tier
```

## Configuration Precedence

1. Environment variables (highest)
2. config.yaml
3. Built-in defaults (lowest)

## Error Handling

- Upstream failures trigger three-strike escalation
- Invalid requests return OpenAI-compatible errors
- Session errors fall back to stateless mode
- Cache errors are logged but don't block requests

## Performance Optimizations

- LRU cache reduces redundant API calls
- Compression reduces token usage
- Session persistence enables context reuse
- SQLite for fast local storage
- Streaming support for real-time responses
