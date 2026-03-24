# CLAUDE.md — ClawRouter

> Smart LLM router for autonomous AI agents. Routes requests to 44+ models via local proxy, pays per-request with USDC micropayments on Base/Solana through the x402 protocol.
>
> **Version**: 0.12.x | **Updated**: 2026-03-23

## Table of Contents

- [Project Overview](#project-overview)
- [Architecture](#architecture)
- [Key Modules](#key-modules)
- [Development Commands](#development-commands)
- [Code Style & Conventions](#code-style--conventions)
- [Testing](#testing)
- [Payment System Details](#payment-system-details)
- [Router System](#router-system)
- [Important Constraints](#important-constraints)
- [Environment Variables](#environment-variables)
- [Common Tasks](#common-tasks)
- [File Map](#file-map)

## Project Overview

**ClawRouter** (`@blockrun/clawrouter`) is an OpenClaw plugin and standalone CLI that acts as a local HTTP proxy (port 8402) between AI agent frameworks and the BlockRun API. It analyzes each LLM request across 14 weighted scoring dimensions, classifies it into one of four complexity tiers (SIMPLE / MEDIUM / COMPLEX / REASONING), and routes it to the cheapest capable model — achieving up to 92% cost savings vs. using Claude Opus for everything.

Key differentiators:
- **Agent-native**: Wallet signatures replace API keys; USDC micropayments replace credit cards
- **Local routing**: Classification runs in <1ms with zero external API calls
- **Dual-chain**: USDC on Base (EVM) or Solana, derived from a single BIP-39 mnemonic
- **Open source**: MIT licensed, TypeScript strict mode, ESM-only

**Package**: `@blockrun/clawrouter` v0.12.x | **Entry**: `src/index.ts` (plugin), `src/cli.ts` (standalone)

## Architecture

```text
OpenClaw / Agent
    │
    ▼ (OpenAI-compatible /v1/chat/completions)
┌──────────────────────────────────────┐
│  ClawRouter Proxy  (localhost:8402)  │
│                                      │
│  1. Compression  (7-layer pipeline)  │
│  2. Deduplication (request hash)     │
│  3. Smart Router  (14-dim scoring)   │
│     ├── RulesStrategy (<1ms)         │
│     └── LLMClassifier (fallback)     │
│  4. Session Store  (model pinning)   │
│  5. Spend Control  (time windows)    │
│  6. Balance Check (Base/Solana RPC)  │
│  7. x402 Payment  (sign → retry)     │
│  8. Fallback Chain (up to 5 models)  │
│  9. Response Cache + Journal         │
└──────────────────────────────────────┘
    │
    ▼ (x402-signed USDC payment)
BlockRun API  (blockrun.ai/api)
    │
    ▼
OpenAI / Anthropic / Google / xAI / DeepSeek / ...
```

### Core Flow

1. **Request arrives** at `POST /v1/chat/completions` on the local proxy
2. **Compression** (7 layers) reduces payload 15–40%
3. **Router** classifies via `RulesStrategy` (14 weighted dimensions, sigmoid confidence)
4. **Session store** pins model per conversation (prevents mid-task switching)
5. **Spend control** checks per-request / hourly / daily / session limits
6. **Balance monitor** queries USDC balance on Base or Solana (30-second cache, optimistic deduction)
7. **x402 payment**: proxy gets 402 → wallet signs USDC payment → retries with payment header
8. **Fallback**: if primary model fails (429/5xx), tries next in fallback chain (up to 5 attempts)
9. **Response** streams back to agent; logged as JSONL to `~/.openclaw/blockrun/logs/`

### Build & Bundle

- **Bundler**: tsup (ESM output, CJS interop shim via banner)
- **Target**: node20
- **No code splitting** (`splitting: false`) — all deps bundled into dist
- **`noExternal: [/.*/]`** — everything bundled except Node.js builtins

## Key Modules

### Entry Points

| File | Purpose | Key Exports |
|------|---------|-------------|
| `src/index.ts` | OpenClaw plugin definition | `register()`, `activate()` — injects config, starts proxy, registers commands |
| `src/cli.ts` | Standalone CLI (`npx @blockrun/clawrouter`) | `doctor`, `partners`, `report`, `wallet recover`, `chain solana/base` |

### Proxy Core

| File | Purpose |
|------|---------|
| `src/proxy.ts` | HTTP proxy server (~4600 lines). Handles all request routing, x402 payment, SSE streaming, fallback chains, rate-limit tracking, error categorization, image generation/download endpoints, partner API proxying. Exports `startProxy()`, `getProxyPort()`, `ProxyHandle`. |
| `src/provider.ts` | `ProviderPlugin` definition for OpenClaw. Registers "blockrun" as an LLM provider with `auth: []` (proxy handles auth). Exports `blockrunProvider`, `setActiveProxy()`. |

### Router (`src/router/`)

| File | Purpose |
|------|---------|
| `index.ts` | Barrel export. `route()` delegates to `getStrategy("rules")`. Exports all router types and helpers. |
| `types.ts` | Core types: `Tier` (SIMPLE/MEDIUM/COMPLEX/REASONING), `RoutingDecision`, `RouterStrategy` interface, `RoutingConfig`, `ScoringConfig`, `ClassifierConfig`, `OverridesConfig`. |
| `strategy.ts` | `RulesStrategy` implements `RouterStrategy`. Runs rule classification, selects tier configs by profile (auto/eco/premium/agentic), applies overrides (large context → COMPLEX, structured output min tier). Strategy registry via `getStrategy()` / `registerStrategy()`. |
| `rules.ts` | `classifyByRules()` — 14-dimension weighted scoring. Scores token count, code/reasoning/technical/creative/simple keywords, multi-step patterns, question complexity, imperative verbs, constraints, output format, references, negation, domain specificity, agentic task detection. Returns `ScoringResult` with tier, confidence, and dimension breakdown. Sigmoid confidence calibration. |
| `selector.ts` | `selectModel()` maps tier → primary model + fallback chain. `calculateModelCost()` with 5% server margin and $0.001 minimum. `filterByToolCalling()`, `filterByVision()`, `filterByExcludeList()`, `getFallbackChainFiltered()` (context window aware). Baseline model: `anthropic/claude-opus-4.6`. |
| `llm-classifier.ts` | `classifyByLLM()` — fallback for ambiguous requests (~20-30% hit rate). Sends truncated prompt to cheap model (gemini-2.5-flash) for classification. In-memory cache with 1hr TTL. Default: MEDIUM on failure. |
| `config.ts` | `DEFAULT_ROUTING_CONFIG` — all tier configs, scoring weights, keyword lists (multilingual: EN/ZH/JA/RU/DE/ES/PT/KO/AR), dimension weights, tier boundaries, confidence thresholds. |

### Models (`src/models.ts`)

Defines 44+ models as `BLOCKRUN_MODELS[]` with pricing, context windows, capabilities. Key exports:
- `BLOCKRUN_MODELS` — full model registry (inputPrice, outputPrice, contextWindow, maxOutput, reasoning, vision, agentic, toolCalling, deprecated, fallbackModel)
- `MODEL_ALIASES` — shorthand resolution (e.g., `claude` → `anthropic/claude-sonnet-4.6`, `grok` → `xai/grok-3`)
- `resolveModelAlias()` — resolves aliases, strips `blockrun/` prefix, handles `openai/eco` → `eco` for OpenClaw's model picker
- `OPENCLAW_MODELS` — `ModelDefinitionConfig[]` for OpenClaw's model registry
- `supportsToolCalling()`, `supportsVision()`, `isReasoningModel()`, `getModelContextWindow()`

### Payment System

| File | Purpose |
|------|---------|
| `src/wallet.ts` | BIP-39 mnemonic generation + HD key derivation. EVM path: `m/44'/60'/0'/0/0` (secp256k1). Solana path: `m/44'/501'/0'/0'` (SLIP-10 Ed25519). Exports `generateWalletMnemonic()`, `deriveEvmKey()`, `deriveSolanaKeyBytes()`, `deriveAllKeys()`, `getSolanaAddress()`. |
| `src/auth.ts` | Wallet lifecycle: load saved → env var (`BLOCKRUN_WALLET_KEY`) → auto-generate. Persistence at `~/.openclaw/blockrun/wallet.key` (mode 0o600). Mnemonic at `~/.openclaw/blockrun/mnemonic`. Chain selection at `~/.openclaw/blockrun/payment-chain`. Refuses to overwrite existing wallets (prevents silent fund loss). Exports `resolveOrGenerateWalletKey()`, `resolvePaymentChain()`, `savePaymentChain()`, `recoverWalletFromMnemonic()`, `setupSolana()`. |
| `src/balance.ts` | `BalanceMonitor` — checks USDC balance on Base via viem public client. USDC contract: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`. 30s TTL cache, optimistic deduction, zero-balance always re-fetches. Thresholds: low = $1.00, empty = $0.0001. Exports `BalanceMonitor`, `BalanceInfo`, `BALANCE_THRESHOLDS`. |
| `src/solana-balance.ts` | `SolanaBalanceMonitor` — same interface as `BalanceMonitor` but for Solana USDC. Uses `@solana/kit`. RPC from `CLAWROUTER_SOLANA_RPC_URL` or default mainnet. |
| `src/payment-preauth.ts` | `createPayFetchWithPreAuth()` — wraps `@x402/fetch` with payment requirement caching. After first 402, caches requirements per endpoint+model. Subsequent requests pre-sign payment (saves ~200ms). Skipped for Solana (per-tx blockhashes expire). TTL: 1 hour. |
| `src/spend-control.ts` | `SpendControl` — time-windowed spending limits (perRequest, hourly, daily, session). Rolling windows. Persistent storage to `~/.openclaw/blockrun/spending.json`. `FileSpendControlStorage` and `InMemorySpendControlStorage`. Exports `SpendControl`, `CheckResult`, `SpendRecord`. |

### Compression (`src/compression/`)

7-layer pipeline reducing token usage 15–40% while preserving semantic meaning:

| Layer | File | Description |
|-------|------|-------------|
| L1 | `layers/deduplication.ts` | Remove exact duplicate messages |
| L2 | `layers/whitespace.ts` | Normalize excessive whitespace (3+ newlines → 2, 2+ spaces → 1) |
| L3 | `layers/dictionary.ts` | Replace common phrases with short codes ($XX) |
| L4 | `layers/paths.ts` | Shorten repeated file paths to short codes |
| L5 | `layers/json-compact.ts` | Compact JSON in tool calls (remove whitespace) |
| L6 | `layers/observation.ts` | Compress tool result observations (97% reduction on large outputs) |
| L7 | `layers/dynamic-codebook.ts` | Build codebook from actual content (learns repeated strings) |

Default config (`DEFAULT_COMPRESSION_CONFIG`): only L1, L2, L5 enabled (conservative). L3, L4, L6, L7 disabled by default (require model to understand codebook). Codebook prepended to first USER message (not system — Gemini compatibility). `STATIC_CODEBOOK` in `codebook.ts` has ~45 entries from production logs.

Types: `NormalizedMessage`, `CompressionConfig`, `CompressionResult`, `CompressionStats`.

### Partner System (`src/partners/`)

| File | Purpose |
|------|---------|
| `registry.ts` | `PARTNER_SERVICES[]` — defines partner APIs (currently: Twitter/X User Lookup via AttentionVC). `PartnerServiceDefinition` type with id, proxyPath, method, params, pricing. |
| `tools.ts` | `buildPartnerTools()` — converts partner definitions into OpenClaw tool definitions. Each tool's `execute()` routes through the local proxy (x402 handled transparently). |
| `index.ts` | Barrel exports. |

### Supporting Modules

| File | Purpose |
|------|---------|
| `src/session.ts` | `SessionStore` — pins model per session (30 min timeout). Three-strike escalation (3 consecutive similar requests → auto-escalate tier). Cost accumulation for `maxCostPerRun`. `deriveSessionId()` from first user message, `hashRequestContent()` for similarity detection. |
| `src/journal.ts` | `SessionJournal` — extracts key actions from LLM responses ("I created X", "I fixed Y") via regex patterns. Formats for injection as session memory. 100 entries max, 24h TTL. |
| `src/retry.ts` | `fetchWithRetry()` — exponential backoff wrapper. Retries on 429, 502, 503, 504. Respects Retry-After header. `isRetryable()` checks network/timeout errors. |
| `src/response-cache.ts` | `ResponseCache` — LRU cache by request hash (SHA-256 of canonical JSON). TTL: 10 min default. Max 200 entries, 1 MB per item. Heap-based expiration. Stats tracking (hits/misses/evictions). |
| `src/dedup.ts` | `RequestDeduplicator` — prevents double-charging on OpenClaw retries. In-flight request tracking + 30-second completed cache. Strips OpenClaw timestamps for consistent hashing. |
| `src/exclude-models.ts` | Model exclusion persistence (`~/.openclaw/blockrun/exclude-models.json`). `loadExcludeList()`, `addExclusion()`, `removeExclusion()`, `clearExclusions()`. Resolves aliases before persisting. Safety net: if all models in a tier excluded, returns full list. |
| `src/stats.ts` | `getStats()` — reads JSONL log files, aggregates by tier/model/day. `formatStatsAscii()` for terminal display. `clearStats()` deletes log files. |
| `src/report.ts` | `generateReport()` — markdown cost report (daily/weekly/monthly). Wraps `getStats()`. |
| `src/doctor.ts` | `runDoctor()` — collects system/wallet/network/log diagnostics, sends to Claude Sonnet or Opus via x402 for AI-powered analysis. |
| `src/updater.ts` | `checkForUpdates()` — non-blocking npm registry check on startup. Compares semver, prints update hint. |
| `src/logger.ts` | `logUsage()` — appends JSON lines to `~/.openclaw/blockrun/logs/usage-YYYY-MM-DD.jsonl`. Never blocks request flow. |
| `src/errors.ts` | Typed errors: `InsufficientFundsError`, `EmptyWalletError`, `RpcError`. Type guards: `isInsufficientFundsError()`, `isEmptyWalletError()`, `isBalanceError()`, `isRpcError()`. |
| `src/types.ts` | OpenClaw plugin type definitions (duck-typed, no external dep). `ProviderPlugin`, `OpenClawPluginApi`, `OpenClawPluginDefinition`, `ModelDefinitionConfig`, etc. |
| `src/config.ts` | Reads `BLOCKRUN_PROXY_PORT` env var (default: 8402). IIFE at module load time. |
| `src/version.ts` | Reads version from package.json at runtime via `createRequire`. Exports `VERSION`, `USER_AGENT`. |
| `src/fs-read.ts` | `readTextFile()` / `readTextFileSync()` — open()+read() pattern to avoid OpenClaw scanner false positives for exfiltration heuristic. |
| `src/provider.ts` | `blockrunProvider` — `ProviderPlugin` definition. `auth: []` (empty — proxy handles x402). Dynamic `models` getter pointing to proxy URL. |

## Development Commands

```bash
npm run build          # tsup → dist/
npm run dev            # tsup --watch
npm test               # vitest run
npm run test:watch     # vitest (watch mode)
npm run typecheck      # tsc --noEmit
npm run lint           # eslint src/
npm run format         # prettier --write .
npm run format:check   # prettier --check .
```

### Resilience & Integration Tests

```bash
npm run test:resilience:errors     # Error handling tests
npm run test:resilience:stability  # 5-min stability test
npm run test:resilience:stability:full  # 4-hour stability
npm run test:resilience:lifecycle   # Lifecycle tests
npm run test:resilience:quick       # Errors + lifecycle
npm run test:e2e:tool-ids           # Tool ID sanitization E2E
npm run test:docker:integration     # Docker integration tests
```

## Code Style & Conventions

### TypeScript
- **Strict mode** enabled (`"strict": true` in tsconfig.json)
- **ESM only** (`"type": "module"` in package.json)
- **Target**: ES2022, ESNext modules, bundler module resolution
- All `.js` extensions in imports (required for ESM)
- Prefer `interface` for object shapes, `type` for unions/intersections
- Explicit return types on exported functions
- `readonly` for immutable class fields and map entries

### Formatting (Prettier)
- Double quotes, semicolons, trailing commas, 100-char print width, 2-space indent
- Config in `.prettierrc`

### Linting (ESLint)
- Flat config via `typescript-eslint` — extends `eslint:recommended` + `tseslint:recommended`
- Ignores: `dist/`, `node_modules/`, `test/`

### Patterns
- **No class-heavy design**: mostly functions, plain objects, and a few stateful classes (SessionStore, BalanceMonitor, SpendControl, ResponseCache)
- **Functional exports**: modules export functions and types, not class instances
- **Safety-first**: wallet operations refuse to overwrite existing wallets; all filters return the original list when all items would be removed
- **Error categorization**: `categorizeError()` in proxy.ts maps HTTP status+body to semantic categories (auth_failure, rate_limited, overloaded, server_error, payment_error, config_error)
- **In-memory state**: most state is in-memory (sessions, rate limits, caches); persistence is only for wallet keys, spending history, exclude lists, and usage logs
- **Scanner-safe file reads**: `fs-read.ts` uses `open()+read()` instead of `readFileSync()` to avoid OpenClaw's potential-exfiltration heuristic

### Naming
- Files: kebab-case (`response-cache.ts`, `payment-preauth.ts`)
- Constants: UPPER_SNAKE_CASE (`PROXY_PORT`, `FREE_MODEL`, `MAX_FALLBACK_ATTEMPTS`)
- Types/PascalCase for exported types, camelCase for functions
- `AsyncLocalStorage` for request-scoped payment tracking (concurrent request safety)

## Testing

- **Framework**: vitest v4
- **Test files**: co-located with source (`*.test.ts`, `*.integration.test.ts`, `*.edge-cases.test.ts`)
- **Test locations**: `src/models.test.ts`, `src/wallet.test.ts`, `src/journal.test.ts`, `src/session.test.ts`, `src/spend-control.test.ts`, `src/response-cache.test.ts`, `src/response-cache.advanced.test.ts`, `src/response-cache.extreme.test.ts`, `src/exclude-models.test.ts`, `src/exclude-models.integration.test.ts`, `src/x402-sdk.test.ts`, `src/update-hint.test.ts`, `src/proxy.models-endpoint.test.ts`, `src/proxy.payment-chain-reuse.test.ts`, `src/proxy.solana-resilience.test.ts`, `src/proxy.debrand.test.ts`, `src/proxy.degraded-response.test.ts`, `src/proxy.image-download.test.ts`, `src/error-classification.test.ts`
- **Resilience tests**: `test/resilience-*.ts` (run via tsx, not vitest)

## Payment System Details

### x402 Flow

```text
1. Proxy sends request to BlockRun API
2. API returns 402 with payment requirements (amount, recipient, etc.)
3. Proxy parses requirements, caches for future pre-auth
4. Wallet signs USDC payment via @x402/evm (Base) or @x402/svm (Solana)
5. Proxy retries request with payment headers
6. API verifies payment, processes request, returns response
```

### Chains
- **Base (EVM)**: viem public client, USDC ERC-20, `@x402/evm` for signing
- **Solana**: `@solana/kit`, USDC SPL token, `@x402/svm` for signing
- **Selection**: env `CLAWROUTER_PAYMENT_CHAIN` → persisted file → default "base"
- **Both derived** from single BIP-39 mnemonic (different HD paths)

### Wallet Persistence

```text
~/.openclaw/blockrun/
├── wallet.key          # EVM private key (0x..., mode 0o600)
├── mnemonic            # BIP-39 mnemonic (mode 0o600)
├── payment-chain       # "base" or "solana"
├── spending.json       # Spend control history + limits
├── exclude-models.json # User-excluded model IDs
└── logs/
    └── usage-YYYY-MM-DD.jsonl  # Daily usage logs
```

### Spend Control
- Four windows: `perRequest`, `hourly`, `daily`, `session`
- Rolling windows (last 1 h, last 24 h)
- Persistent to `spending.json`
- Also supports `maxCostPerRun` via plugin config (graceful or strict mode)

## Router System

### Routing Profiles

| Profile | Strategy | Use Case |
|---------|----------|----------|
| `auto` (default) | Balanced with agentic detection | General use |
| `eco` | Ultra cost-optimized | Maximum savings |
| `premium` | Best quality | Mission-critical |
| `free` | NVIDIA GPT-OSS-120B only | Zero cost |

### Classification (RulesStrategy)
1. Estimate tokens (~4 chars/token from system + user)
2. Score 14 dimensions against **user prompt only** (system prompts contain boilerplate that dominates scoring — see issue #50)
3. Compute weighted score with `dimensionWeights`
4. Map score to tier using `tierBoundaries` (simpleMedium, mediumComplex, complexReasoning)
5. Calibrate confidence via sigmoid of distance from boundary
6. Direct reasoning override: 2+ reasoning keyword matches → high-confidence REASONING
7. Agentic detection: 4+ agentic keyword matches → agentic tier configs
8. Override: large context → force COMPLEX; structured output → min tier

### Fallback Chain
- Up to 5 models per request (`MAX_FALLBACK_ATTEMPTS`)
- 60 s per model attempt (`PER_MODEL_TIMEOUT_MS`)
- Rate-limited models deprioritized for 60 s; overloaded for 15 s
- Safety: if all models filtered by vision/tools/exclude, returns unfiltered list
- Free model (`nvidia/gpt-oss-120b`) is universal fallback when wallet is empty

## Important Constraints

- **Node.js ≥20** (package.json engines), tsup targets node20
- **ESM only** — no CJS, all imports use `.js` extensions
- **No external runtime deps for routing** — classification is purely local, no API calls
- **Atomic config writes** — temp file + rename to prevent corruption
- **Wallet safety** — refuses to generate new wallet if mnemonic file exists (prevents silent fund loss)
- **`process["env"]`** — bracket notation used instead of `process.env` in auth.ts to avoid OpenClaw scanner false positives
- **x402 SDK** — `@x402/fetch`, `@x402/evm`, `@x402/svm` are the only payment dependencies
- **No API keys stored** — proxy placeholder `"x402-proxy-handles-auth"` satisfies OpenClaw's credential lookup
- **OpenClaw peer dependency** — optional (`peerDependenciesMeta.optional: true`)

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BLOCKRUN_WALLET_KEY` | auto-generated | EVM wallet private key (0x...) |
| `BLOCKRUN_PROXY_PORT` | `8402` | Local proxy port |
| `CLAWROUTER_PAYMENT_CHAIN` | `base` | Payment chain (base/solana) |
| `CLAWROUTER_SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | Solana RPC endpoint |
| `CLAWROUTER_DISABLED` | `false` | Disable smart routing |

## Common Tasks

### Add a New Model

1. Add entry to `BLOCKRUN_MODELS[]` in `src/models.ts` with pricing, context window, capabilities
2. If the model should appear in the OpenClaw model picker, add to `TOP_MODELS` in `src/index.ts`
3. Update tier configs in `src/router/config.ts` if the model should be a primary or fallback
4. Add any aliases to `MODEL_ALIASES` in `src/models.ts`
5. Add to README.md pricing table
6. Run `npm test` and `npm run typecheck`

### Add a Compression Layer

1. Create `src/compression/layers/<name>.ts`
2. Export a function `compressXxx(messages: NormalizedMessage[]): { messages: NormalizedMessage[]; stats: ... }`
3. Add the layer key to `CompressionConfig.layers` in `src/compression/types.ts`
4. Add corresponding stats fields to `CompressionStats`
5. Wire into `compressContext()` in `src/compression/index.ts`
6. Toggle in `DEFAULT_COMPRESSION_CONFIG`

### Add a Partner API

1. Add definition to `PARTNER_SERVICES[]` in `src/partners/registry.ts`
2. Specify proxy path, HTTP method, params, pricing
3. The rest is automatic: `buildPartnerTools()` generates the OpenClaw tool, the proxy handles x402 payment
4. Test with `npx @blockrun/clawrouter partners test`

### Add a Routing Dimension

1. Add dimension scorer function in `src/router/rules.ts`
2. Add keyword list to `ScoringConfig` in `src/router/types.ts`
3. Add default keywords in `DEFAULT_ROUTING_CONFIG` in `src/router/config.ts`
4. Add dimension weight to `dimensionWeights`
5. Wire into `classifyByRules()` dimensions array

## File Map

```text
src/
├── index.ts                    # OpenClaw plugin entry — config injection, proxy start, command registration
├── cli.ts                      # Standalone CLI — doctor, partners, report, wallet, chain
├── proxy.ts                    # HTTP proxy core — all request handling, x402, streaming, fallbacks
├── provider.ts                 # OpenClaw ProviderPlugin definition
├── config.ts                   # Env var reads (proxy port)
├── version.ts                  # Version from package.json
├── types.ts                    # OpenClaw plugin type definitions (duck-typed)
├── errors.ts                   # Typed error classes + type guards
├── fs-read.ts                  # Scanner-safe file reading utilities
├── models.ts                   # Model definitions, aliases, pricing, capabilities
├── auth.ts                     # Wallet lifecycle, key persistence, chain selection
├── wallet.ts                   # BIP-39/44 HD key derivation (EVM + Solana)
├── balance.ts                  # USDC balance monitor (Base)
├── solana-balance.ts           # USDC balance monitor (Solana)
├── payment-preauth.ts          # x402 payment requirement caching (~200ms savings)
├── spend-control.ts            # Time-windowed spending limits
├── logger.ts                   # JSONL usage logging
├── session.ts                  # Session model pinning + three-strike escalation
├── journal.ts                  # Session memory — extract key actions from responses
├── retry.ts                    # Exponential backoff fetch wrapper
├── response-cache.ts           # LRU LLM response cache
├── dedup.ts                    # Request deduplication (prevent double-charging)
├── exclude-models.ts           # Model exclusion persistence
├── stats.ts                    # Usage statistics aggregation from JSONL logs
├── report.ts                   # Cost report generator (markdown)
├── doctor.ts                   # AI-powered diagnostics (sends to Sonnet/Opus)
├── updater.ts                  # npm registry version check
├── router/
│   ├── index.ts                # Router barrel — route(), strategy registry, helper exports
│   ├── types.ts                # Router types: Tier, RoutingDecision, RoutingConfig
│   ├── strategy.ts             # RulesStrategy + strategy registry
│   ├── rules.ts                # 14-dimension rule-based classifier
│   ├── selector.ts             # Tier → model selection, fallback chains, cost calculation
│   ├── llm-classifier.ts       # LLM fallback classifier (ambiguous requests)
│   └── config.ts               # Default routing config + keyword lists
├── compression/
│   ├── index.ts                # 7-layer compression pipeline entry
│   ├── types.ts                # Compression types + default config
│   ├── codebook.ts             # Static dictionary codebook (~45 entries)
│   └── layers/
│       ├── deduplication.ts    # L1: Remove duplicate messages
│       ├── whitespace.ts       # L2: Normalize whitespace
│       ├── dictionary.ts       # L3: Phrase → code substitution
│       ├── paths.ts            # L4: Path shortening
│       ├── json-compact.ts     # L5: JSON whitespace removal
│       ├── observation.ts      # L6: Tool result compression
│       └── dynamic-codebook.ts # L7: Content-aware codebook
├── partners/
│   ├── index.ts                # Partner barrel exports
│   ├── registry.ts             # Partner service definitions
│   └── tools.ts                # Partner → OpenClaw tool conversion
└── *.test.ts                   # Co-located vitest tests
```
