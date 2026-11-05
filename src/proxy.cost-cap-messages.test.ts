import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";

import { estimateAmount, startProxy, type ProxyHandle, type ProxyOptions } from "./proxy.js";
import { CAIP2_BASE, InMemorySpendControlStorage, SpendControl } from "./spend-control.js";

/**
 * A positive `maxCostPerRun` on /v1/messages. It forwards the model as sent, so it
 * never downgrades: a paid call the budget can't cover is refused in either mode.
 */

const PAID_MODEL = "anthropic/claude-sonnet-4.6";
const FREE_UPSTREAM = "nvidia/nemotron-3.5-lightning";
/** The upstream quotes this for every paid call on the wallet rail. */
const QUOTE_MICROS = 8000;
const QUOTE_USD = QUOTE_MICROS / 1_000_000;

let upstream: Server;
let billed: string[] = [];
let failNextPaid = false;

const challenge = Buffer.from(
  JSON.stringify({
    x402Version: 2,
    resource: { url: "http://127.0.0.1/paid" },
    accepts: [
      {
        scheme: "exact",
        network: CAIP2_BASE,
        amount: String(QUOTE_MICROS),
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
      const url = req.url ?? "";
      let model: string | undefined;
      try {
        model = (JSON.parse(Buffer.concat(chunks).toString()) as { model?: string }).model;
      } catch {
        model = undefined;
      }
      const isFree = model === FREE_UPSTREAM || model?.startsWith("free/") === true;
      const signed = Boolean(req.headers["payment-signature"] || req.headers["x-payment"]);
      const withKey = Boolean(req.headers.authorization);

      if (!url.startsWith("/v1/models") && !isFree) {
        if (!signed && !withKey) {
          res.writeHead(402, { "Content-Type": "application/json", "PAYMENT-REQUIRED": challenge });
          res.end(JSON.stringify({ error: "payment required" }));
          return;
        }
        if (failNextPaid) {
          failNextPaid = false;
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "upstream failed" }));
          return;
        }
        billed.push(url);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "x",
          model,
          choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 1, output_tokens: 1, prompt_tokens: 1, completion_tokens: 1 },
        }),
      );
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
}, 20_000);

afterAll(async () => {
  upstream?.closeAllConnections?.();
  await new Promise<void>((r) => upstream?.close(() => r()));
});

beforeEach(() => {
  billed = [];
  failNextPaid = false;
});

const proxies: ProxyHandle[] = [];
afterAll(async () => {
  await Promise.all(proxies.map((p) => p.close()));
});

async function proxy(
  rail: "wallet" | "key",
  cap: number,
  mode: "strict" | "graceful",
): Promise<ProxyHandle> {
  const options: ProxyOptions = {
    apiBase: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    port: 0,
    skipBalanceCheck: true,
    maxCostPerRunUsd: cap,
    maxCostPerRunMode: mode,
    spendControl: new SpendControl({ storage: new InMemorySpendControlStorage() }),
    ...(rail === "key" ? { apiKey: "brk_live_test" } : { wallet: generatePrivateKey() }),
  };
  const handle = await startProxy(options);
  proxies.push(handle);
  return handle;
}

const request = (model: string, content = "hi") =>
  JSON.stringify({ model, max_tokens: 10, messages: [{ role: "user", content }] });

