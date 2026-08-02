# ClawRouter

Smart LLM router for autonomous agents. <!-- br:models.chatVisible -->65<!-- /br:models.chatVisible --> models. Wallet-based auth. USDC micropayments via x402.

## Commands

```bash
npm install              # install dependencies
npm run build            # compile with tsup
npm run dev              # watch mode
npm test                 # run vitest
npm run typecheck        # type checking
npm run lint             # eslint
npm run format           # prettier
npm run test:resilience:quick   # error + lifecycle resilience tests
npm run test:resilience:full    # full resilience suite (4hr stability)
npm run test:e2e:tool-ids       # end-to-end tool ID sanitization
npm run test:docker:install     # Docker install test
npm run test:docker:edge-cases  # Docker edge case tests
npm run test:docker:integration # Docker integration tests
```

## Project structure

```
src/
├── index.ts             # Library entry point
├── cli.ts               # CLI entry point
├── auth.ts              # Wallet-based authentication
├── balance.ts           # USDC balance management
├── models.ts            # Model registry and scoring
├── config.ts            # Configuration
├── errors.ts            # Error classification
├── logger.ts            # Logging
├── journal.ts           # Request journaling
├── exclude-models.ts    # Model exclusion logic
├── dedup.ts             # Request deduplication
├── fs-read.ts           # Filesystem reading
├── compression/         # Request/response compression
├── doctor.ts            # Diagnostic tool
└── partners/            # Partner integrations
```

## Key dependencies

- `@x402/fetch`, `@x402/evm`, `@x402/svm` — x402 payment protocol
- `viem` — Ethereum interaction
- `@solana/kit` — Solana interaction
- `@scure/bip32`, `@scure/bip39` — Wallet key derivation

## Conventions

- TypeScript strict mode, ESM
- Build with tsup, test with vitest
- Lint with eslint, format with prettier
- Node >= 22
- MIT license
- npm registry: `@blockrun/clawrouter`
- <!-- br:clawrouter.dimensions -->15<!-- /br:clawrouter.dimensions -->-dimension scoring for model routing (all local, < 1ms)
