# ClawRouter API Reference

Complete API documentation for ClawRouter endpoints.

## Base URL

```
http://localhost:8402
```

## Authentication

All requests require an `Authorization` header with a bearer token:

```
Authorization: Bearer YOUR_API_KEY
```

## Endpoints

### POST /v1/chat/completions

OpenAI-compatible chat completions endpoint with intelligent routing.

**Request:**

```bash
curl http://localhost:8402/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-key" \
  -d '{
    "model": "auto",
    "messages": [
      {"role": "user", "content": "Explain quantum computing"}
    ],
    "temperature": 0.7,
    "max_tokens": 1000
  }'
```

**Parameters:**

- `model` (string, required) - `auto` for intelligent domain+difficulty routing, or a specific model name for direct passthrough
- `messages` (array, required) - Array of message objects with `role` and `content`
- `temperature` (number, optional) - Sampling temperature (0.0-2.0)
- `max_tokens` (number, optional) - Maximum tokens to generate
- `stream` (boolean, optional) - Enable streaming responses
- `session_id` (string, optional) - Session ID for conversation persistence

**Response:**

```json
{
  "id": "chatcmpl-123",
  "object": "chat.completion",
  "created": 1677652288,
  "model": "anthropic/claude-3-5-sonnet-20241022",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Quantum computing is..."
    },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 50,
    "total_tokens": 60
  },
  "routing": {
    "tier": "COMPLEX",
    "domain": "stem",
    "score": 0.72
  }
}
```

### GET /health

Health check endpoint.

**Request:**

```bash
curl http://localhost:8402/health
```

**Response:**

```json
{
  "status": "ok",
  "uptime": 3600,
  "version": "1.0.0"
}
```

### GET /session/:sessionId

Retrieve session information.

**Request:**

```bash
curl http://localhost:8402/session/sess_abc123 \
  -H "Authorization: Bearer your-key"
```

**Response:**

```json
{
  "sessionId": "sess_abc123",
  "tier": "COMPLEX",
  "messageCount": 5,
  "createdAt": "2026-03-09T20:00:00Z",
  "lastAccessedAt": "2026-03-09T21:00:00Z",
  "failureCount": 0
}
```

### DELETE /session/:sessionId

Delete a session.

**Request:**

```bash
curl -X DELETE http://localhost:8402/session/sess_abc123 \
  -H "Authorization: Bearer your-key"
```

**Response:**

```json
{
  "success": true,
  "sessionId": "sess_abc123"
}
```

### GET /metrics

Retrieve proxy metrics.

**Request:**

```bash
curl http://localhost:8402/metrics \
  -H "Authorization: Bearer your-key"
```

**Response:**

```json
{
  "requests": {
    "total": 1000,
    "byTier": {
      "SIMPLE": 300,
      "MEDIUM": 400,
      "COMPLEX": 250,
      "REASONING": 50
    }
  },
  "cache": {
    "hits": 150,
    "misses": 850,
    "hitRate": 0.15
  },
  "sessions": {
    "active": 25,
    "total": 100
  }
}
```

## Error Responses

All errors follow OpenAI format:

```json
{
  "error": {
    "message": "Invalid API key",
    "type": "invalid_request_error",
    "code": "invalid_api_key"
  }
}
```

**Common Error Codes:**

- `400` - Bad Request (invalid parameters)
- `401` - Unauthorized (missing or invalid API key)
- `429` - Too Many Requests (rate limit exceeded)
- `500` - Internal Server Error
- `502` - Bad Gateway (upstream error)
- `503` - Service Unavailable

## Streaming

Enable streaming with `"stream": true`:

```bash
curl http://localhost:8402/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-key" \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

Responses are sent as Server-Sent Events (SSE):

```
data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1677652288,"model":"gpt-3.5-turbo","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: [DONE]
```

## Session Management

Sessions persist conversation context and tier escalation:

1. Include `session_id` in requests to maintain context
2. Sessions automatically escalate on failures (three-strike rule)
3. Sessions never downgrade when `neverDowngrade` is enabled
4. Sessions expire after configured TTL (default: 120 minutes)

## Routing

Set `"model": "auto"` to enable intelligent routing. The scorer classifies each request by knowledge domain (`stem`, `humanities`, `social_sciences`, `other`) and difficulty tier (`SIMPLE`, `MEDIUM`, `COMPLEX`, `REASONING`), then the proxy selects the best model from the matching domain profile in `config.yaml`.

Or specify an exact model to bypass routing:

```json
{
  "model": "anthropic/claude-sonnet-4.6",
  "messages": [...]
}
```
