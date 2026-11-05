import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";

import { startProxy, type ProxyHandle } from "./proxy.js";
import { CAIP2_BASE, InMemorySpendControlStorage, SpendControl } from "./spend-control.js";

/**
 * What a $0 cap still lets through, and what it must not: free models answer,
 * and a model with no local price is not free. Graceful mode has no signing
 * check to fall back on, so it refuses an unpriced model once nothing remains.
 */

const FREE = /^(nvidia|free)\//;
let upstream: Server;
let strict: ProxyHandle;
let graceful: ProxyHandle;
let paidHits = 0;

const challenge = Buffer.from(
  JSON.stringify({
    x402Version: 2,
    resource: { url: "http://127.0.0.1/v1/chat/completions" },
    accepts: [
      {
        scheme: "exact",
        network: CAIP2_BASE,
        amount: "8000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0x1aA67D6375b98C476C427C7aca397045F52e25E1",
        maxTimeoutSeconds: 60,
        extra: { name: "USD Coin", version: "2" },
      },
    ],
  }),
).toString("base64");

beforeAll(async () => {
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      const model = raw ? (JSON.parse(raw) as { model?: string }).model : undefined;
      const signed = Boolean(req.headers["payment-signature"] || req.headers["x-payment"]);
      if (!FREE.test(model ?? "") && !signed) {
        res.writeHead(402, { "Content-Type": "application/json", "PAYMENT-REQUIRED": challenge });
        res.end(JSON.stringify({ error: "payment required" }));
        return;
      }
      if (signed) paidHits++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          model,
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        }),
      );
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const common = {
    apiBase: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    port: 0,
    skipBalanceCheck: true,
    maxCostPerRunUsd: 0,
  };
  strict = await startProxy({
    ...common,
    wallet: generatePrivateKey(),
    spendControl: new SpendControl({ storage: new InMemorySpendControlStorage() }),
    maxCostPerRunMode: "strict",
  });
  graceful = await startProxy({
    ...common,
    wallet: generatePrivateKey(),
    spendControl: new SpendControl({ storage: new InMemorySpendControlStorage() }),
    maxCostPerRunMode: "graceful",
  });
}, 20_000);

afterAll(async () => {
  await strict?.close();
  await graceful?.close();
  upstream?.closeAllConnections?.();
  await new Promise<void>((r) => upstream?.close(() => r()));
});

beforeEach(() => {
  paidHits = 0;
});

let seq = 0;
function send(proxy: ProxyHandle, model: string): Promise<Response> {
  return fetch(`${proxy.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-session-id": `zero-unpriced-${++seq}` },
    body: JSON.stringify({
      model,
      max_tokens: 100,
      stream: false,
      messages: [{ role: "user", content: `hi ${seq}` }],
    }),
  });
}

describe("maxCostPerRun of 0", () => {
  it.each([
    ["strict", () => strict],
    ["graceful", () => graceful],
  ])("still answers on a free model in %s mode", async (_mode, proxy) => {
    const res = await send(proxy(), "free/nemotron-3.5-lightning");
    expect(res.status).toBe(200);
    expect(paidHits).toBe(0);
  });

  it("adds no downgrade notice when the routed primary is already free", async () => {
    const res = await send(graceful, "eco");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-clawrouter-budget-mode")).toBeNull();
    const json = (await res.json()) as { choices: { message: { content: string } }[] };
    expect(json.choices[0].message.content).toBe("ok");
    expect(paidHits).toBe(0);
  });

  it("downgrades a simple routed request to a free model in graceful mode", async () => {
    const res = await send(graceful, "auto");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-clawrouter-budget-mode")).toBe("downgraded");
    const json = (await res.json()) as { choices: { message: { content: string } }[] };
    expect(json.choices[0].message.content).toBe("ok");
    expect(paidHits).toBe(0);
  });

  it.each([
    ["strict", () => strict],
    ["graceful", () => graceful],
  ])("does not pay for a model with no local price in %s mode", async (_mode, proxy) => {
    const res = await send(proxy(), "acme/not-in-catalog");
    expect(res.status).toBe(429);
    expect(paidHits).toBe(0);
  });
});
