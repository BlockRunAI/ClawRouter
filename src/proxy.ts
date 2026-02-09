/**
 * Local x402 Proxy Server
 *
 * Sits between OpenClaw's pi-ai (which makes standard OpenAI-format requests)
 * and BlockRun's API (which requires x402 micropayments).
 *
 * Flow:
 *   pi-ai → http://localhost:{port}/v1/chat/completions
 *        → proxy forwards to https://blockrun.ai/api/v1/chat/completions
 *        → gets 402 → @x402/fetch signs payment → retries
 *        → streams response back to pi-ai
 *
 * Optimizations (v0.3.0):
 *   - SSE heartbeat: for streaming requests, sends headers + heartbeat immediately
 *     before the x402 flow, preventing OpenClaw's 10-15s timeout from firing.
 *   - Response dedup: hashes request bodies and caches responses for 30s,
 *     preventing double-charging when OpenClaw retries after timeout.
 *   - Payment cache: after first 402, pre-signs subsequent requests to skip
 *     the 402 round trip (~200ms savings per request).
 *   - Smart routing: when model is "blockrun/auto", classify query and pick cheapest model.
 *   - Usage logging: log every request as JSON line to ~/.openclaw/blockrun/logs/
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { privateKeyToAccount } from "viem/accounts";
import { createPaymentFetch, type PreAuthParams } from "./x402.js";
import {
  route,
  getFallbackChain,
  DEFAULT_ROUTING_CONFIG,
  type RouterOptions,
  type RoutingDecision,
  type RoutingConfig,
  type ModelPricing,
} from "./router/index.js";
import { BLOCKRUN_MODELS, resolveModelAlias } from "./models.js";
import { logUsage, type UsageEntry } from "./logger.js";
import { getStats, generateDashboardHtml } from "./stats.js";
import { RequestDeduplicator } from "./dedup.js";
import { BalanceMonitor } from "./balance.js";
import { InsufficientFundsError, EmptyWalletError } from "./errors.js";
import { USER_AGENT } from "./version.js";

const BLOCKRUN_API = "https://blockrun.ai/api";
const AUTO_MODEL = "blockrun/auto";
const AUTO_MODEL_SHORT = "auto"; // OpenClaw strips provider prefix
const HEARTBEAT_INTERVAL_MS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000; // 3 minutes (allows for on-chain tx + LLM response)
const DEFAULT_PORT = 8402;
const MAX_FALLBACK_ATTEMPTS = 3; // Maximum models to try in fallback chain
const HEALTH_CHECK_TIMEOUT_MS = 2_000; // Timeout for checking existing proxy
// Extra buffer for balance check (on top of estimateAmount's 20% buffer)
// Total effective buffer: 1.2 * 1.5 = 1.8x (80% safety margin)
// This prevents x402 payment failures after streaming headers are sent,
// which would trigger OpenClaw's 5-24 hour billing cooldown.
const BALANCE_CHECK_BUFFER = 1.5;

/**
 * Get the proxy port from environment variable or default.
 */
export function getProxyPort(): number {
  const envPort = process.env.BLOCKRUN_PROXY_PORT;
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (!isNaN(parsed) && parsed > 0 && parsed < 65536) {
      return parsed;
    }
  }
  return DEFAULT_PORT;
}

/**
 * Check if a proxy is already running on the given port.
 * Returns the wallet address if running, undefined otherwise.
 */
async function checkExistingProxy(port: number): Promise<string | undefined> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      const data = (await response.json()) as { status?: string; wallet?: string };
      if (data.status === "ok" && data.wallet) {
        return data.wallet;
      }
    }
    return undefined;
  } catch {
    clearTimeout(timeoutId);
    return undefined;
  }
}

/**
 * Error patterns that indicate a provider-side issue (not user's fault).
 * These errors should trigger fallback to the next model in the chain.
 */
const PROVIDER_ERROR_PATTERNS = [
  /billing/i,
  /insufficient.*balance/i,
  /credits/i,
  /quota.*exceeded/i,
  /rate.*limit/i,
  /model.*unavailable/i,
  /model.*not.*available/i,
  /service.*unavailable/i,
  /capacity/i,
  /overloaded/i,
  /temporarily.*unavailable/i,
  /api.*key.*invalid/i,
  /authentication.*failed/i,
];

/**
 * HTTP status codes that indicate provider issues worth retrying with fallback.
 */
const FALLBACK_STATUS_CODES = [
  400, // Bad request - sometimes used for billing errors
  401, // Unauthorized - provider API key issues
  402, // Payment required - but from upstream, not x402
  403, // Forbidden - provider restrictions
  429, // Rate limited
  500, // Internal server error
  502, // Bad gateway
  503, // Service unavailable
  504, // Gateway timeout
];

