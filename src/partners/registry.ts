/**
 * Partner Service Registry
 *
 * Defines available partner APIs that can be called through ClawRouter's proxy.
 * Partners cover prediction-market data, realtime market quotes, and image/video
 * generation — all paid via x402 micropayments on the same wallet as LLM calls.
 */

export type PartnerServiceParam = {
  name: string;
  type: "string" | "string[]" | "number";
  description: string;
  required: boolean;
};

export type PartnerCategory =
  "Prediction markets" | "Market data" | "Image & Video" | "Communications";

export type PartnerServiceDefinition = {
  /** Unique service ID used in tool names: blockrun_{id} */
  id: string;
  /** Human-readable name */
  name: string;
  /** Partner providing this service */
  partner: string;
  /** Category used for grouping in the `/partners` list view */
  category: PartnerCategory;
  /** Compact one-liner used in the `/partners` list (≤ 40 chars ideal) */
  shortDescription: string;
  /** Full description used for the tool's JSON Schema (LLM sees this) */
  description: string;
  /** Proxy path (relative to /v1) */
  proxyPath: string;
  /** HTTP method */
  method: "GET" | "POST";
  /** Parameters for the tool's JSON Schema */
  params: PartnerServiceParam[];
  /** Pricing info for display */
  pricing: {
    perUnit: string;
    unit: string;
    minimum: string;
    maximum: string;
  };
  /** Example usage for help text */
  example: {
    input: Record<string, unknown>;
    description: string;
  };
};

/**
 * All registered partner services.
 * New partners are added here — the rest of the system picks them up automatically.
 */
