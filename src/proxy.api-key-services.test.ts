import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startProxy, type ProxyHandle } from "./proxy.js";

vi.mock("./logger.js", async (original) => ({
  ...(await original<typeof import("./logger.js")>()),
  logUsage: vi.fn(async () => {}),
}));

describe("account API service parity through the proxy", () => {
  const key = "brk_live_services_123456789";
  let upstream: Server;
  let proxy: ProxyHandle;
  let calls: Array<{ path: string; method: string; auth?: string; payment?: string }> = [];
  let quota = 0;
  let finishStream: (() => void) | undefined;
  beforeAll(async () => {
    upstream = createServer((req, res) => {
      calls.push({
        path: req.url!,
        method: req.method!,
        auth: req.headers.authorization,
        payment: req.headers["payment-signature"] as string | undefined,
      });
      req.resume();
      if (req.url === "/v1/phone/numbers/owned") {
        res.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "public, max-age=3600",
          etag: "account-specific",
        });
        res.end(JSON.stringify({ owner: req.headers.authorization }));
        return;
      }
      if (req.url === "/v1/models") {
        res.setHeader("content-type", "application/json");
        res.end('{"data":[]}');
        return;
      }
      if (quota) {
        res.writeHead(quota, {
          "content-type": "application/json",
          "retry-after": "12",
          "payment-required": "never-sign",
        });
        res.end('{"error":{"message":"Account limit","code":"quota"}}');
        return;
      }
      if (req.url === "/v1/responses" && req.method === "POST") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('event: response.created\ndata: {"id":"r-1"}\n\n');
        finishStream = () => res.end('event: response.completed\ndata: {"id":"r-1"}\n\n');
        return;
      }
      if (req.url === "/v1/audio/generations") {
        res.writeHead(202, { "content-type": "application/json" });
        res.end('{"id":"m-1","status":"queued","poll_url":"/api/v1/audio/generations/m-1"}');
        return;
      }
      if (req.url === "/v1/audio/generations/m-1") {
        res.setHeader("content-type", "application/json");
        res.end('{"status":"completed","data":[]}');
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ path: req.url, method: req.method }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    proxy = await startProxy({
      apiKey: key,
      apiBase: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1/`,
      port: 0,
      allowExistingProxy: false,
    });
  });
  beforeEach(() => {
    calls = [];
    quota = 0;
  });
  afterAll(async () => {
    finishStream?.();
    await proxy?.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
  it("prevents cached account data from surviving an account change at the same proxy URL", async () => {
    const baseUrl = proxy.baseUrl;
    const first = await fetch(baseUrl + "/v1/phone/numbers/owned");
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(await first.json()).toEqual({ owner: `Bearer ${key}` });
    await proxy.close();
    proxy = await startProxy({
      apiKey: "brk_live_second_account",
      apiBase: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
      port: Number(new URL(baseUrl).port),
      allowExistingProxy: false,
    });
    try {
      const second = await fetch(baseUrl + "/v1/phone/numbers/owned");
      expect(second.headers.get("cache-control")).toBe("no-store");
      expect(await second.json()).toEqual({ owner: "Bearer brk_live_second_account" });
    } finally {
      await proxy.close();
      proxy = await startProxy({
        apiKey: key,
        apiBase: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
        port: Number(new URL(baseUrl).port),
        allowExistingProxy: false,
      });
    }
  });
  it.each([
    ["POST", "/v1/rpc/solana"],
    ["POST", "/v1/rpc/base"],
    ["POST", "/v1/audio/speech"],
    ["POST", "/v1/audio/sound-effects"],
    ["GET", "/v1/audio/voices"],
    ["POST", "/v1/images/generations"],
    ["POST", "/v1/images/image2image"],
    ["GET", "/v1/images/models"],
    ["POST", "/v1/videos/generations"],
    ["GET", "/v1/videos/generations/v-1"],
    ["POST", "/v1/search"],
    ["POST", "/v1/exa/search"],
    ["POST", "/v1/exa/answer"],
    ["GET", "/v1/responses/r-1"],
    ["POST", "/v1/portrait/enroll"],
    ["POST", "/v1/realface/init"],
    ["POST", "/v1/realface/enroll"],
    ["GET", "/v1/realface/status?groupId=legacy_rf_123"],
    ["POST", "/v1/phone/lookup"],
    ["POST", "/v1/phone/numbers/list"],
    ["POST", "/v1/voice/call"],
    ["GET", "/v1/voice/call/fixture-call"],
    ["GET", "/v1/surf/market/ranking"],
    ["POST", "/v1/surf/onchain/sql"],
    ["GET", "/v1/pm/polymarket/markets?q=test"],
    ["POST", "/v1/pm/polymarket/query"],
    ["GET", "/v1/crypto/price/BTC-USD"],
    ["GET", "/v1/fx/price/EUR-USD"],
    ["GET", "/v1/commodity/price/XAU-USD"],
    ["GET", "/v1/stocks/us/price/AAPL"],
    ["GET", "/v1/defillama/chains"],
    ["POST", "/v1/modal/sandbox/create"],
  ])("forwards %s %s with account auth", async (method, path) => {
    const res = await fetch(proxy.baseUrl + path, {
      method,
      headers: {
        "content-type": "application/json",
        "payment-signature": "strip",
        "x-api-key": "placeholder",
      },
      ...(method === "POST" ? { body: "{}" } : {}),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).path).toBe(path);
    const request = calls.find((c) => c.path === path)!;
    expect(request.method).toBe(method);
    expect(request.auth).toBe(`Bearer ${key}`);
    expect(request.payment).toBeUndefined();
  });
  it("streams Responses before upstream completes", async () => {
    const res = await fetch(proxy.baseUrl + "/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"model":"openai/gpt-5.2","input":"hi","stream":true}',
      signal: AbortSignal.timeout(3000),
    });
    const reader = res.body!.getReader();
    try {
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain("response.created");
      finishStream!();
      while (!(await reader.read()).done) {
        /* drain */
      }
    } finally {
      finishStream?.();
      reader.releaseLock();
    }
  });
  it.each([401, 402, 429])(
    "keeps account status %i and Retry-After without x402 replay",
    async (status) => {
      quota = status;
      const res = await fetch(proxy.baseUrl + "/v1/rpc/solana", { method: "POST", body: "{}" });
      expect(res.status).toBe(status);
      expect(res.headers.get("retry-after")).toBe("12");
      expect((await res.json()).error.code).toBe("quota");
      expect(calls.filter((c) => c.path === "/v1/rpc/solana")).toHaveLength(1);
    },
  );
  it("polls a music job returned on the initial account submission", async () => {
    const res = await fetch(proxy.baseUrl + "/v1/audio/generations", {
      method: "POST",
      body: '{"prompt":"hi"}',
    });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("completed");
    expect(calls.filter((c) => c.path === "/v1/audio/generations/m-1")).toHaveLength(1);
    expect(calls.every((c) => c.auth === `Bearer ${key}`)).toBe(true);
  });
});
