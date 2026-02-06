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
  DEFAULT_ROUTING_CONFIG,
  type RouterOptions,
  type RoutingDecision,
  type RoutingConfig,
  type ModelPricing,
} from "./router/index.js";
import { BLOCKRUN_MODELS } from "./models.js";
import { logUsage, type UsageEntry } from "./logger.js";
import { RequestDeduplicator } from "./dedup.js";
import { BalanceMonitor, type BalanceInfo } from "./balance.js";
import { InsufficientFundsError, EmptyWalletError } from "./errors.js";

const BLOCKRUN_API = "https://blockrun.ai/api";
const AUTO_MODEL = "blockrun/auto";
const USER_AGENT = "clawrouter/0.3.2";
const HEARTBEAT_INTERVAL_MS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000; // 3 minutes (allows for on-chain tx + LLM response)

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
  port?: number;
  routingConfig?: Partial<RoutingConfig>;
  /** Request timeout in ms (default: 180000 = 3 minutes). Covers on-chain tx + LLM response. */
  requestTimeoutMs?: number;
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
 * Returns a handle with the assigned port, base URL, and a close function.
 */
export async function startProxy(options: ProxyOptions): Promise<ProxyHandle> {
  const apiBase = options.apiBase ?? BLOCKRUN_API;

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

    // Only proxy paths starting with /v1
    if (!req.url?.startsWith("/v1")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    try {
      await proxyRequest(req, res, apiBase, payFetch, options, routerOpts, deduplicator, balanceMonitor);
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

  // Listen on requested port (0 = random available port)
  const listenPort = options.port ?? 0;

  return new Promise<ProxyHandle>((resolve, reject) => {
    server.on("error", reject);

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

/**
 * Proxy a single request through x402 payment flow to BlockRun API.
 *
 * Optimizations applied in order:
 *   1. Dedup check — if same request body seen within 30s, replay cached response
 *   2. Streaming heartbeat — for stream:true, send 200 + heartbeats immediately
 *   3. Payment pre-auth — estimate USDC amount and pre-sign to skip 402 round trip
 *   4. Smart routing — when model is "blockrun/auto", pick cheapest capable model
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

      if (parsed.model === AUTO_MODEL) {
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
        body = Buffer.from(JSON.stringify(parsed));

        options.onRouted?.(routingDecision);
      }
    } catch {
      // JSON parse error — forward body as-is
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
  let estimatedCostMicros: bigint | undefined;
  if (modelId) {
    const estimated = estimateAmount(modelId, body.length, maxTokens);
    if (estimated) {
      estimatedCostMicros = BigInt(estimated);

      // Check balance before proceeding
      const sufficiency = await balanceMonitor.checkSufficient(estimatedCostMicros);

      if (sufficiency.info.isEmpty) {
        // Wallet is empty — cannot proceed
        deduplicator.removeInflight(dedupKey);
        const error = new EmptyWalletError(sufficiency.info.walletAddress);
        options.onInsufficientFunds?.({
          balanceUSD: sufficiency.info.balanceUSD,
          requiredUSD: balanceMonitor.formatUSDC(estimatedCostMicros),
          walletAddress: sufficiency.info.walletAddress,
        });
        throw error;
      }

      if (!sufficiency.sufficient) {
        // Insufficient balance — cannot proceed
        deduplicator.removeInflight(dedupKey);
        const error = new InsufficientFundsError({
          currentBalanceUSD: sufficiency.info.balanceUSD,
          requiredUSD: balanceMonitor.formatUSDC(estimatedCostMicros),
          walletAddress: sufficiency.info.walletAddress,
        });
        options.onInsufficientFunds?.({
          balanceUSD: sufficiency.info.balanceUSD,
          requiredUSD: balanceMonitor.formatUSDC(estimatedCostMicros),
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

  // --- Payment pre-auth: use already-estimated amount to skip 402 round trip ---
  let preAuth: PreAuthParams | undefined;
  if (estimatedCostMicros !== undefined) {
    preAuth = { estimatedAmount: estimatedCostMicros.toString() };
  }

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
    // Make the request through x402-wrapped fetch (with optional pre-auth)
    const upstream = await payFetch(
      upstreamUrl,
      {
        method: req.method ?? "POST",
        headers,
        body: body.length > 0 ? body : undefined,
        signal: controller.signal,
      },
      preAuth,
    );

    // Clear timeout — request succeeded
    clearTimeout(timeoutId);

    // Clear heartbeat — real data is about to flow
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = undefined;
    }

    // --- Stream response and collect for dedup cache ---
    const responseChunks: Buffer[] = [];

    if (headersSentEarly) {
      // Streaming: headers already sent. Check for upstream errors.
      if (upstream.status !== 200) {
        const errBody = await upstream.text();
        const errEvent = `data: ${JSON.stringify({ error: { message: errBody, type: "upstream_error", status: upstream.status } })}\n\n`;
        res.write(errEvent);
        res.write("data: [DONE]\n\n");
        res.end();

        // Cache the error response for dedup
        const errBuf = Buffer.from(errEvent + "data: [DONE]\n\n");
        deduplicator.complete(dedupKey, {
          status: 200, // we already sent 200
          headers: { "content-type": "text/event-stream" },
          body: errBuf,
          completedAt: Date.now(),
        });
        return;
      }

      // Pipe upstream SSE data to client
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
      cost: routingDecision.costEstimate,
      latencyMs: Date.now() - startTime,
    };
    logUsage(entry).catch(() => {});
  }
}
