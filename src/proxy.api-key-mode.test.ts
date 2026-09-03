import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startProxy, type ProxyHandle } from "./proxy.js";

/**
 * API-key mode, end to end through the real proxy.
 *
 * The three things that must hold, because each one is money or access:
 *   1. No wallet is required, and none is signed with — a customer paying by
 *      card must never have a private key generated or a payment attached.
 *   2. The bearer token reaches upstream, and OVERRIDES whatever the local
 *      client sent. The proxy forwards request headers verbatim, and OpenClaw
 *      always sends some placeholder key; defaulting instead of overwriting
 *      would 401 every call.
 *   3. /health names the mode and never leaks the key, so a second ClawRouter
 *      cannot silently attach to a proxy billing a different account.
 */
describe("startProxy in API-key mode", () => {
  const KEY = "brk_live_" + "z".repeat(48);
  let upstream: Server;
  let proxy: ProxyHandle;
  let seenAuth: string | undefined;
  let seenPayment: string | undefined;
  let hits = 0;

  beforeAll(async () => {
    upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        hits++;
        seenAuth = req.headers["authorization"] as string | undefined;
        seenPayment = req.headers["x-payment"] as string | undefined;
        if (req.url === "/v1/models") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ object: "list", data: [] }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-1",
            model: "anthropic/claude-sonnet-4.6",
            choices: [
              { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          }),
        );
      });
    });

    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const addr = upstream.address() as AddressInfo;

    // No `wallet` at all: that is the point of the mode.
    proxy = await startProxy({
      apiKey: KEY,
      apiBase: `http://127.0.0.1:${addr.port}`,
      port: 0,
      allowExistingProxy: false,
    });
  }, 20_000);

  afterAll(async () => {
    await proxy?.close();
    upstream.closeAllConnections?.();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  beforeEach(() => {
    seenAuth = undefined;
    seenPayment = undefined;
    hits = 0;
  });

  it("starts without a wallet and reports no wallet address", () => {
    expect(proxy.authMode).toBe("api-key");
    expect(proxy.walletAddress).toBe("");
    expect(proxy.solanaAddress).toBeUndefined();
  });

  it("sends the key upstream and attaches no x402 payment", async () => {
    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "anthropic/claude-sonnet-4.6",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      }),
    });

    expect(res.status).toBe(200);
    expect(hits).toBeGreaterThan(0);
    expect(seenAuth).toBe(`Bearer ${KEY}`);
    expect(seenPayment).toBeUndefined();
  }, 30_000);

  it("overrides a placeholder authorization sent by the local client", async () => {
    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk-openclaw-placeholder",
      },
      // Distinct content: an identical body would be served from the response
      // cache and never reach upstream, which is what this test measures.
      body: JSON.stringify({
        model: "anthropic/claude-sonnet-4.6",
        messages: [{ role: "user", content: "hello from a client with its own key" }],
        stream: false,
      }),
    });

    expect(res.status).toBe(200);
    expect(seenAuth).toBe(`Bearer ${KEY}`);
  }, 30_000);

  it("reports the mode on /health with the key masked, and no chain", async () => {
    const res = await fetch(`${proxy.baseUrl}/health?full=true`);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.authMode).toBe("api-key");
    expect(body.paymentChain).toBeUndefined();
    expect(body.wallet).toBeUndefined();
    expect(body.balance).toBeNull();
    expect(body.topUpUrl).toContain("user.blockrun.ai");
    // Masked, never whole: /health is unauthenticated on localhost.
    expect(JSON.stringify(body)).not.toContain(KEY);
    expect(String(body.apiKey)).toContain("brk_live_");
  });
});

describe("startProxy credential validation", () => {
  it("refuses to start with neither a wallet nor a key", async () => {
    await expect(startProxy({ port: 0, allowExistingProxy: false })).rejects.toThrow(
      /needs a credential/i,
    );
  });

  it("refuses a malformed API key rather than 401-ing on every request", async () => {
    await expect(
      startProxy({ apiKey: "sk-not-a-blockrun-key", port: 0, allowExistingProxy: false }),
    ).rejects.toThrow(/brk_/);
  });
});
