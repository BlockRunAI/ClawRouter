import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";

import { startProxy, type ProxyHandle } from "./proxy.js";
import { CAIP2_BASE, InMemorySpendControlStorage, SpendControl } from "./spend-control.js";

/**
 * `maxCostPerRun: 0` is a $0 cap, not "no cap". The cap checks used to test
 * the value for truthiness, so 0 switched every check off and paid requests
 * went through unlimited, while startup still logged "Cost cap: $0.00 per
 * session".
 */

const MODEL = "anthropic/claude-sonnet-4.6";

let upstream: Server;
let strictProxy: ProxyHandle;
let gracefulProxy: ProxyHandle;
let paidHits = 0;

function challengeHeader(): string {
  const challenge = {
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
  };
  return Buffer.from(JSON.stringify(challenge)).toString("base64");
}

beforeAll(async () => {
  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.on("data", () => {});
    req.on("end", () => {
      if (!req.headers["payment-signature"] && !req.headers["x-payment"]) {
        res.writeHead(402, {
          "Content-Type": "application/json",
          "PAYMENT-REQUIRED": challengeHeader(),
        });
        res.end(JSON.stringify({ error: "payment required" }));
        return;
      }
      paidHits++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          model: MODEL,
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        }),
      );
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const apiBase = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  const common = {
    apiBase,
    port: 0,
    skipBalanceCheck: true,
    maxCostPerRunUsd: 0,
  };
  strictProxy = await startProxy({
    ...common,
    wallet: generatePrivateKey(),
    spendControl: new SpendControl({ storage: new InMemorySpendControlStorage() }),
    maxCostPerRunMode: "strict",
  });
  gracefulProxy = await startProxy({
    ...common,
    wallet: generatePrivateKey(),
    spendControl: new SpendControl({ storage: new InMemorySpendControlStorage() }),
    maxCostPerRunMode: "graceful",
  });
}, 20_000);

afterAll(async () => {
  await strictProxy?.close();
  await gracefulProxy?.close();
  upstream?.closeAllConnections?.();
  await new Promise<void>((r) => upstream?.close(() => r()));
});

beforeEach(() => {
  paidHits = 0;
});

let seq = 0;
function send(proxy: ProxyHandle): Promise<Response> {
  return fetch(`${proxy.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-session-id": `zero-cap-${seq}` },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 500,
      stream: false,
      messages: [{ role: "user", content: `zero cap probe ${seq++}` }],
    }),
  });
}

describe("maxCostPerRun of 0", () => {
  describe("in strict mode", () => {
    it("refuses a paid model before signing", async () => {
      const res = await send(strictProxy);
      expect(res.status).toBe(429);
      expect(res.headers.get("x-clawrouter-cost-cap-exceeded")).toBe("1");
      expect(paidHits).toBe(0);
    });
  });

  describe("in graceful mode", () => {
    it("refuses an explicitly chosen paid model before signing", async () => {
      const res = await send(gracefulProxy);
      expect(res.status).toBe(429);
      expect(res.headers.get("x-clawrouter-cost-cap-exceeded")).toBe("1");
      expect(paidHits).toBe(0);
    });
  });
});
