# Shadow Routing Analyzer

Analyzes OpenClaw session logs to compare actual model usage vs. what claw-proxy's router would have selected.

## Usage

```bash
# Build
npm run build

# Run analyzer
npm run shadow
```

## Data Flow

1. **runner.ts** - Scans `~/claw-proxy/logs-sync/` for `.jsonl` files
2. **parser.ts** - Extracts assistant responses and preceding user messages
3. **scorer** - Scores user messages using claw-proxy's 14-dimension algorithm
4. **selector** - Determines which model would have been routed
5. **pricing.ts** - Calculates actual vs. hypothetical costs
6. **db.ts** - Stores results in `~/.claw-proxy/shadow.db`

## Incremental Processing

The analyzer tracks which lines have been processed in each file via the `sync_state` table. Running multiple times only processes new log entries.

## Database Schema

**shadow_routing** - Main analysis results
- Actual model used and token counts
- Routed tier and model (what claw-proxy would pick)
- Cost comparison and savings
- Confidence score

**sync_state** - Tracks processing progress per file

## Log Format

Expects OpenClaw JSONL logs with entries like:
```json
{"type":"message","session_id":"...","message":{"role":"user","content":"..."}}
{"type":"message","session_id":"...","message":{"role":"assistant","model":"...","usage":{...}}}
```
