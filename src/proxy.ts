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
 * Phase 2 additions:
 *   - Smart routing: when model is "blockrun/auto", classify query and pick cheapest model
 *   - Usage logging: log every request as JSON line to ~/.openclaw/blockrun/logs/
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { privateKeyToAccount } from "viem/accounts";
import { createPaymentFetch } from "./x402.js";
import { route, getFallbackChain, DEFAULT_ROUTING_CONFIG, type RouterOptions, type RoutingDecision, type RoutingConfig, type ModelPricing } from "./router/index.js";
import { BLOCKRUN_MODELS } from "./models.js";
import { logUsage, type UsageEntry } from "./logger.js";

const BLOCKRUN_API = "https://blockrun.ai/api";
const AUTO_MODEL = "blockrun/auto";
const USER_AGENT = "claw-router/0.1.0";

export type ProxyOptions = {
  walletKey: string;
  apiBase?: string;
  port?: number;
  routingConfig?: Partial<RoutingConfig>;
  onReady?: (port: number) => void;
  onError?: (error: Error) => void;
  onPayment?: (info: { model: string; amount: string; network: string }) => void;
  onRouted?: (decision: RoutingDecision) => void;
};

export type ProxyHandle = {
  port: number;
  baseUrl: string;
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
 * Start the local x402 proxy server.
 *
 * Returns a handle with the assigned port, base URL, and a close function.
 */
export async function startProxy(options: ProxyOptions): Promise<ProxyHandle> {
  const apiBase = options.apiBase ?? BLOCKRUN_API;

  // Create x402 payment-enabled fetch from wallet private key
  const account = privateKeyToAccount(options.walletKey as `0x${string}`);
  const payFetch = createPaymentFetch(options.walletKey as `0x${string}`);

  // Build router options
  const routingConfig = mergeRoutingConfig(options.routingConfig);
  const modelPricing = buildModelPricing();
  const routerOpts: RouterOptions = {
    config: routingConfig,
    modelPricing,
    payFetch,
    apiBase,
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Health check
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", wallet: account.address }));
      return;
    }

    // Only proxy paths starting with /v1
    if (!req.url?.startsWith("/v1")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    try {
      await proxyRequest(req, res, apiBase, payFetch, options, routerOpts);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      options.onError?.(error);

      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: { message: `Proxy error: ${error.message}`, type: "proxy_error" },
        }));
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
 * When model is "blockrun/auto", runs the smart router to pick the
 * cheapest capable model before forwarding.
 */
async function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  apiBase: string,
  payFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  options: ProxyOptions,
  routerOpts: RouterOptions,
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
  const isChatCompletion = req.url?.includes("/chat/completions");

  if (isChatCompletion && body.length > 0) {
    try {
      const parsed = JSON.parse(body.toString()) as Record<string, unknown>;

      if (parsed.model === AUTO_MODEL) {
        // Extract prompt from messages
        type ChatMessage = { role: string; content: string };
        const messages = parsed.messages as ChatMessage[] | undefined;
        let lastUserMsg: ChatMessage | undefined;
        if (messages) {
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === "user") { lastUserMsg = messages[i]; break; }
          }
        }
        const systemMsg = messages?.find((m: ChatMessage) => m.role === "system");
        const prompt = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : "";
        const systemPrompt = typeof systemMsg?.content === "string" ? systemMsg.content : undefined;
        const maxTokens = (parsed.max_tokens as number) || 4096;

        routingDecision = await route(prompt, systemPrompt, maxTokens, routerOpts);

        // Replace model in body
        parsed.model = routingDecision.model;
        body = Buffer.from(JSON.stringify(parsed));

        options.onRouted?.(routingDecision);
      }
    } catch {
      // JSON parse error — forward body as-is
    }
  }

  // Forward headers, stripping host, connection, and content-length
  // (content-length may be wrong after body modification for routing)
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (key === "host" || key === "connection" || key === "transfer-encoding" || key === "content-length") continue;
    if (typeof value === "string") {
      headers[key] = value;
    }
  }
  // Ensure content-type is set
  if (!headers["content-type"]) {
    headers["content-type"] = "application/json";
  }
  // Set User-Agent for BlockRun API tracking
  headers["user-agent"] = USER_AGENT;

  // Make the request through x402-wrapped fetch
  // This handles: request → 402 → sign payment → retry with PAYMENT-SIGNATURE header
  const upstream = await payFetch(upstreamUrl, {
    method: req.method ?? "POST",
    headers,
    body: body.length > 0 ? body : undefined,
  });

  // Forward status and headers from upstream
  const responseHeaders: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    // Skip hop-by-hop headers
    if (key === "transfer-encoding" || key === "connection") return;
    responseHeaders[key] = value;
  });

  res.writeHead(upstream.status, responseHeaders);

  // Stream the response body
  if (upstream.body) {
    const reader = upstream.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  res.end();

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