/**
 * Check if an error response indicates a provider issue that should trigger fallback.
 */
function isProviderError(status: number, body: string): boolean {
  // Check status code first
  if (!FALLBACK_STATUS_CODES.includes(status)) {
    return false;
  }

  // For 5xx errors, always fallback
  if (status >= 500) {
    return true;
  }

  // For 4xx errors, check the body for known provider error patterns
  return PROVIDER_ERROR_PATTERNS.some((pattern) => pattern.test(body));
}

/**
 * Normalize messages for Google models.
 * Google's Gemini API requires the first non-system message to be from "user".
 * If conversation starts with "assistant"/"model", prepend a placeholder user message.
 */
type ChatMessage = { role: string; content: string | unknown };

function normalizeMessagesForGoogle(messages: ChatMessage[]): ChatMessage[] {
  if (!messages || messages.length === 0) return messages;

  // Find first non-system message
  let firstNonSystemIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== "system") {
      firstNonSystemIdx = i;
      break;
    }
  }

  // If no non-system messages, return as-is
  if (firstNonSystemIdx === -1) return messages;

  const firstRole = messages[firstNonSystemIdx].role;

  // If first non-system message is already "user", no change needed
  if (firstRole === "user") return messages;

  // If first non-system message is "assistant" or "model", prepend a user message
  if (firstRole === "assistant" || firstRole === "model") {
    const normalized = [...messages];
    normalized.splice(firstNonSystemIdx, 0, {
      role: "user",
      content: "(continuing conversation)",
    });
    return normalized;
  }

  return messages;
}

/**
 * Check if a model is a Google model that requires message normalization.
 */
function isGoogleModel(modelId: string): boolean {
  return modelId.startsWith("google/") || modelId.startsWith("gemini");
}

// Kimi/Moonshot models use special Unicode tokens for thinking boundaries.
// Pattern: <｜begin▁of▁thinking｜>content<｜end▁of▁thinking｜>
// The ｜ is fullwidth vertical bar (U+FF5C), ▁ is lower one-eighth block (U+2581).

// Match full Kimi thinking blocks: <｜begin...｜>content<｜end...｜>
const KIMI_BLOCK_RE = /<[｜|][^<>]*begin[^<>]*[｜|]>[\s\S]*?<[｜|][^<>]*end[^<>]*[｜|]>/gi;

// Match standalone Kimi tokens like <｜end▁of▁thinking｜>
const KIMI_TOKEN_RE = /<[｜|][^<>]*[｜|]>/g;

// Standard thinking tags that may leak through from various models
const THINKING_TAG_RE = /<\s*\/?\s*(?:think(?:ing)?|thought|antthinking)\b[^>]*>/gi;

// Full thinking blocks: <think>content</think>
const THINKING_BLOCK_RE =
  /<\s*(?:think(?:ing)?|thought|antthinking)\b[^>]*>[\s\S]*?<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;

/**
 * Strip thinking tokens and blocks from model response content.
 * Handles both Kimi-style Unicode tokens and standard XML-style tags.
 */
function stripThinkingTokens(content: string): string {
  if (!content) return content;
  // Strip full Kimi thinking blocks first (begin...end with content)
  let cleaned = content.replace(KIMI_BLOCK_RE, "");
  // Strip remaining standalone Kimi tokens
  cleaned = cleaned.replace(KIMI_TOKEN_RE, "");
  // Strip full thinking blocks (<think>...</think>)
  cleaned = cleaned.replace(THINKING_BLOCK_RE, "");
  // Strip remaining standalone thinking tags
  cleaned = cleaned.replace(THINKING_TAG_RE, "");
  return cleaned;
}

/** Callback info for low balance warning */
export type LowBalanceInfo = {
  balanceUSD: string;
  walletAddress: string;
};

/** Callback info for insufficient funds error */
export type InsufficientFundsInfo = {
  balanceUSD: string;
  requiredUSD: string;
  walletAddress: string;
};

export type ProxyOptions = {
  walletKey: string;
  apiBase?: string;
  /** Port to listen on (default: 8402) */
  port?: number;
  routingConfig?: Partial<RoutingConfig>;
  /** Request timeout in ms (default: 180000 = 3 minutes). Covers on-chain tx + LLM response. */
  requestTimeoutMs?: number;
  /** Skip balance checks (for testing only). Default: false */
  skipBalanceCheck?: boolean;
  onReady?: (port: number) => void;
  onError?: (error: Error) => void;
  onPayment?: (info: { model: string; amount: string; network: string }) => void;
  onRouted?: (decision: RoutingDecision) => void;
  /** Called when balance drops below $1.00 (warning, request still proceeds) */
  onLowBalance?: (info: LowBalanceInfo) => void;
  /** Called when balance is insufficient for a request (request fails) */
  onInsufficientFunds?: (info: InsufficientFundsInfo) => void;
};

