---
name: surf
description: Use this skill — NOT browser or web_fetch — for ALL Surf crypto-data calls. 83 endpoints at localhost:8402/v1/surf/* covering CEX/DEX markets, on-chain SQL over 80+ ClickHouse tables (Ethereum, Base, Arbitrum, BSC, TRON, HyperEVM, Tempo), 100M+ labeled wallets, prediction markets (Polymarket + Kalshi), social/CT intelligence, news, project + DeFi metrics, token analytics, unified search, VC fund intelligence. Paid through ClawRouter — x402 USDC from the local wallet, or BlockRun account credit if an API key is configured. No Surf account or Surf API key required either way.
triggers:
  - "blockrun surf"
  - "surf crypto api"
  - "surf onchain sql"
  - "onchain sql query"
  - "clickhouse onchain query"
  - "raw sql ethereum"
  - "raw sql base"
  - "wallet labels api"
  - "labeled wallets api"
  - "surf wallet detail"
  - "crypto mindshare"
  - "crypto news api"
  - "fear and greed index crypto"
  - "token holder distribution"
  - "vc fund portfolio"
  - "ethena tokenomics"
homepage: https://blockrun.ai/marketplace/surf
license: MIT
---

# Surf — Unified Crypto Data API (via ClawRouter)

Surf bundles **83 endpoints across 12 domains** into one paid HTTP API. ClawRouter exposes them at `http://127.0.0.1:8402/v1/surf/*`, paid the same way ClawRouter pays for LLM calls — an x402 USDC micropayment from the local wallet, or a draw on BlockRun account credit if an API key is configured (verified working on both, 2026-09-05). **No Surf account and no Surf API key either way.** Upstream lives at `api.asksurf.ai/gateway/v1` — ClawRouter forwards transparently.

**Pricing — flat per call, the same for every endpoint.**

Surf used to be tiered at $0.001 / $0.005 / $0.020. It is not any more: upstream
now prices all three tiers identically (`SURF_TIER_{1,2,3}_PRICE` are equal). The
`Tier` column in the catalog below still describes endpoint weight, but it no
longer affects what you pay. Anything quoting the old tier prices is stale.

| Rail                        | Price per call                              |
| --------------------------- | ------------------------------------------- |
| API key (`api.blockrun.ai`) | **$0.0075** — base rate, no transaction fee |
| Wallet, Solana              | **$0.0075**                                 |
| Wallet, Base                | **$0.0085**                                 |

Verified 2026-09-05 by measurement, not from a price page: the API-key figure by
diffing the account ledger across one call, the wallet figures by reading the
`amount` in the x402 402 challenge, which quotes the price before anything is
signed. Base and Solana genuinely differ for the same endpoint.

**The 402 quote is always authoritative.** On the wallet rail the price arrives
in the challenge before you pay, so if this table ever disagrees with it, believe
the challenge and treat the table as stale.

> The legacy **surf-1.5 chat** surface is intentionally NOT exposed yet — it's held until per-token settlement is wired. Trying `/v1/surf/chat/completions` returns 404 ("Unknown Surf endpoint"), no payment is taken.

All requests use GET unless the table below says otherwise. Path parameters that look like `?symbol=` are query params on a GET. POST endpoints take a JSON body. ClawRouter attaches payment transparently — an x402 header in wallet mode, a bearer token in API-key mode.

**Required-param pre-check.** 56 of the 83 endpoints have required query params (e.g. `pair`, `symbol`, `address`, `chain`, `q`, `interval`). The route validates them **before settlement** — call with missing params and you get `400 { missing_params, all_required, docs }` and you are NOT charged. Check each row in the catalog below for the correct param name (e.g. mindshare is `q` + `interval`, not `project` + `window`).

## When to use this skill

- "What is the current BTC price?" → `/surf/market/price?symbol=BTC` (cheaper + more reliable than scraping)
- "Who holds the most USDC on Ethereum?" → `/surf/token/holders?address=0xA0b8...&chain=ethereum`
- "How many Ethereum transactions in the last hour?" → `POST /surf/onchain/sql { sql: 'SELECT count() FROM ethereum.transactions WHERE block_timestamp >= now() - INTERVAL 1 HOUR' }`
- "Label this list of wallets." → `/surf/wallet/labels/batch?addresses=0xabc,0xdef,...`
- "Is HYPE mindshare peaking?" → `/surf/social/mindshare?q=hyperliquid&interval=30d`
- "Find the canonical metadata for 'ethena'." → `/surf/search/project?q=ethena`

Always prefer Surf over generic web scraping for these. Call the HTTP path through the local ClawRouter proxy from the agent or a script. No `blockrun_surf_*` tools are registered.

## Endpoint catalog

### Exchange (CEX) — 7 endpoints

| Path                              | Tier | Required |
| --------------------------------- | ---- | -------- |
| `/surf/exchange/markets`          | T1   | —        |
| `/surf/exchange/price`            | T1   | `pair`   |
| `/surf/exchange/perp`             | T1   | `pair`   |
| `/surf/exchange/depth`            | T2   | `pair`   |
| `/surf/exchange/klines`           | T2   | `pair`   |
| `/surf/exchange/funding-history`  | T2   | `pair`   |
| `/surf/exchange/long-short-ratio` | T2   | `pair`   |

### Market Overview — 11 endpoints

| Path                                     | Tier | Required                                          |
| ---------------------------------------- | ---- | ------------------------------------------------- |
| `/surf/market/ranking`                   | T1   | —                                                 |
| `/surf/market/fear-greed`                | T1   | —                                                 |
| `/surf/market/futures`                   | T1   | —                                                 |
| `/surf/market/price`                     | T1   | `symbol`                                          |
| `/surf/market/etf`                       | T1   | `symbol`                                          |
| `/surf/market/options`                   | T1   | `symbol`                                          |
| `/surf/market/liquidation/exchange-list` | T2   | —                                                 |
| `/surf/market/liquidation/order`         | T2   | —                                                 |
| `/surf/market/liquidation/chart`         | T2   | `symbol`                                          |
| `/surf/market/onchain-indicator`         | T2   | `symbol`, `metric` (NUPL, SOPR, MVRV, Puell, NVT) |
| `/surf/market/price-indicator`           | T2   | `indicator` (RSI, MACD, Bollinger, EMA), `symbol` |

### News — 2 endpoints

| Path                | Tier | Required             |
| ------------------- | ---- | -------------------- |
| `/surf/news/feed`   | T1   | — (`limit` optional) |
| `/surf/news/detail` | T1   | `id`                 |

### On-Chain — 7 endpoints

| Path                           | Method   | Tier | Required                 |
| ------------------------------ | -------- | ---- | ------------------------ |
| `/surf/onchain/bridge/ranking` | GET      | T1   | —                        |
| `/surf/onchain/yield/ranking`  | GET      | T1   | —                        |
| `/surf/onchain/gas-price`      | GET      | T1   | `chain`                  |
| `/surf/onchain/tx`             | GET      | T1   | `hash`, `chain`          |
| `/surf/onchain/schema`         | GET      | T3   | —                        |
| `/surf/onchain/query`          | **POST** | T3   | typed predicates in body |
| `/surf/onchain/sql`            | **POST** | T3   | `{ sql: "SELECT ..." }`  |

**On-Chain SQL workflow.** Call `/surf/onchain/schema` once to get table names + columns (cache it locally — schema is stable). Then POST your SELECT against `/surf/onchain/sql`. Always include `LIMIT` on large scans — billing is per call, but slow queries time out. Multi-statement queries are rejected upstream.

### Prediction Markets (Polymarket + Kalshi) — 17 endpoints

| Path                                               | Tier | Required        |
| -------------------------------------------------- | ---- | --------------- |
| `/surf/prediction-market/category-metrics`         | T1   | —               |
| `/surf/prediction-market/polymarket/ranking`       | T1   | —               |
| `/surf/prediction-market/polymarket/trades`        | T1   | —               |
| `/surf/prediction-market/polymarket/markets`       | T1   | `market_slug`   |
| `/surf/prediction-market/polymarket/events`        | T1   | `event_slug`    |
| `/surf/prediction-market/polymarket/prices`        | T1   | `condition_id`  |
| `/surf/prediction-market/polymarket/volumes`       | T1   | `condition_id`  |
| `/surf/prediction-market/polymarket/open-interest` | T1   | `condition_id`  |
| `/surf/prediction-market/polymarket/positions`     | T2   | `address`       |
| `/surf/prediction-market/polymarket/activity`      | T2   | `address`       |
| `/surf/prediction-market/kalshi/ranking`           | T1   | —               |
| `/surf/prediction-market/kalshi/markets`           | T1   | `market_ticker` |
| `/surf/prediction-market/kalshi/events`            | T1   | `event_ticker`  |
| `/surf/prediction-market/kalshi/prices`            | T1   | `ticker`        |
| `/surf/prediction-market/kalshi/trades`            | T1   | `ticker`        |
| `/surf/prediction-market/kalshi/volumes`           | T1   | `ticker`        |
| `/surf/prediction-market/kalshi/open-interest`     | T1   | `ticker`        |

(For Polymarket smart-money, wallet PnL, UMA oracle resolution, and the other prediction-market venues — Limitless, Opinion, Predict.Fun, dFlow, Binance Futures, cross-venue canonical markets — use the dedicated **Predexon** integration instead; Surf's prediction-market coverage is narrower but cheaper.)

### Project + DeFi — 3 endpoints

| Path                         | Tier | Required |
| ---------------------------- | ---- | -------- |
| `/surf/project/detail`       | T1   | —        |
| `/surf/project/defi/metrics` | T1   | `metric` |
| `/surf/project/defi/ranking` | T1   | `metric` |

### Social / CT Intelligence — 11 endpoints

| Path                                   | Tier | Required        |
| -------------------------------------- | ---- | --------------- |
| `/surf/social/detail`                  | T2   | —               |
| `/surf/social/ranking`                 | T2   | —               |
| `/surf/social/smart-followers/history` | T2   | —               |
| `/surf/social/mindshare`               | T2   | `q`, `interval` |
| `/surf/social/tweets`                  | T1   | `ids`           |
| `/surf/social/tweet/replies`           | T1   | `tweet_id`      |
| `/surf/social/user`                    | T1   | `handle`        |
| `/surf/social/user/followers`          | T1   | `handle`        |
| `/surf/social/user/following`          | T1   | `handle`        |
| `/surf/social/user/posts`              | T1   | `handle`        |
| `/surf/social/user/replies`            | T1   | `handle`        |

### Token Analytics — 4 endpoints

| Path                     | Tier | Required           |
| ------------------------ | ---- | ------------------ |
| `/surf/token/tokenomics` | T1   | —                  |
| `/surf/token/dex-trades` | T2   | `address`          |
| `/surf/token/holders`    | T2   | `address`, `chain` |
| `/surf/token/transfers`  | T2   | `address`, `chain` |

### Unified Search — 11 endpoints (all Tier 2)

| Path                         | Required |
| ---------------------------- | -------- |
| `/surf/search/airdrop`       | —        |
| `/surf/search/events`        | —        |
| `/surf/search/kalshi`        | —        |
| `/surf/search/polymarket`    | —        |
| `/surf/search/web`           | `q`      |
| `/surf/search/project`       | `q`      |
| `/surf/search/news`          | `q`      |
| `/surf/search/wallet`        | `q`      |
| `/surf/search/fund`          | `q`      |
| `/surf/search/social/people` | `q`      |
| `/surf/search/social/posts`  | `q`      |

### VC Fund Intelligence — 3 endpoints

| Path                   | Tier | Required |
| ---------------------- | ---- | -------- |
| `/surf/fund/detail`    | T1   | —        |
| `/surf/fund/portfolio` | T1   | —        |
| `/surf/fund/ranking`   | T1   | `metric` |

### Wallet Intelligence — 6 endpoints (all Tier 2)

| Path                        | Required                            |
| --------------------------- | ----------------------------------- |
| `/surf/wallet/detail`       | `address`                           |
| `/surf/wallet/history`      | `address`                           |
| `/surf/wallet/net-worth`    | `address`                           |
| `/surf/wallet/transfers`    | `address`                           |
| `/surf/wallet/protocols`    | `address`                           |
| `/surf/wallet/labels/batch` | `addresses` (comma-separated, ≤200) |

### Web — 1 endpoint

| Path              | Tier | Required |
| ----------------- | ---- | -------- |
| `/surf/web/fetch` | T2   | `url`    |

## Example flows

**1. "Who is wallet X and what do they hold?"**

```bash
curl 'http://127.0.0.1:8402/v1/surf/wallet/detail?address=vitalik.eth'
```

If the response says they're a smart-money wallet, follow up with `/surf/wallet/protocols?address=...` for protocol breakdown or `/surf/wallet/history?address=...` for the activity timeline.

**2. "How concentrated is supply for token Y?"**

```bash
curl 'http://127.0.0.1:8402/v1/surf/token/holders?address=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48&limit=25'
```

Combine the top-25 balances with their wallet labels — `/surf/wallet/labels/batch?addresses=...` — to distinguish "concentration in CEX hot wallets" (normal) from "concentration in dev team multisig" (riskier).

**3. "Run a custom on-chain query."**

```bash
# Step 1 — fetch schema (do this once, then cache locally)
curl 'http://127.0.0.1:8402/v1/surf/onchain/schema'

# Step 2 — run the SQL
curl -X POST 'http://127.0.0.1:8402/v1/surf/onchain/sql' \
  -H 'content-type: application/json' \
  -d '{"sql":"SELECT to_address, count() AS hits FROM ethereum.transactions WHERE block_timestamp >= now() - INTERVAL 1 DAY GROUP BY to_address ORDER BY hits DESC LIMIT 20"}'
```

Cost: two calls at the rates above total **$0.015 with an API key or Solana wallet**, or **$0.017 with a Base wallet**. Reusing the cached schema avoids another schema call. Check the current gateway quote or account activity for the actual charge.

**4. "Is project Z trending?"**

```bash
# Resolve the canonical slug first (search uses q, not query)
curl 'http://127.0.0.1:8402/v1/surf/search/project?q=ethena'

# Then pull mindshare (mindshare uses q + interval)
curl 'http://127.0.0.1:8402/v1/surf/social/mindshare?q=ethena&interval=30d'
```

## How calls are paid

ClawRouter intercepts every `/v1/surf/*` request through `proxyPaidApiRequest`. API-key mode authenticates with the selected key and bills account credit. Wallet mode signs an x402 USDC payment on the selected chain. The agent does not switch payment methods. Telemetry tags Surf calls with `tier: SURF` so `clawrouter stats` separates them from LLM, partner, and phone usage.

No typed `blockrun_surf_*` tools are registered — by design. Each new BlockRun-marketplace API ships as a skill (this file) plus a one-line namespace addition to ClawRouter's proxy whitelist, so adding endpoint #85 requires zero ClawRouter release.
