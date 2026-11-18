import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { estimateAmount, startProxy, type ProxyHandle } from "./proxy.js";
import { InMemorySpendControlStorage, SpendControl } from "./spend-control.js";

/**
 * GHSA-86hx-xv73-9qch, API-key rail. The wallet rail re-checks the strict
 * `maxCostPerRun` cap before every signature (proxy.cost-cap-strict.test.ts).
 * This rail signs nothing, so admission's single estimate was the only check:
 * a retry or fallback inside one request dispatched again unchecked, and a
 * charge the gateway reported on a failed attempt was never recorded.
 *
 * Same numbers as the wallet test: a $0.012 cap and a request whose estimate
 * fits it once but not twice.
 */

const CAP_USD = 0.012;
const MODEL = "anthropic/claude-sonnet-4.6";
const MAX_TOKENS = 500;

/** One scripted answer per keyed dispatch, in order; "ok" once the script runs out. */
type Reply = { status: 200 | 502; chargedUsd?: string };

let upstream: Server;
let proxy: ProxyHandle;
let script: Reply[] = [];
let keyedHits = 0;

beforeAll(async () => {
  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (!req.url?.startsWith("/v1/chat/completions") || !req.headers.authorization) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end("{}");
        return;
      }
      keyedHits++;
      const reply = script.shift() ?? { status: 200 };
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (reply.chargedUsd !== undefined) headers["x-blockrun-cost-usd"] = reply.chargedUsd;
      res.writeHead(reply.status, headers);
      res.end(
        reply.status === 200
          ? JSON.stringify({
              id: "chatcmpl-test",
              object: "chat.completion",
              model: MODEL,
              choices: [
                { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
            })
          : JSON.stringify({ error: { message: "bad gateway" } }),
      );
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const port = (upstream.address() as AddressInfo).port;

  proxy = await startProxy({
    apiKey: "brk_live_test",
    apiBase: `http://127.0.0.1:${port}`,
    port: 0,
    skipBalanceCheck: true,
    spendControl: new SpendControl({ storage: new InMemorySpendControlStorage() }),
    maxCostPerRunUsd: CAP_USD,
    maxCostPerRunMode: "strict",
  });
}, 20_000);

afterAll(async () => {
  await proxy?.close();
  upstream?.closeAllConnections?.();
  await new Promise<void>((r) => upstream?.close(() => r()));
});

beforeEach(() => {
  script = [];
  keyedHits = 0;
});

let seq = 0;
function send(session: string): Promise<Response> {
  return fetch(`${proxy.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-session-id": session },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      stream: false,
      messages: [{ role: "user", content: `key cap probe ${seq++}` }],
    }),
  });
}

describe("strict maxCostPerRun on the API-key rail checks every dispatch", () => {
  it("fixture: one request fits the cap, two do not", () => {
    const est = Number(estimateAmount(MODEL, 200, MAX_TOKENS)) / 1_000_000;
    expect(est).toBeGreaterThan(0);
    expect(est).toBeLessThanOrEqual(CAP_USD);
    expect(2 * est).toBeGreaterThan(CAP_USD);
  });

  it("a failed attempt the gateway charged for stops the retry that would pass the cap", async () => {
    script = [{ status: 502, chargedUsd: "0.010000" }];
    const res = await send(`charged-502-${Date.now()}`);
    await res.text();
    expect(res.status).toBe(429);
    expect(res.headers.get("x-clawrouter-cost-cap-exceeded")).toBe("1");
    expect(keyedHits).toBe(1); // was 2: the retry dispatched unchecked
  });

  it("control: a failed attempt with no reported charge is still retried", async () => {
    script = [{ status: 502 }, { status: 200 }];
    const res = await send(`uncharged-502-${Date.now()}`);
    await res.text();
    expect(res.status).toBe(200);
    expect(keyedHits).toBe(2);
  });

  it("a charged failure does not stand in for the successful retry's estimate", async () => {
    const session = `charged-then-ok-${Date.now()}`;
    script = [{ status: 502, chargedUsd: "0.000100" }, { status: 200 }];
    const first = await send(session);
    await first.text();
    expect(first.status).toBe(200);
    expect(keyedHits).toBe(2);

    // $0.0001 charged + the winner's estimate are both on the books, so a
    // second request no longer fits.
    const second = await send(session);
    await second.text();
    expect(second.status).toBe(429);
    expect(keyedHits).toBe(2);
  });

  it("a reported charge on success replaces the estimate", async () => {
    const session = `reported-ok-${Date.now()}`;
    script = [
      { status: 200, chargedUsd: "0.000100" },
      { status: 200, chargedUsd: "0.000100" },
    ];
    expect((await send(session)).status).toBe(200);
    // Estimate-only accounting would refuse this one: two estimates exceed the cap.
    expect((await send(session)).status).toBe(200);
    expect(keyedHits).toBe(2);
  });
});