export const PARTNER_SERVICES: PartnerServiceDefinition[] = [
  // ---------------------------------------------------------------------------
  // Predexon — Prediction Market Data
  // ---------------------------------------------------------------------------
  {
    id: "predexon_events",
    name: "Polymarket Events",
    partner: "Predexon",
    category: "Prediction markets",
    shortDescription: "Live Polymarket events",
    description:
      "Get live Polymarket prediction market events with current odds, volume, and liquidity. " +
      "Call this for ANY request about prediction markets, Polymarket markets, current odds, " +
      "what people are betting on, or market sentiment. " +
      "Do NOT use browser or web scraping — this returns structured real-time data directly. " +
      "Returns: event title, YES/NO prices (implied probability), volume, liquidity, end date.",
    proxyPath: "/pm/polymarket/events",
    method: "GET",
    params: [
      {
        name: "limit",
        type: "number",
        description: "Number of events to return (default: 20, max: 100)",
        required: false,
      },
      {
        name: "tag",
        type: "string",
        description: "Filter by category: crypto, politics, sports, science, economics, etc.",
        required: false,
      },
    ],
    pricing: { perUnit: "$0.001", unit: "request", minimum: "$0.001", maximum: "$0.001" },
    example: {
      input: { limit: 20 },
      description: "Get top 20 live Polymarket events",
    },
  },
  {
    id: "predexon_leaderboard",
    name: "Polymarket Leaderboard",
    partner: "Predexon",
    category: "Prediction markets",
    shortDescription: "Top traders ranked by profit",
    description:
      "Get the Polymarket leaderboard of top traders ranked by profit. " +
      "Call this for ANY request about top Polymarket traders, whale wallets, best performers, " +
      "richest traders, or who is making the most money on Polymarket. " +
      "Do NOT use browser or web scraping — this returns structured data directly. " +
      "Returns: wallet address/username, total profit, total volume, win rate.",
    proxyPath: "/pm/polymarket/leaderboard",
    method: "GET",
    params: [
      {
        name: "limit",
        type: "number",
        description: "Number of wallets to return (default: 20, max: 100)",
        required: false,
      },
    ],
    pricing: { perUnit: "$0.001", unit: "request", minimum: "$0.001", maximum: "$0.001" },
    example: {
      input: { limit: 20 },
      description: "Get top 20 Polymarket whale wallets by profit",
    },
  },
  {
    id: "predexon_markets",
    name: "Polymarket Markets Search",
    partner: "Predexon",
    category: "Prediction markets",
    shortDescription: "Market search by keyword",
    description:
      "Search and filter Polymarket markets. Use this to find a market by keyword and get its conditionId " +
      "for follow-up calls (smart money, top holders, etc.). " +
      "Returns: question, conditionId, YES/NO prices, volume.",
    proxyPath: "/pm/polymarket/markets",
    method: "GET",
    params: [
      {
        name: "search",
        type: "string",
        description: "Keyword to search for (e.g. 'bitcoin', 'election', 'fed rate')",
        required: false,
      },
      {
        name: "limit",
        type: "number",
        description: "Number of markets to return (default: 20)",
        required: false,
      },
    ],
    pricing: { perUnit: "$0.001", unit: "request", minimum: "$0.001", maximum: "$0.001" },
    example: {
      input: { search: "bitcoin", limit: 10 },
      description: "Search for Bitcoin-related prediction markets",
    },
  },
  {
    id: "predexon_smart_money",
    name: "Polymarket Smart Money",
    partner: "Predexon",
    category: "Prediction markets",
    shortDescription: "Smart-money positions on a market",
    description:
      "See how high-performing wallets are positioned on a specific Polymarket market. " +
      "Use this after finding a market's conditionId via predexon_markets or predexon_events. " +
      "Returns: wallet addresses, their YES/NO positions, size, P&L, win rate.",
    proxyPath: "/pm/polymarket/market/:condition_id/smart-money",
    method: "GET",
    params: [
      {
        name: "condition_id",
        type: "string",
        description: "The market's conditionId (get this from predexon_markets or predexon_events)",
        required: true,
      },
      {
        name: "limit",
        type: "number",
        description: "Number of positions to return (default: 20)",
        required: false,
      },
    ],
    pricing: { perUnit: "$0.005", unit: "request", minimum: "$0.005", maximum: "$0.005" },
    example: {
      input: { condition_id: "0xabc123...", limit: 10 },
      description: "See smart money positioning on a specific market",
    },
  },
  {
    id: "predexon_smart_activity",
    name: "Polymarket Smart Activity",
    partner: "Predexon",
    category: "Prediction markets",
    shortDescription: "Where smart money is flowing now",
    description:
      "Discover which Polymarket markets high-performing wallets are currently active in. " +
      "Use this to find where smart money is flowing right now. " +
      "Returns: market titles, smart money volume, number of smart wallets active.",
    proxyPath: "/pm/polymarket/markets/smart-activity",
    method: "GET",
    params: [
      {
        name: "limit",
        type: "number",
        description: "Number of markets to return (default: 20)",
        required: false,
      },
    ],
    pricing: { perUnit: "$0.005", unit: "request", minimum: "$0.005", maximum: "$0.005" },
    example: {
      input: { limit: 10 },
      description: "Find markets where smart money is most active",
    },
  },
  {
    id: "predexon_wallet",
    name: "Polymarket Wallet Profile",
    partner: "Predexon",
    category: "Prediction markets",
    shortDescription: "Wallet profile (PnL, winrate, positions)",
    description:
      "Get a complete profile for a Polymarket wallet address: profit, volume, win rate, markets traded, open positions. " +
      "Use this when the user asks to analyze or look up a specific wallet address.",
    proxyPath: "/pm/polymarket/wallet/:wallet",
    method: "GET",
    params: [
      {
        name: "wallet",
        type: "string",
        description: "Ethereum wallet address (0x...)",
        required: true,
      },
    ],
    pricing: { perUnit: "$0.005", unit: "request", minimum: "$0.005", maximum: "$0.005" },
    example: {
      input: { wallet: "0x1234...abcd" },
      description: "Get complete profile for a Polymarket wallet",
    },
  },
  {
    id: "predexon_wallet_pnl",
    name: "Polymarket Wallet P&L",
    partner: "Predexon",
    category: "Prediction markets",
    shortDescription: "Wallet P&L time series",
    description:
      "Get P&L history and realized profit/loss time series for a Polymarket wallet. " +
      "Use this when the user wants to see how a wallet has performed over time.",
    proxyPath: "/pm/polymarket/wallet/pnl/:wallet",
    method: "GET",
    params: [
      {
        name: "wallet",
        type: "string",
        description: "Ethereum wallet address (0x...)",
        required: true,
      },
    ],
    pricing: { perUnit: "$0.005", unit: "request", minimum: "$0.005", maximum: "$0.005" },
    example: {
      input: { wallet: "0x1234...abcd" },
      description: "Get P&L history for a Polymarket wallet",
    },
  },
  {
    id: "predexon_matching_markets",
    name: "Cross-Market Matching (Polymarket vs Kalshi)",
    partner: "Predexon",
    category: "Prediction markets",
    shortDescription: "Polymarket ↔ Kalshi market pairs",
    description:
      "Find equivalent markets across Polymarket and Kalshi to compare odds and spot arbitrage. " +
      "Use this when the user wants to compare prediction market prices across platforms.",
    proxyPath: "/pm/matching-markets",
    method: "GET",
    params: [
      {
        name: "limit",
        type: "number",
        description: "Number of matched pairs to return (default: 20)",
        required: false,
      },
    ],
    pricing: { perUnit: "$0.005", unit: "request", minimum: "$0.005", maximum: "$0.005" },
    example: {
      input: { limit: 10 },
      description: "Compare equivalent markets on Polymarket vs Kalshi",
    },
  },
  {
    id: "predexon_endpoint_call",
    name: "Predexon Endpoint Call (Full Catalog)",
    partner: "Predexon",
    category: "Prediction markets",
    shortDescription: "Direct call to any Predexon endpoint",
    description:
      "Call ANY Predexon endpoint by path. Use this when the named predexon_* tools " +
      "don't cover what you need (orderbooks, candlesticks, top-holders, UMA oracle, " +
      "wallet identity/cluster, Kalshi/Limitless/Opinion/Predict.Fun, dFlow, Binance " +
      "Futures, cross-venue canonical markets, sports). Default method=GET; pass " +
      "method=POST with body for the bulk identities endpoint. Responses are raw " +
      "upstream JSON (no { data: ... } wrapper as of v2 spec).\n\n" +
      "POLYMARKET — Tier 1 ($0.001/call):\n" +
      "  /pm/polymarket/markets                       (search,limit,offset)\n" +
      "  /pm/polymarket/markets/keyset                (cursor pagination)\n" +
      "  /pm/polymarket/events                        (limit,offset,tag)\n" +
      "  /pm/polymarket/events/keyset                 (cursor pagination)\n" +
      "  /pm/polymarket/crypto-updown\n" +
      "  /pm/polymarket/orderbooks                    (tokenId,limit)\n" +
      "  /pm/polymarket/trades                        (wallet,limit,start_ts,end_ts)\n" +
      "  /pm/polymarket/activity                      (user)\n" +
      "  /pm/polymarket/positions                     (wallet,limit)\n" +
      "  /pm/polymarket/leaderboard                   (limit,offset)\n" +
      "  /pm/polymarket/leaderboard/market/{conditionId}\n" +
      "  /pm/polymarket/cohorts/stats\n" +
      "  /pm/polymarket/market/{conditionId}/top-holders\n" +
      "  /pm/polymarket/market-price/{tokenId}\n" +
      "  /pm/polymarket/candlesticks/{conditionId}\n" +
      "  /pm/polymarket/candlesticks/token/{tokenId}\n" +
      "  /pm/polymarket/volume-chart/{conditionId}\n" +
      "  /pm/polymarket/markets/{tokenId}/volume\n" +
      "  /pm/polymarket/markets/{conditionId}/open_interest\n" +
      "  /pm/polymarket/uma/markets                   (state,limit,offset)\n" +
      "  /pm/polymarket/uma/market/{conditionId}\n\n" +
      "POLYMARKET — Tier 2 ($0.005/call) wallet analytics:\n" +
      "  /pm/polymarket/wallet/{wallet}\n" +
      "  /pm/polymarket/wallet/{wallet}/markets\n" +
      "  /pm/polymarket/wallet/{wallet}/similar\n" +
      "  /pm/polymarket/wallet/pnl/{wallet}\n" +
      "  /pm/polymarket/wallet/positions/{wallet}\n" +
      "  /pm/polymarket/wallet/volume-chart/{wallet}\n" +
      "  /pm/polymarket/wallets/profiles              (wallets=csv)\n" +
      "  /pm/polymarket/wallets/filter                (conditionId,side)\n" +
      "  /pm/polymarket/market/{conditionId}/smart-money\n" +
      "  /pm/polymarket/markets/smart-activity\n\n" +
      "POLYMARKET — Wallet Identity (Tier 2, v2 path shapes):\n" +
      "  /pm/polymarket/wallet/identity/{wallet}      (single — v2: path param, NOT ?wallet=)\n" +
      "  POST /pm/polymarket/wallet/identities        (bulk, body: {addresses:[..]} ≤200)\n" +
      "  /pm/polymarket/wallet/{address}/cluster      (cluster — v2: address path param)\n\n" +
      "CROSS-VENUE CANONICAL (Tier 1, v2):\n" +
      "  /pm/markets                                  (canonical containers, cross-venue Predexon IDs)\n" +
      "  /pm/markets/listings                         (venue-native flattened listings)\n" +
      "  /pm/outcomes/{predexon_id}                   (resolve canonical outcome → market + venues)\n\n" +
      "SPORTS (Tier 1, v2):\n" +
      "  /pm/sports/categories\n" +
      "  /pm/sports/markets                           (grouped by game)\n" +
      "  /pm/sports/markets/{game_id}                 (single game with all venue outcomes)\n" +
      "  /pm/sports/outcomes/{predexon_id}            (equivalent outcomes across venues)\n\n" +
      "KALSHI (Tier 1):\n" +
      "  /pm/kalshi/markets                           (search,limit)\n" +
      "  /pm/kalshi/trades                            (limit)\n" +
      "  /pm/kalshi/orderbooks                        (marketId)\n\n" +
      "LIMITLESS / OPINION / PREDICT.FUN (Tier 1):\n" +
      "  /pm/limitless/markets   |  /pm/limitless/orderbooks\n" +
      "  /pm/opinion/markets     |  /pm/opinion/orderbooks\n" +
      "  /pm/predictfun/markets  |  /pm/predictfun/orderbooks\n\n" +
      "DFLOW (trades Tier 1, wallet Tier 2):\n" +
      "  /pm/dflow/trades                             (wallet,limit)\n" +
      "  /pm/dflow/wallet/positions/{wallet}\n" +
      "  /pm/dflow/wallet/pnl/{wallet}\n\n" +
      "BINANCE FUTURES (Tier 2):\n" +
      "  /pm/binance/candles/{symbol}                 (interval,limit)\n" +
      "  /pm/binance/ticks/{symbol}                   (limit)\n\n" +
      "MATCHING (Tier 2):\n" +
      "  /pm/matching-markets                         (limit,offset)\n" +
      "  /pm/matching-markets/pairs\n" +
      "  /pm/markets/search                           (q required, limit, offset, venue)",
    proxyPath: "/pm/__dynamic__",
    method: "GET",
    params: [
      {
        name: "path",
        type: "string",
        description:
          "Endpoint path under /v1/pm. Either the literal path (e.g. '/pm/polymarket/orderbooks') " +
          "or with template segments substituted (e.g. '/pm/polymarket/wallet/identity/0xabc...'). " +
          "Leading /v1 must NOT be included — proxy adds it.",
        required: true,
      },
      {
        name: "method",
        type: "string",
        description:
          "HTTP method. Default 'GET'. Use 'POST' for /pm/polymarket/wallet/identities (bulk identity body).",
        required: false,
      },
      {
        name: "query",
        type: "string",
        description:
          'JSON object of query parameters as a string, e.g. \'{"limit":20,"search":"trump"}\'. ' +
          "Encoded into URL query string. Used for GET requests.",
        required: false,
      },
      {
        name: "body",
        type: "string",
        description:
          "JSON object as a string, used as request body for POST. " +
          'Example: \'{"addresses":["0xabc","0xdef"]}\' for bulk identities.',
        required: false,
      },
    ],
    pricing: {
      perUnit: "$0.001 or $0.005",
      unit: "request",
      minimum: "$0.001",
      maximum: "$0.005",
    },
    example: {
      input: { path: "/pm/polymarket/orderbooks", query: '{"tokenId":"0xabc...","limit":20}' },
      description: "Read a Polymarket orderbook by token id",
    },
  },
  // ---------------------------------------------------------------------------
  // BlockRun Markets — Realtime market data (stocks, crypto, FX, commodities)
  // ---------------------------------------------------------------------------
  {
    id: "stock_price",
    name: "Global Stock Realtime Price",
    partner: "BlockRun",
    category: "Market data",
    shortDescription: "Realtime stock quote (12 markets)",
    description:
      "Get realtime price for a listed equity across 12 global markets. " +
      "Call this for ANY request about a specific stock price, quote, or current trading value " +
      "on NYSE/Nasdaq, HKEX, TSE, KRX, LSE, XETRA, Euronext, Shanghai/Shenzhen, or Toronto. " +
      "Do NOT use browser or web scraping — this returns structured real-time data directly. " +
      "Returns: symbol, price, confidence interval, publish time, feed ID.",
    proxyPath: "/stocks/:market/price/:symbol",
    method: "GET",
    params: [
      {
        name: "market",
        type: "string",
        description:
          "Market code (lowercase): us (NYSE/Nasdaq/AMEX), hk (HKEX), jp (TSE), kr (KRX), " +
          "gb (LSE), de (XETRA), fr (Euronext Paris), nl (Euronext Amsterdam), ie (Irish SE), " +
          "lu (Luxembourg SE), cn (Shanghai/Shenzhen ETFs), ca (TSX).",
        required: true,
      },
      {
        name: "symbol",
        type: "string",
        description:
          "Ticker for the given market. Examples: AAPL (us), 0700-HK (hk), 7203 (jp), " +
          "005930 (kr), HSBA (gb), SAP (de), MC (fr), AIR (nl), VUSA (ie), MT (lu), 510310 (cn), HODL (ca).",
        required: true,
      },
      {
        name: "session",
        type: "string",
        description: "Optional session hint: pre, post, or on (regular hours).",
        required: false,
      },
    ],
    pricing: { perUnit: "$0.001", unit: "request", minimum: "$0.001", maximum: "$0.001" },
    example: {
      input: { market: "us", symbol: "AAPL" },
      description: "Get realtime Apple stock price",
    },
  },
  {
    id: "stock_history",
    name: "Global Stock OHLC History",
    partner: "BlockRun",
    category: "Market data",
    shortDescription: "OHLC bars (1m–monthly)",
    description:
      "Get historical OHLC (candlestick) bars for a listed equity across 12 global markets. " +
      "Use this for charting, backtesting, or any request about a stock's past price action. " +
      "Supports resolutions: 1, 5, 15, 60, 240 (minutes) and D, W, M (daily/weekly/monthly). " +
      "Returns: OHLC arrays (open, high, low, close, volume, timestamps).",
    proxyPath: "/stocks/:market/history/:symbol",
    method: "GET",
    params: [
      {
        name: "market",
        type: "string",
        description:
          "Market code (lowercase): us, hk, jp, kr, gb, de, fr, nl, ie, lu, cn, ca. " +
          "See stock_price for full market descriptions.",
        required: true,
      },
      {
        name: "symbol",
        type: "string",
        description: "Ticker for the given market (e.g. AAPL for us, 0700-HK for hk).",
        required: true,
      },
      {
        name: "resolution",
        type: "string",
        description:
          "Bar resolution: 1, 5, 15, 60, 240 (minutes) or D, W, M (daily/weekly/monthly). Default: D.",
        required: false,
      },
      {
        name: "from",
        type: "number",
        description: "Start time as Unix epoch seconds (required).",
        required: true,
      },
      {
        name: "to",
        type: "number",
        description: "End time as Unix epoch seconds. Default: now.",
        required: false,
      },
    ],
    pricing: { perUnit: "$0.001", unit: "request", minimum: "$0.001", maximum: "$0.001" },
    example: {
      input: { market: "us", symbol: "AAPL", resolution: "D", from: 1704067200 },
      description: "Get daily OHLC bars for AAPL starting Jan 1 2024",
    },
  },
  {
    id: "stock_list",
    name: "Global Stock Ticker List",
    partner: "BlockRun",
    category: "Market data",
    shortDescription: "Ticker search — free",
    description:
      "List and search supported tickers for a given stock market. Use this to resolve a company " +
      "name to a ticker before calling stock_price or stock_history. FREE — no x402 payment.",
    proxyPath: "/stocks/:market/list",
    method: "GET",
    params: [
      {
        name: "market",
        type: "string",
        description: "Market code: us, hk, jp, kr, gb, de, fr, nl, ie, lu, cn, ca.",
        required: true,
      },
      {
        name: "q",
        type: "string",
        description: "Optional search query to filter tickers by symbol or description.",
        required: false,
      },
      {
        name: "limit",
        type: "number",
        description: "Max results to return (default: 100, max: 2000).",
        required: false,
      },
    ],
    pricing: { perUnit: "free", unit: "request", minimum: "$0", maximum: "$0" },
    example: {
      input: { market: "us", q: "apple", limit: 5 },
      description: "Search US market for 'apple' tickers",
    },
  },
  {
    id: "crypto_price",
    name: "Crypto Realtime Price",
    partner: "BlockRun",
    category: "Market data",
    shortDescription: "Realtime crypto price — free",
    description:
      "Get realtime crypto price. Call this for ANY request about current crypto " +
      "prices (BTC, ETH, SOL, etc.). FREE — no x402 payment. Quote is always USD. " +
      "Do NOT use browser or web scraping — this returns structured real-time data directly.",
    proxyPath: "/crypto/price/:symbol",
    method: "GET",
    params: [
      {
        name: "symbol",
        type: "string",
        description:
          "Crypto pair in BASE-QUOTE form. Examples: BTC-USD, ETH-USD, SOL-USD, DOGE-USD. " +
          "Quote is always USD.",
        required: true,
      },
    ],
    pricing: { perUnit: "free", unit: "request", minimum: "$0", maximum: "$0" },
    example: {
      input: { symbol: "BTC-USD" },
      description: "Get realtime Bitcoin price",
    },
  },
  {
    id: "fx_price",
    name: "Foreign Exchange Realtime Price",
    partner: "BlockRun",
    category: "Market data",
    shortDescription: "Realtime FX rate — free",
    description:
      "Get realtime FX rate. Call this for ANY request about currency exchange rates. " +
      "FREE — no x402 payment. Do NOT use browser or web scraping.",
    proxyPath: "/fx/price/:symbol",
    method: "GET",
    params: [
      {
        name: "symbol",
        type: "string",
        description:
          "Currency pair in BASE-QUOTE form. Examples: EUR-USD, GBP-USD, JPY-USD, CNY-USD.",
        required: true,
      },
    ],
    pricing: { perUnit: "free", unit: "request", minimum: "$0", maximum: "$0" },
    example: {
      input: { symbol: "EUR-USD" },
      description: "Get realtime EUR/USD exchange rate",
    },
  },
  {
    id: "commodity_price",
    name: "Commodity Realtime Price",
    partner: "BlockRun",
    category: "Market data",
    shortDescription: "Realtime commodity spot — free",
    description:
      "Get realtime commodity spot price (gold, silver, platinum, etc.). " +
      "FREE — no x402 payment. Do NOT use browser or web scraping.",
    proxyPath: "/commodity/price/:symbol",
    method: "GET",
    params: [
      {
        name: "symbol",
        type: "string",
        description:
          "Commodity code in BASE-USD form. Examples: XAU-USD (gold), XAG-USD (silver), XPT-USD (platinum).",
        required: true,
      },
    ],
    pricing: { perUnit: "free", unit: "request", minimum: "$0", maximum: "$0" },
    example: {
      input: { symbol: "XAU-USD" },
      description: "Get realtime gold spot price",
    },
  },
  // ---------------------------------------------------------------------------
  // BlockRun — Image & Video generation
  // ---------------------------------------------------------------------------
  {
    id: "image_generation",
    name: "Image Generation",
    partner: "BlockRun",
    category: "Image & Video",
    shortDescription: "8 image models (DALL-E, Flux, Grok, ...)",
    description:
      "Generate an image from a text prompt. Models available: google/nano-banana (default), " +
      "google/nano-banana-pro (up to 4K), openai/gpt-image-1, openai/dall-e-3, " +
      "black-forest/flux-1.1-pro, xai/grok-imagine-image, xai/grok-imagine-image-pro, " +
      "zai/cogview-4. Returns a local http://localhost:8402/images/<file>.png URL.",
    proxyPath: "/images/generations",
    method: "POST",
    params: [
      {
        name: "prompt",
        type: "string",
        description: "Text prompt describing the desired image.",
        required: true,
      },
      {
        name: "model",
        type: "string",
        description:
          "Full model ID (e.g. 'google/nano-banana', 'openai/dall-e-3'). Default: google/nano-banana.",
        required: false,
      },
      {
        name: "size",
        type: "string",
        description:
          "Image size, e.g. '1024x1024', '1792x1024', '4096x4096'. Model-dependent — see image model table.",
        required: false,
      },
      {
        name: "n",
        type: "number",
        description: "Number of images to generate (default 1, max 4).",
        required: false,
      },
    ],
    pricing: {
      perUnit: "$0.015–$0.15",
      unit: "image",
      minimum: "$0.015 (cogview-4)",
      maximum: "$0.15 (nano-banana-pro 4K)",
    },
    example: {
      input: { model: "google/nano-banana", prompt: "a golden retriever surfing on a wave" },
      description: "Generate an image with Nano Banana",
    },
  },
  {
    id: "image_edit",
    name: "Image Edit / Inpainting",
    partner: "BlockRun",
    category: "Image & Video",
    shortDescription: "Edit existing image (gpt-image-1)",
    description:
      "Edit or re-style an existing image via openai/gpt-image-1. " +
      "Supply `image` as a data URI, https URL, or local file path; optional `mask` for inpainting.",
    proxyPath: "/images/image2image",
    method: "POST",
    params: [
      {
        name: "prompt",
        type: "string",
        description: "Text prompt describing how to edit the image.",
        required: true,
      },
      {
        name: "image",
        type: "string",
        description: "Source image — data URI, https URL, or local path (~/... or /abs/path).",
        required: true,
      },
      {
        name: "mask",
        type: "string",
        description: "Optional inpainting mask in the same formats as `image`.",
        required: false,
      },
    ],
    pricing: {
      perUnit: "$0.02–$0.04",
      unit: "image",
      minimum: "$0.02",
      maximum: "$0.04 (1536x1024)",
    },
    example: {
      input: { prompt: "make the sky sunset orange", image: "~/Pictures/beach.png" },
      description: "Edit a local image with gpt-image-1",
    },
  },
  {
    id: "video_generation",
    name: "Video Generation",
    partner: "BlockRun",
    category: "Image & Video",
    shortDescription: "Grok Imagine + Seedance, 5–10s (720p + audio on t2v)",
    description:
      "Generate a short video (5–10s) via xai/grok-imagine-video or bytedance/seedance-1.5-pro " +
      "(default, cheapest) / seedance-2.0-fast / seedance-2.0. Seedance defaults to 720p with " +
      "synced audio for text-to-video. Seedance 2.0 variants accept optional " +
      "`real_face_asset_id` (`ta_xxxxxxxx`) for BytePlus RealFace character consistency — " +
      "mutually exclusive with `image_url`. Async — upstream polling takes 30–120 seconds. " +
      "Returns a local http://localhost:8402/videos/<file>.mp4 URL.",
    proxyPath: "/videos/generations",
    method: "POST",
    params: [
      {
        name: "prompt",
        type: "string",
        description: "Text prompt describing the video.",
        required: true,
      },
      {
        name: "model",
        type: "string",
        description:
          "Full model ID. Options: bytedance/seedance-1.5-pro (default), bytedance/seedance-2.0-fast, " +
          "bytedance/seedance-2.0, xai/grok-imagine-video.",
        required: false,
      },
      {
        name: "duration_seconds",
        type: "number",
        description: "Clip length in seconds. Supported: 5, 8, 10. Default depends on model.",
        required: false,
      },
      {
        name: "image_url",
        type: "string",
        description:
          "Optional first-frame image URL for image-to-video. Cheaper per-token on 2.0 variants. " +
          "Cannot be combined with `real_face_asset_id`.",
        required: false,
      },
      {
        name: "real_face_asset_id",
        type: "string",
        description:
          "Optional BytePlus RealFace asset id (format `ta_xxxxxxxx`) for real-person character " +
          "consistency across frames. Seedance 2.0 Fast / 2.0 Pro only — rejected on 1.5 Pro. " +
          "Asset ids come from token360's H5 verification flow.",
        required: false,
      },
    ],
    pricing: {
      perUnit: "$0.05–$0.30",
      unit: "second",
      minimum: "$0.42 (grok-imagine-video 8s) / $0.46 (seedance-1.5-pro 5s)",
      maximum: "$2.98 (seedance-2.0 10s text-to-video)",
    },
    example: {
      input: { model: "bytedance/seedance-1.5-pro", prompt: "a cat waving", duration_seconds: 5 },
      description: "Generate a 5-second Seedance video (720p + audio defaults)",
    },
  },
  // ---------------------------------------------------------------------------
  // BlockRun — Phone & Voice (Twilio number intelligence + Bland.ai voice calls)
  // ---------------------------------------------------------------------------
  {
    id: "phone_lookup",
    name: "Phone Number Lookup",
    partner: "BlockRun (Twilio)",
    category: "Communications",
    shortDescription: "Carrier + line type for an E.164 number",
    description:
      "Look up carrier name, line type (mobile / landline / voip), and country for any phone number. " +
      "Use to verify a phone number, detect VoIP/spam patterns, or route messages. " +
      "Does NOT place a call — purely metadata. " +
      "Returns: carrier name, line_type, country, mobile_country_code, mobile_network_code.",
    proxyPath: "/phone/lookup",
    method: "POST",
    params: [
      {
        name: "phoneNumber",
        type: "string",
        description: "Phone number in E.164 format, e.g. '+14155552671'.",
        required: true,
      },
    ],
    pricing: { perUnit: "$0.01", unit: "lookup", minimum: "$0.01", maximum: "$0.01" },
    example: {
      input: { phoneNumber: "+14155552671" },
      description: "Check carrier and line type for a US number",
    },
  },
  {
    id: "phone_lookup_fraud",
    name: "Phone Fraud Risk Lookup",
    partner: "BlockRun (Twilio)",
    category: "Communications",
    shortDescription: "SIM swap + call-forwarding fraud signals",
    description:
      "Detect fraud signals on a phone number: SIM swap recency, call forwarding status, line-type-intelligence. " +
      "Use BEFORE sending sensitive SMS codes or initiating account-recovery flows. " +
      "Returns: carrier + line type (same as lookup) PLUS sim_swap.last_sim_swap and call_forwarding signals.",
    proxyPath: "/phone/lookup/fraud",
    method: "POST",
    params: [
      {
        name: "phoneNumber",
        type: "string",
        description: "Phone number in E.164 format, e.g. '+14155552671'.",
        required: true,
      },
    ],
    pricing: { perUnit: "$0.05", unit: "lookup", minimum: "$0.05", maximum: "$0.05" },
    example: {
      input: { phoneNumber: "+14155552671" },
      description: "Check SIM-swap + forwarding fraud risk for an account-recovery candidate",
    },
  },
  {
    id: "phone_numbers_buy",
    name: "Provision Phone Number",
    partner: "BlockRun (Twilio)",
    category: "Communications",
    shortDescription: "Buy a US/CA number (30-day lease)",
    description:
      "Purchase a US or Canadian phone number tied to the wallet, leased for 30 days. " +
      "Use only when the user has explicitly asked to acquire a phone number. " +
      "Number is bound to the wallet's payer address and can be used as 'from' in voice_call. " +
      "Returns: phone_number (E.164), expires_at (ISO), chain.",
    proxyPath: "/phone/numbers/buy",
    method: "POST",
    params: [
      {
        name: "country",
        type: "string",
        description: "Country code: 'US' or 'CA'.",
        required: true,
      },
      {
        name: "areaCode",
        type: "string",
        description: "Optional 3-digit area code preference (e.g. '415'). Best-effort match.",
        required: false,
      },
    ],
    pricing: { perUnit: "$5.00", unit: "number (30 days)", minimum: "$5.00", maximum: "$5.00" },
    example: {
      input: { country: "US", areaCode: "415" },
      description: "Buy a San Francisco area-code number for 30 days",
    },
  },
  {
    id: "phone_numbers_renew",
    name: "Renew Phone Number Lease",
    partner: "BlockRun (Twilio)",
    category: "Communications",
    shortDescription: "Extend a number's lease 30 days",
    description:
      "Extend an existing wallet-owned number's lease by 30 days. " +
      "Use before expiry to keep the number; numbers not renewed are released back to the pool. " +
      "Returns: phone_number, new expires_at (ISO).",
    proxyPath: "/phone/numbers/renew",
    method: "POST",
    params: [
      {
        name: "phoneNumber",
        type: "string",
        description: "E.164 number you currently own (from phone_numbers_list).",
        required: true,
      },
    ],
    pricing: { perUnit: "$5.00", unit: "renewal (30 days)", minimum: "$5.00", maximum: "$5.00" },
    example: {
      input: { phoneNumber: "+14155551234" },
      description: "Extend a number's lease another 30 days",
    },
  },
  {
    id: "phone_numbers_list",
    name: "List Wallet's Phone Numbers",
    partner: "BlockRun (Twilio)",
    category: "Communications",
    shortDescription: "Wallet's active numbers + expiry",
    description:
      "List phone numbers currently owned by the calling wallet, with lease expiry timestamps. " +
      "Use to see what numbers are available as 'from' in voice_call, or to decide which to renew/release. " +
      "Returns: array of { phone_number, expires_at, country, chain }.",
    proxyPath: "/phone/numbers/list",
    method: "POST",
    params: [],
    pricing: { perUnit: "$0.001", unit: "request", minimum: "$0.001", maximum: "$0.001" },
    example: {
      input: {},
      description: "List all numbers owned by this wallet",
    },
  },
  {
    id: "phone_numbers_release",
    name: "Release Phone Number",
    partner: "BlockRun (Twilio)",
    category: "Communications",
    shortDescription: "Release a number (free)",
    description:
      "Release a wallet-owned phone number back to the pool before its lease expires. " +
      "Use when the user explicitly asks to give up a number; no refund. " +
      "Returns: { released: true, phone_number }.",
    proxyPath: "/phone/numbers/release",
    method: "POST",
    params: [
      {
        name: "phoneNumber",
        type: "string",
        description: "E.164 number you own (from phone_numbers_list).",
        required: true,
      },
    ],
    pricing: { perUnit: "free", unit: "release", minimum: "$0", maximum: "$0" },
    example: {
      input: { phoneNumber: "+14155551234" },
      description: "Release a number",
    },
  },
  {
    id: "voice_call",
    name: "AI Voice Call (Outbound)",
    partner: "BlockRun (Bland.ai)",
    category: "Communications",
    shortDescription: "Bland.ai outbound call, up to 30 min",
    description:
      "Place a REAL outbound phone call via Bland.ai's AI agent. The agent speaks the supplied task, " +
      "listens to the recipient, and produces a transcript + optional recording. " +
      "⚠️ SAFETY: This places a real call to a real phone number — only invoke when the user has explicitly asked " +
      "to place a call. Server enforces an emergency-number blocklist. Initiation is synchronous: returns " +
      "{ call_id, poll_url, status } immediately; the call itself runs in the cloud for up to 30 minutes. " +
      "Poll via voice_status to retrieve transcript/recording.",
    proxyPath: "/voice/call",
    method: "POST",
    params: [
      {
        name: "to",
        type: "string",
        description: "Destination phone number in E.164 format (e.g. '+14155552671').",
        required: true,
      },
      {
        name: "task",
        type: "string",
        description:
          "What the AI should say or accomplish during the call (free-form natural language).",
        required: true,
      },
      {
        name: "from",
        type: "string",
        description:
          "Optional caller ID — must be a wallet-owned number from phone_numbers_list. If omitted, Bland.ai picks a default outbound number.",
        required: false,
      },
      {
        name: "voice",
        type: "string",
        description:
          "Voice preset: nat (default), josh, maya, june, paige, derek, florian, or a custom Bland.ai voice ID.",
        required: false,
      },
      {
        name: "max_duration",
        type: "number",
        description: "Maximum call length in minutes (1–30, default 5).",
        required: false,
      },
      {
        name: "language",
        type: "string",
        description: "Spoken language ISO code, e.g. 'en-US' (default), 'es-ES', 'zh-CN'.",
        required: false,
      },
    ],
    pricing: {
      perUnit: "$0.54",
      unit: "call (≤30 min)",
      minimum: "$0.54",
      maximum: "$0.54",
    },
    example: {
      input: {
        to: "+14155552671",
        task: "Call and confirm the 3pm Thursday meeting; reschedule if they can't make it.",
        max_duration: 5,
      },
      description: "Call to confirm an appointment",
    },
  },
  {
    id: "voice_status",
    name: "Voice Call Status",
    partner: "BlockRun (Bland.ai)",
    category: "Communications",
    shortDescription: "Poll status, transcript, recording",
    description:
      "Poll the status of a voice call placed via voice_call. Free — no x402 payment. " +
      "Returns: status (queued|in_progress|completed|failed), transcript array, duration_seconds, " +
      "recording_url (when completed), error (when failed). Poll every 10–30s while in_progress.",
    proxyPath: "/voice/call/:callId",
    method: "GET",
    params: [
      {
        name: "callId",
        type: "string",
        description: "Call ID returned by voice_call.",
        required: true,
      },
    ],
    pricing: { perUnit: "free", unit: "poll", minimum: "$0", maximum: "$0" },
    example: {
      input: { callId: "call_abc123" },
      description: "Check on a placed call",
    },
  },
];

/**
 * Get a partner service by ID.
 */
export function getPartnerService(id: string): PartnerServiceDefinition | undefined {
  return PARTNER_SERVICES.find((s) => s.id === id);
}