function send(p: ProxyHandle, body: string, session?: string, path = "/v1/messages") {
  return fetch(`${p.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(session ? { "x-session-id": session } : {}),
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
}

/** What one priced call on the key rail counts for, and so a cap of exactly that many. */
const estimateUsd = (body: string) =>
  Number(estimateAmount(PAID_MODEL, Buffer.byteLength(body), 10)) / 1_000_000;

describe("wallet rail", () => {
  it("strict: admits what fits, then refuses to sign past the cap", async () => {
    const p = await proxy("wallet", QUOTE_USD * 1.5, "strict");
    const body = request(PAID_MODEL);
    expect((await send(p, body, "w-strict")).status).toBe(200);

    const res = await send(p, body, "w-strict");
    expect(res.status).toBe(429);
    expect(res.headers.get("x-clawrouter-cost-cap-exceeded")).toBe("1");
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("cost_cap_exceeded");
    expect(billed).toEqual(["/v1/messages"]);
  });

  it("strict: refuses at admission when the estimate alone is over the cap", async () => {
    const p = await proxy("wallet", 0.0001, "strict");
    const res = await send(p, request(PAID_MODEL));
    expect(res.status).toBe(429);
    expect(billed).toEqual([]);
  });

  it("graceful: stops once the budget can't cover the next call, with no downgrade", async () => {
    const p = await proxy("wallet", QUOTE_USD, "graceful");
    const body = request(PAID_MODEL);
    expect((await send(p, body, "w-graceful")).status).toBe(200);

    const res = await send(p, body, "w-graceful");
    expect(res.status).toBe(429);
    expect(res.headers.get("x-clawrouter-budget-mode")).toBe("blocked");
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("budget_exhausted");
    expect(billed).toEqual(["/v1/messages"]);
  });

  it("graceful: refuses an unpriced model only once nothing is left", async () => {
    const p = await proxy("wallet", QUOTE_USD, "graceful");
    expect((await send(p, request("acme/not-in-catalog"), "w-unpriced")).status).toBe(200);
    expect((await send(p, request("acme/not-in-catalog"), "w-unpriced")).status).toBe(429);
    expect(billed).toHaveLength(1);
  });

  it("charges chat and /v1/messages to the same session budget", async () => {
    const p = await proxy("wallet", QUOTE_USD, "graceful");
    expect((await send(p, request(PAID_MODEL), "w-shared", "/v1/chat/completions")).status).toBe(
      200,
    );
    expect((await send(p, request(PAID_MODEL), "w-shared")).status).toBe(429);
    expect(billed).toEqual(["/v1/chat/completions"]);
  });

  it("derives the session from the first user message when no header is sent", async () => {
    const p = await proxy("wallet", QUOTE_USD, "graceful");
    expect((await send(p, request(PAID_MODEL, "run one"))).status).toBe(200);
    expect((await send(p, request(PAID_MODEL, "run one"))).status).toBe(429);
    expect((await send(p, request(PAID_MODEL, "run two"))).status).toBe(200);
    expect(billed).toHaveLength(2);
  });

  it("shares one budget across requests with no session at all", async () => {
    const p = await proxy("wallet", QUOTE_USD, "graceful");
    const noUser = JSON.stringify({ model: PAID_MODEL, max_tokens: 10, messages: [] });
    expect((await send(p, noUser)).status).toBe(200);
    expect((await send(p, noUser)).status).toBe(429);
    expect(billed).toHaveLength(1);
  });
});

describe("API-key rail", () => {
  it("strict: counts the estimate of a successful call and refuses the next", async () => {
    const body = request(PAID_MODEL);
    const p = await proxy("key", estimateUsd(body) * 1.5, "strict");
    expect((await send(p, body, "k-strict")).status).toBe(200);
    expect((await send(p, body, "k-strict")).status).toBe(429);
    expect(billed).toEqual(["/v1/messages"]);
  });

  it("strict: holds the budget for calls in flight", async () => {
    const body = request(PAID_MODEL);
    const p = await proxy("key", estimateUsd(body) * 1.5, "strict");
    const results = await Promise.all([1, 2, 3, 4].map(() => send(p, body, "k-race")));
    expect(results.map((r) => r.status).sort()).toEqual([200, 429, 429, 429]);
    expect(billed).toHaveLength(1);
  });

  it("strict: a failed call doesn't count, and returns its hold", async () => {
    const body = request(PAID_MODEL);
    const p = await proxy("key", estimateUsd(body) * 1.5, "strict");
    failNextPaid = true;
    expect((await send(p, body, "k-fail")).status).toBe(500);
    expect((await send(p, body, "k-fail")).status).toBe(200);
    expect((await send(p, body, "k-fail")).status).toBe(429);
    expect(billed).toHaveLength(1);
  });

  it("strict: refuses an unpriced model once the session is out of budget", async () => {
    const body = request(PAID_MODEL);
    const p = await proxy("key", estimateUsd(body), "strict");
    expect((await send(p, body, "k-unpriced")).status).toBe(200);
    expect((await send(p, request("acme/not-in-catalog"), "k-unpriced")).status).toBe(429);
    expect(billed).toHaveLength(1);
  });

  it("graceful: stops once the budget can't cover the next call", async () => {
    const body = request(PAID_MODEL);
    const p = await proxy("key", estimateUsd(body) * 1.5, "graceful");
    expect((await send(p, body, "k-graceful")).status).toBe(200);
    const res = await send(p, body, "k-graceful");
    expect(res.status).toBe(429);
    expect(res.headers.get("x-clawrouter-budget-mode")).toBe("blocked");
    expect(billed).toHaveLength(1);
  });
});

describe.each([
  ["wallet", "strict"],
  ["wallet", "graceful"],
  ["key", "strict"],
  ["key", "graceful"],
] as const)("%s rail, %s mode", (rail, mode) => {
  it("still serves a free model when the budget is gone", async () => {
    const p = await proxy(rail, 0.0001, mode);
    const paid = await send(p, request(PAID_MODEL), "free-left");
    expect(paid.status).toBe(429);
    expect((await send(p, request(FREE_UPSTREAM), "free-left")).status).toBe(200);
    expect((await send(p, request("free/nemotron-3.5-lightning"), "free-left")).status).toBe(200);
    expect(billed).toEqual([]);
  });

  it("forwards a malformed body for the gateway to answer", async () => {
    const p = await proxy(rail, 1, mode);
    const res = await send(p, "{not json", "bad-json");
    expect(res.status).not.toBe(429);
    expect(res.status).not.toBe(502);
  });

  it("forwards a message with no content for the gateway to answer", async () => {
    const p = await proxy(rail, 1, mode);
    const res = await send(
      p,
      JSON.stringify({ model: PAID_MODEL, max_tokens: 10, messages: [{ role: "user" }] }),
    );
    expect(res.status).toBe(200);
    expect(billed).toEqual(["/v1/messages"]);
  });
});
