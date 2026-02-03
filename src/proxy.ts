/**
 * Local x402 Proxy Server
 *
 * Sits between OpenClaw's pi-ai (which makes standard OpenAI-format requests)
 * and BlockRun's API (which requires x402 micropayments).
 *
 * Flow:
 *   pi-ai → http://localhost:{port}/v1/chat/completions
 *        → proxy forwards to https://api.blockrun.ai/api/v1/chat/completions
 *        → gets 402 → @x402/fetch signs payment → retries
 *        → streams response back to pi-ai
 *
 * Streaming works because x402 is a gated API:
 *   verify payment → grant access → stream response → settle
 *   The 402→sign→retry happens on the initial request; once accepted,
 *   the response streams normally through the proxy.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { privateKeyToAccount } from "viem/accounts";
import { toClientEvmSigner, ExactEvmScheme } from "@x402/evm";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";

const BLOCKRUN_API = "https://api.blockrun.ai/api";

export type ProxyOptions = {
  walletKey: string;
  apiBase?: string;
  port?: number;
  onReady?: (port: number) => void;
  onError?: (error: Error) => void;
  onPayment?: (info: { model: string; amount: string; network: string }) => void;
};

export type ProxyHandle = {
  port: number;
  baseUrl: string;
  close: () => Promise<void>;
};

/**
 * Start the local x402 proxy server.
 *
 * Returns a handle with the assigned port, base URL, and a close function.
 */
export async function startProxy(options: ProxyOptions): Promise<ProxyHandle> {
  const apiBase = options.apiBase ?? BLOCKRUN_API;

  // Create x402 payment client from wallet private key
  // Base mainnet = eip155:8453
  const account = privateKeyToAccount(options.walletKey as `0x${string}`);
  const signer = toClientEvmSigner(account);
  const client = new x402Client().register("eip155:8453", new ExactEvmScheme(signer));
  const payFetch = wrapFetchWithPayment(fetch, client);

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
      await proxyRequest(req, res, apiBase, payFetch, options);
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
 */
async function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  apiBase: string,
  payFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  options: ProxyOptions,
): Promise<void> {
  // Build upstream URL: /v1/chat/completions → https://api.blockrun.ai/api/v1/chat/completions
  const upstreamUrl = `${apiBase}${req.url}`;

  // Collect request body
  const bodyChunks: Buffer[] = [];
  for await (const chunk of req) {
    bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(bodyChunks);

  // Forward headers, stripping host and connection
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (key === "host" || key === "connection" || key === "transfer-encoding") continue;
    if (typeof value === "string") {
      headers[key] = value;
    }
  }
  // Ensure content-type is set
  if (!headers["content-type"]) {
    headers["content-type"] = "application/json";
  }

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
}
