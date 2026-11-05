import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey } from "viem/accounts";

import { startProxy, type ProxyHandle } from "./proxy.js";
import { CAIP2_BASE, InMemorySpendControlStorage, SpendControl } from "./spend-control.js";

/**
 * The docs offer two ways to bypass the response cache: `Cache-Control:
 * no-cache` on the request, or `cache: false` / `no_cache: true` in the body.
 * The body flag skipped both the lookup and the store, but the header only
 * skipped the lookup: the response was still stored, and the next identical
 * request without the header was answered from it instead of upstream.
 *
 * The second request is sent after the 30s dedup window, so only the 10-minute
 * response cache can answer it.
 */

const MODEL = "anthropic/claude-sonnet-4.6";
const DEDUP_WINDOW_MS = 30_000;

let upstream: Server;
let proxy: ProxyHandle;
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
          id: `chatcmpl-${paidHits}`,
          object: "chat.completion",
          model: MODEL,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: `answer ${paidHits}` },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        }),
      );
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const apiBase = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  proxy = await startProxy({
    apiBase,
    port: 0,
    skipBalanceCheck: true,
    wallet: generatePrivateKey(),
    spendControl: new SpendControl({ storage: new InMemorySpendControlStorage() }),
  });
}, 20_000);

afterAll(async () => {
  await proxy?.close();
  upstream?.closeAllConnections?.();
  await new Promise<void>((r) => upstream?.close(() => r()));
});

beforeEach(() => {
  paidHits = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function send(prompt: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${proxy.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 50,
      stream: false,
      messages: [{ role: "user", content: prompt }],
    }),
  });
}

/** Move the clock past the dedup window, leaving the response cache valid. */
function skipDedupWindow(): void {
  const realNow = Date.now.bind(Date);
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + DEDUP_WINDOW_MS + 1_000);
}

describe("response cache bypass", () => {
  it("stores a normal response and serves the next identical request from it", async () => {
    const first = await send("cache control probe: stored");
    expect(first.status).toBe(200);
    await first.text();
    expect(paidHits).toBe(1);

    skipDedupWindow();
    const second = await send("cache control probe: stored");
    expect(second.status).toBe(200);
    await second.text();
    expect(paidHits).toBe(1);
  });

  it("does not store the response of a request sent with Cache-Control: no-cache", async () => {
    const first = await send("cache control probe: bypassed", { "cache-control": "no-cache" });
    expect(first.status).toBe(200);
    await first.text();
    expect(paidHits).toBe(1);

    skipDedupWindow();
    const second = await send("cache control probe: bypassed");
    expect(second.status).toBe(200);
    const body = (await second.json()) as { choices: Array<{ message: { content: string } }> };
    expect(paidHits).toBe(2);
    expect(body.choices[0].message.content).toBe("answer 2");
  });
});