export type ProxyHandle = {
  port: number;
  baseUrl: string;
  walletAddress: string;
  balanceMonitor: BalanceMonitor;
  close: () => Promise<void>;
};

/**
 * Build model pricing map from BLOCKRUN_MODELS.
 */
function buildModelPricing(): Map<string, ModelPricing> {
  const map = new Map<string, ModelPricing>();
  for (const m of BLOCKRUN_MODELS) {
    if (m.id === AUTO_MODEL) continue; // skip meta-model
    map.set(m.id, { inputPrice: m.inputPrice, outputPrice: m.outputPrice });
  }
  return map;
}

/**
 * Merge partial routing config overrides with defaults.
 */
function mergeRoutingConfig(overrides?: Partial<RoutingConfig>): RoutingConfig {
  if (!overrides) return DEFAULT_ROUTING_CONFIG;
  return {
    ...DEFAULT_ROUTING_CONFIG,
    ...overrides,
    classifier: { ...DEFAULT_ROUTING_CONFIG.classifier, ...overrides.classifier },
    scoring: { ...DEFAULT_ROUTING_CONFIG.scoring, ...overrides.scoring },
    tiers: { ...DEFAULT_ROUTING_CONFIG.tiers, ...overrides.tiers },
    overrides: { ...DEFAULT_ROUTING_CONFIG.overrides, ...overrides.overrides },
  };
}

/**
 * Estimate USDC cost for a request based on model pricing.
 * Returns amount string in USDC smallest unit (6 decimals) or undefined if unknown.
 */
function estimateAmount(
  modelId: string,
  bodyLength: number,
  maxTokens: number,
): string | undefined {
  const model = BLOCKRUN_MODELS.find((m) => m.id === modelId);
  if (!model) return undefined;

  // Rough estimate: ~4 chars per token for input
  const estimatedInputTokens = Math.ceil(bodyLength / 4);
  const estimatedOutputTokens = maxTokens || model.maxOutput || 4096;

  const costUsd =
    (estimatedInputTokens / 1_000_000) * model.inputPrice +
    (estimatedOutputTokens / 1_000_000) * model.outputPrice;

  // Convert to USDC 6-decimal integer, add 20% buffer for estimation error
  // Minimum 100 ($0.0001) to avoid zero-amount rejections
  const amountMicros = Math.max(100, Math.ceil(costUsd * 1.2 * 1_000_000));
  return amountMicros.toString();
}

/**
 * Start the local x402 proxy server.
 *
 * If a proxy is already running on the target port, reuses it instead of failing.
 * Port can be configured via BLOCKRUN_PROXY_PORT environment variable.
 *
 * Returns a handle with the assigned port, base URL, and a close function.
 */
export async function startProxy(options: ProxyOptions): Promise<ProxyHandle> {
  const apiBase = options.apiBase ?? BLOCKRUN_API;

  // Determine port: options.port > env var > default
  const listenPort = options.port ?? getProxyPort();

  // Check if a proxy is already running on this port
  const existingWallet = await checkExistingProxy(listenPort);
  if (existingWallet) {
    // Proxy already running — reuse it instead of failing with EADDRINUSE
    const account = privateKeyToAccount(options.walletKey as `0x${string}`);
    const balanceMonitor = new BalanceMonitor(account.address);
    const baseUrl = `http://127.0.0.1:${listenPort}`;

    // Verify the existing proxy is using the same wallet (or warn if different)
    if (existingWallet !== account.address) {
      console.warn(
        `[ClawRouter] Existing proxy on port ${listenPort} uses wallet ${existingWallet}, but current config uses ${account.address}. Reusing existing proxy.`,
      );
    }

    options.onReady?.(listenPort);

    return {
      port: listenPort,
      baseUrl,
      walletAddress: existingWallet,
      balanceMonitor,
      close: async () => {
        // No-op: we didn't start this proxy, so we shouldn't close it
      },
    };
  }

  // Create x402 payment-enabled fetch from wallet private key
  const account = privateKeyToAccount(options.walletKey as `0x${string}`);
  const { fetch: payFetch } = createPaymentFetch(options.walletKey as `0x${string}`);

  // Create balance monitor for pre-request checks
  const balanceMonitor = new BalanceMonitor(account.address);

  // Build router options (100% local — no external API calls for routing)
  const routingConfig = mergeRoutingConfig(options.routingConfig);
  const modelPricing = buildModelPricing();
  const routerOpts: RouterOptions = {
    config: routingConfig,
    modelPricing,
  };

  // Request deduplicator (shared across all requests)
  const deduplicator = new RequestDeduplicator();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Health check with optional balance info
    if (req.url === "/health" || req.url?.startsWith("/health?")) {
      const url = new URL(req.url, "http://localhost");
      const full = url.searchParams.get("full") === "true";

      const response: Record<string, unknown> = {
        status: "ok",
        wallet: account.address,
      };

      if (full) {
        try {
          const balanceInfo = await balanceMonitor.checkBalance();
          response.balance = balanceInfo.balanceUSD;
          response.isLow = balanceInfo.isLow;
          response.isEmpty = balanceInfo.isEmpty;
        } catch {
          response.balanceError = "Could not fetch balance";
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
      return;
    }

    // Dashboard endpoint - serves HTML analytics page
    if (req.url === "/dashboard" || req.url?.startsWith("/dashboard?")) {
      try {
        const url = new URL(req.url, "http://localhost");
        const days = parseInt(url.searchParams.get("days") || "7", 10);
        const stats = await getStats(Math.min(days, 30));
        const html = generateDashboardHtml(stats);

        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
        });
        res.end(html);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: `Failed to generate dashboard: ${err instanceof Error ? err.message : String(err)}`,
          }),
        );
      }
      return;
    }

    // Stats API endpoint - returns JSON for programmatic access
    if (req.url === "/stats" || req.url?.startsWith("/stats?")) {
      try {
        const url = new URL(req.url, "http://localhost");
        const days = parseInt(url.searchParams.get("days") || "7", 10);
        const stats = await getStats(Math.min(days, 30));

        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
        });
        res.end(JSON.stringify(stats, null, 2));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: `Failed to get stats: ${err instanceof Error ? err.message : String(err)}`,
          }),
        );
      }
      return;
    }

    // Only proxy paths starting with /v1
    if (!req.url?.startsWith("/v1")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    try {
      await proxyRequest(
        req,
        res,
        apiBase,
        payFetch,
        options,
        routerOpts,
        deduplicator,
        balanceMonitor,
      );
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      options.onError?.(error);

      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: `Proxy error: ${error.message}`, type: "proxy_error" },
          }),
        );
      } else if (!res.writableEnded) {
        // Headers already sent (streaming) — send error as SSE event
        res.write(
          `data: ${JSON.stringify({ error: { message: error.message, type: "proxy_error" } })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
      }
    }
  });

  // Listen on configured port (already determined above)
  return new Promise<ProxyHandle>((resolve, reject) => {
    server.on("error", (err: NodeJS.ErrnoException) => {
      // Handle EADDRINUSE gracefully — proxy is already running
      if (err.code === "EADDRINUSE") {
        // Port is in use, which means a proxy is already running.
        // This can happen when openclaw logs triggers plugin reload.
        // Silently reuse the existing proxy instead of failing.
        const baseUrl = `http://127.0.0.1:${listenPort}`;
        options.onReady?.(listenPort);
        resolve({
          port: listenPort,
          baseUrl,
          walletAddress: account.address,
          balanceMonitor,
          close: async () => {
            // No-op: we didn't start this proxy, so we shouldn't close it
          },
        });
        return;
      }
      reject(err);
    });

    server.listen(listenPort, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      const port = addr.port;
      const baseUrl = `http://127.0.0.1:${port}`;

      options.onReady?.(port);

      resolve({
        port,
        baseUrl,
        walletAddress: account.address,
        balanceMonitor,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

/** Result of attempting a model request */
type ModelRequestResult = {
  success: boolean;
  response?: Response;
  errorBody?: string;
  errorStatus?: number;
  isProviderError?: boolean;
};

/**
 * Attempt a request with a specific model.
 * Returns the response or error details for fallback decision.
 */
async function tryModelRequest(
  upstreamUrl: string,
  method: string,
  headers: Record<string, string>,
  body: Buffer,
  modelId: string,
  maxTokens: number,
  payFetch: (
    input: RequestInfo | URL,
    init?: RequestInit,
    preAuth?: PreAuthParams,
  ) => Promise<Response>,
  balanceMonitor: BalanceMonitor,
  signal: AbortSignal,
): Promise<ModelRequestResult> {
  // Update model in body and normalize messages for Google models
  let requestBody = body;
  try {
    const parsed = JSON.parse(body.toString()) as Record<string, unknown>;
    parsed.model = modelId;

    // Normalize messages for Google models (first non-system message must be "user")
    if (isGoogleModel(modelId) && Array.isArray(parsed.messages)) {
      parsed.messages = normalizeMessagesForGoogle(parsed.messages as ChatMessage[]);
    }

    requestBody = Buffer.from(JSON.stringify(parsed));
  } catch {
    // If body isn't valid JSON, use as-is
  }

  // Estimate cost for pre-auth
  const estimated = estimateAmount(modelId, requestBody.length, maxTokens);
  const preAuth: PreAuthParams | undefined = estimated ? { estimatedAmount: estimated } : undefined;

  try {
    const response = await payFetch(
      upstreamUrl,
      {
        method,
        headers,
        body: requestBody.length > 0 ? new Uint8Array(requestBody) : undefined,
        signal,
      },
      preAuth,
    );

    // Check for provider errors
    if (response.status !== 200) {
      // Clone response to read body without consuming it
      const errorBody = await response.text();
      const isProviderErr = isProviderError(response.status, errorBody);

      return {
        success: false,
        errorBody,
        errorStatus: response.status,
        isProviderError: isProviderErr,
      };
    }

    return { success: true, response };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      errorBody: errorMsg,
      errorStatus: 500,
      isProviderError: true, // Network errors are retryable
    };
  }
}

/**
 * Proxy a single request through x402 payment flow to BlockRun API.
 *
 * Optimizations applied in order:
 *   1. Dedup check — if same request body seen within 30s, replay cached response
 *   2. Streaming heartbeat — for stream:true, send 200 + heartbeats immediately
 *   3. Payment pre-auth — estimate USDC amount and pre-sign to skip 402 round trip
 *   4. Smart routing — when model is "blockrun/auto", pick cheapest capable model
 *   5. Fallback chain — on provider errors, try next model in tier's fallback list
 */
async function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  apiBase: string,
  payFetch: (
    input: RequestInfo | URL,
    init?: RequestInit,
    preAuth?: PreAuthParams,
  ) => Promise<Response>,
  options: ProxyOptions,
  routerOpts: RouterOptions,
  deduplicator: RequestDeduplicator,
  balanceMonitor: BalanceMonitor,
): Promise<void> {
  const startTime = Date.now();

  // Build upstream URL: /v1/chat/completions → https://blockrun.ai/api/v1/chat/completions
  const upstreamUrl = `${apiBase}${req.url}`;

  // Collect request body
  const bodyChunks: Buffer[] = [];
  for await (const chunk of req) {
    bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  let body = Buffer.concat(bodyChunks);

  // --- Smart routing ---
  let routingDecision: RoutingDecision | undefined;
  let isStreaming = false;
  let modelId = "";
  let maxTokens = 4096;
  const isChatCompletion = req.url?.includes("/chat/completions");

  if (isChatCompletion && body.length > 0) {
    try {
      const parsed = JSON.parse(body.toString()) as Record<string, unknown>;
      isStreaming = parsed.stream === true;
      modelId = (parsed.model as string) || "";
      maxTokens = (parsed.max_tokens as number) || 4096;

      // Force stream: false — BlockRun API doesn't support streaming yet
      // ClawRouter handles SSE heartbeat simulation for upstream compatibility
      let bodyModified = false;
      if (parsed.stream === true) {
        parsed.stream = false;
        bodyModified = true;
      }

      // Normalize model name for comparison (trim whitespace, lowercase)
      const normalizedModel =
        typeof parsed.model === "string" ? parsed.model.trim().toLowerCase() : "";

      // Resolve model aliases (e.g., "claude" -> "anthropic/claude-sonnet-4")
      const resolvedModel = resolveModelAlias(normalizedModel);
      const wasAlias = resolvedModel !== normalizedModel;

      const isAutoModel =
        normalizedModel === AUTO_MODEL.toLowerCase() ||
        normalizedModel === AUTO_MODEL_SHORT.toLowerCase();

      // Debug: log received model name
      console.log(
        `[ClawRouter] Received model: "${parsed.model}" -> normalized: "${normalizedModel}"${wasAlias ? ` -> alias: "${resolvedModel}"` : ""}, isAuto: ${isAutoModel}`,
      );

      // If alias was resolved, update the model in the request
      if (wasAlias && !isAutoModel) {
        parsed.model = resolvedModel;
        modelId = resolvedModel;
        bodyModified = true;
      }

      if (isAutoModel) {
        // Extract prompt from messages
        type ChatMessage = { role: string; content: string };
        const messages = parsed.messages as ChatMessage[] | undefined;
        let lastUserMsg: ChatMessage | undefined;
        if (messages) {
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === "user") {
              lastUserMsg = messages[i];
              break;
            }
          }
        }
        const systemMsg = messages?.find((m: ChatMessage) => m.role === "system");
        const prompt = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : "";
        const systemPrompt = typeof systemMsg?.content === "string" ? systemMsg.content : undefined;

        routingDecision = route(prompt, systemPrompt, maxTokens, routerOpts);

        // Replace model in body
        parsed.model = routingDecision.model;
        modelId = routingDecision.model;
        bodyModified = true;

        options.onRouted?.(routingDecision);
      }

      // Rebuild body if modified
      if (bodyModified) {
        body = Buffer.from(JSON.stringify(parsed));
      }
    } catch (err) {
      // Log routing errors so they're not silently swallowed
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[ClawRouter] Routing error: ${errorMsg}`);
      options.onError?.(new Error(`Routing failed: ${errorMsg}`));
    }
  }

  // --- Dedup check ---
  const dedupKey = RequestDeduplicator.hash(body);

  // Check completed cache first
  const cached = deduplicator.getCached(dedupKey);
  if (cached) {
    res.writeHead(cached.status, cached.headers);
    res.end(cached.body);
    return;
  }

  // Check in-flight — wait for the original request to complete
  const inflight = deduplicator.getInflight(dedupKey);
  if (inflight) {
    const result = await inflight;
    res.writeHead(result.status, result.headers);
    res.end(result.body);
    return;
  }

  // Register this request as in-flight
  deduplicator.markInflight(dedupKey);

  // --- Pre-request balance check ---
  // Estimate cost and check if wallet has sufficient balance
  // Skip if skipBalanceCheck is set (for testing)
  let estimatedCostMicros: bigint | undefined;
  if (modelId && !options.skipBalanceCheck) {
    const estimated = estimateAmount(modelId, body.length, maxTokens);
    if (estimated) {
      estimatedCostMicros = BigInt(estimated);

      // Apply extra buffer for balance check to prevent x402 failures after streaming starts.
      // This is aggressive to avoid triggering OpenClaw's 5-24 hour billing cooldown.
      const bufferedCostMicros =
        (estimatedCostMicros * BigInt(Math.ceil(BALANCE_CHECK_BUFFER * 100))) / 100n;

      // Check balance before proceeding (using buffered amount)
      const sufficiency = await balanceMonitor.checkSufficient(bufferedCostMicros);

      if (sufficiency.info.isEmpty) {
        // Wallet is empty — cannot proceed
        deduplicator.removeInflight(dedupKey);
        const error = new EmptyWalletError(sufficiency.info.walletAddress);
        options.onInsufficientFunds?.({
          balanceUSD: sufficiency.info.balanceUSD,
          requiredUSD: balanceMonitor.formatUSDC(bufferedCostMicros),
          walletAddress: sufficiency.info.walletAddress,
        });
        throw error;
      }

      if (!sufficiency.sufficient) {
        // Insufficient balance — cannot proceed
        deduplicator.removeInflight(dedupKey);
        const error = new InsufficientFundsError({
          currentBalanceUSD: sufficiency.info.balanceUSD,
          requiredUSD: balanceMonitor.formatUSDC(bufferedCostMicros),
          walletAddress: sufficiency.info.walletAddress,
        });
        options.onInsufficientFunds?.({
          balanceUSD: sufficiency.info.balanceUSD,
          requiredUSD: balanceMonitor.formatUSDC(bufferedCostMicros),
          walletAddress: sufficiency.info.walletAddress,
        });
        throw error;
      }

      if (sufficiency.info.isLow) {
        // Balance is low but sufficient — warn and proceed
        options.onLowBalance?.({
          balanceUSD: sufficiency.info.balanceUSD,
          walletAddress: sufficiency.info.walletAddress,
        });
      }
    }
  }

  // --- Streaming: early header flush + heartbeat ---
  let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
  let headersSentEarly = false;

  if (isStreaming) {
    // Send 200 + SSE headers immediately, before x402 flow
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    headersSentEarly = true;

    // First heartbeat immediately
    res.write(": heartbeat\n\n");

    // Continue heartbeats every 2s while waiting for upstream
    heartbeatInterval = setInterval(() => {
      if (!res.writableEnded) {
        res.write(": heartbeat\n\n");
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  // Forward headers, stripping host, connection, and content-length
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (
      key === "host" ||
      key === "connection" ||
      key === "transfer-encoding" ||
      key === "content-length"
    )
      continue;
    if (typeof value === "string") {
      headers[key] = value;
    }
  }
  if (!headers["content-type"]) {
    headers["content-type"] = "application/json";
  }
  headers["user-agent"] = USER_AGENT;

  // --- Client disconnect cleanup ---
  let completed = false;
  res.on("close", () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = undefined;
    }
    // Remove from in-flight if client disconnected before completion
    if (!completed) {
      deduplicator.removeInflight(dedupKey);
    }
  });

  // --- Request timeout ---
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // --- Build fallback chain ---
    // If we have a routing decision, get the full fallback chain for the tier
    // Otherwise, just use the current model (no fallback for explicit model requests)
    let modelsToTry: string[];
    if (routingDecision) {
      modelsToTry = getFallbackChain(routingDecision.tier, routerOpts.config.tiers);
      // Limit to MAX_FALLBACK_ATTEMPTS to prevent infinite loops
      modelsToTry = modelsToTry.slice(0, MAX_FALLBACK_ATTEMPTS);
    } else {
      modelsToTry = modelId ? [modelId] : [];
    }

    // --- Fallback loop: try each model until success ---
    let upstream: Response | undefined;
    let lastError: { body: string; status: number } | undefined;
    let actualModelUsed = modelId;

    for (let i = 0; i < modelsToTry.length; i++) {
      const tryModel = modelsToTry[i];
      const isLastAttempt = i === modelsToTry.length - 1;

      console.log(`[ClawRouter] Trying model ${i + 1}/${modelsToTry.length}: ${tryModel}`);

      const result = await tryModelRequest(
        upstreamUrl,
        req.method ?? "POST",
        headers,
        body,
        tryModel,
        maxTokens,
        payFetch,
        balanceMonitor,
        controller.signal,
      );

      if (result.success && result.response) {
        upstream = result.response;
        actualModelUsed = tryModel;
        console.log(`[ClawRouter] Success with model: ${tryModel}`);
        break;
      }

      // Request failed
      lastError = {
        body: result.errorBody || "Unknown error",
        status: result.errorStatus || 500,
      };

      // If it's a provider error and not the last attempt, try next model
      if (result.isProviderError && !isLastAttempt) {
        console.log(
          `[ClawRouter] Provider error from ${tryModel}, trying fallback: ${result.errorBody?.slice(0, 100)}`,
        );
        continue;
      }

      // Not a provider error or last attempt — stop trying
      if (!result.isProviderError) {
        console.log(
          `[ClawRouter] Non-provider error from ${tryModel}, not retrying: ${result.errorBody?.slice(0, 100)}`,
        );
      }
      break;
    }

    // Clear timeout — request attempts completed
    clearTimeout(timeoutId);

    // Clear heartbeat — real data is about to flow
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = undefined;
    }

    // Update routing decision with actual model used (for logging)
    if (routingDecision && actualModelUsed !== routingDecision.model) {
      routingDecision = {
        ...routingDecision,
        model: actualModelUsed,
        reasoning: `${routingDecision.reasoning} | fallback to ${actualModelUsed}`,
      };
      options.onRouted?.(routingDecision);
    }

    // --- Handle case where all models failed ---
    if (!upstream) {
      const errBody = lastError?.body || "All models in fallback chain failed";
      const errStatus = lastError?.status || 502;

      if (headersSentEarly) {
        // Streaming: send error as SSE event
        const errEvent = `data: ${JSON.stringify({ error: { message: errBody, type: "provider_error", status: errStatus } })}\n\n`;
        res.write(errEvent);
        res.write("data: [DONE]\n\n");
        res.end();

        const errBuf = Buffer.from(errEvent + "data: [DONE]\n\n");
        deduplicator.complete(dedupKey, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: errBuf,
          completedAt: Date.now(),
        });
      } else {
        // Non-streaming: send error response
        res.writeHead(errStatus, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: errBody, type: "provider_error" },
          }),
        );

        deduplicator.complete(dedupKey, {
          status: errStatus,
          headers: { "content-type": "application/json" },
          body: Buffer.from(
            JSON.stringify({ error: { message: errBody, type: "provider_error" } }),
          ),
          completedAt: Date.now(),
        });
      }
      return;
    }

    // --- Stream response and collect for dedup cache ---
    const responseChunks: Buffer[] = [];

    if (headersSentEarly) {
      // Streaming: headers already sent. Response should be 200 at this point
      // (non-200 responses are handled in the fallback loop above)

      // Convert non-streaming JSON response to SSE streaming format for client
      // (BlockRun API returns JSON since we forced stream:false)
      // OpenClaw expects: object="chat.completion.chunk" with choices[].delta (not message)
      // We emit proper incremental deltas to match OpenAI's streaming format exactly
      if (upstream.body) {
        const reader = upstream.body.getReader();
        const chunks: Uint8Array[] = [];
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }

        // Combine chunks and transform to streaming format
        const jsonBody = Buffer.concat(chunks);
        const jsonStr = jsonBody.toString();
        try {
          const rsp = JSON.parse(jsonStr) as {
            id?: string;
            object?: string;
            created?: number;
            model?: string;
            choices?: Array<{
              index?: number;
              message?: { role?: string; content?: string };
              delta?: { role?: string; content?: string };
              finish_reason?: string | null;
            }>;
            usage?: unknown;
          };

          // Build base chunk structure (reused for all chunks)
          const baseChunk = {
            id: rsp.id ?? `chatcmpl-${Date.now()}`,
            object: "chat.completion.chunk",
            created: rsp.created ?? Math.floor(Date.now() / 1000),
            model: rsp.model ?? "unknown",
          };

          // Process each choice (usually just one)
          if (rsp.choices && Array.isArray(rsp.choices)) {
            for (const choice of rsp.choices) {
              // Strip thinking tokens (Kimi <｜...｜> and standard <think> tags)
              const rawContent = choice.message?.content ?? choice.delta?.content ?? "";
              const content = stripThinkingTokens(rawContent);
              const role = choice.message?.role ?? choice.delta?.role ?? "assistant";
              const index = choice.index ?? 0;

              // Chunk 1: role only (mimics OpenAI's first chunk)
              const roleChunk = {
                ...baseChunk,
                choices: [{ index, delta: { role }, finish_reason: null }],
              };
              const roleData = `data: ${JSON.stringify(roleChunk)}\n\n`;
              res.write(roleData);
              responseChunks.push(Buffer.from(roleData));

              // Chunk 2: content (single chunk with full content)
              if (content) {
                const contentChunk = {
                  ...baseChunk,
                  choices: [{ index, delta: { content }, finish_reason: null }],
                };
                const contentData = `data: ${JSON.stringify(contentChunk)}\n\n`;
                res.write(contentData);
                responseChunks.push(Buffer.from(contentData));
              }

              // Chunk 3: finish_reason (signals completion)
              const finishChunk = {
                ...baseChunk,
                choices: [{ index, delta: {}, finish_reason: choice.finish_reason ?? "stop" }],
              };
              const finishData = `data: ${JSON.stringify(finishChunk)}\n\n`;
              res.write(finishData);
              responseChunks.push(Buffer.from(finishData));
            }
          }
        } catch {
          // If parsing fails, send raw response as single chunk
          const sseData = `data: ${jsonStr}\n\n`;
          res.write(sseData);
          responseChunks.push(Buffer.from(sseData));
        }
      }

      // Send SSE terminator
      res.write("data: [DONE]\n\n");
      responseChunks.push(Buffer.from("data: [DONE]\n\n"));
      res.end();

      // Cache for dedup
      deduplicator.complete(dedupKey, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: Buffer.concat(responseChunks),
        completedAt: Date.now(),
      });
    } else {
      // Non-streaming: forward status and headers from upstream
      const responseHeaders: Record<string, string> = {};
      upstream.headers.forEach((value, key) => {
        if (key === "transfer-encoding" || key === "connection") return;
        responseHeaders[key] = value;
      });

      res.writeHead(upstream.status, responseHeaders);

      if (upstream.body) {
        const reader = upstream.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
            responseChunks.push(Buffer.from(value));
          }
        } finally {
          reader.releaseLock();
        }
      }

      res.end();

      // Cache for dedup
      deduplicator.complete(dedupKey, {
        status: upstream.status,
        headers: responseHeaders,
        body: Buffer.concat(responseChunks),
        completedAt: Date.now(),
      });
    }

    // --- Optimistic balance deduction after successful response ---
    if (estimatedCostMicros !== undefined) {
      balanceMonitor.deductEstimated(estimatedCostMicros);
    }

    // Mark request as completed (for client disconnect cleanup)
    completed = true;
  } catch (err) {
    // Clear timeout on error
    clearTimeout(timeoutId);

    // Clear heartbeat on error
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = undefined;
    }

    // Remove in-flight entry so retries aren't blocked
    deduplicator.removeInflight(dedupKey);

    // Invalidate balance cache on payment failure (might be out of date)
    balanceMonitor.invalidate();

    // Convert abort error to more descriptive timeout error
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }

    throw err;
  }

  // --- Usage logging (fire-and-forget) ---
  if (routingDecision) {
    const entry: UsageEntry = {
      timestamp: new Date().toISOString(),
      model: routingDecision.model,
      tier: routingDecision.tier,
      cost: routingDecision.costEstimate,
      baselineCost: routingDecision.baselineCost,
      savings: routingDecision.savings,
      latencyMs: Date.now() - startTime,
    };
    logUsage(entry).catch(() => {});
  }
}
