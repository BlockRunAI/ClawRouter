import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";

import { estimateAmount, startProxy, type ProxyHandle, type ProxyOptions } from "./proxy.js";
import { CAIP2_BASE, InMemorySpendControlStorage, SpendControl } from "./spend-control.js";

/**
 * `maxCostPerRun: 0` means nothing gets paid for, on any route and either rail.
 * The wallet rail is refused where it signs and the key rail where it fetches,
 * because those are the only places every paid call passes through. Free calls
 * and account reads still work.
 */

const PAID_MODEL = "anthropic/claude-sonnet-4.6";
const FREE_UPSTREAM = "nvidia/nemotron-3.5-lightning";
const KEY = "brk_live_test";

let upstream: Server;
/** Calls the upstream would bill: a signed payment, or anything sent with the key. */
let billed: string[] = [];

const challenge = Buffer.from(
  JSON.stringify({
    x402Version: 2,
    resource: { url: "http://127.0.0.1/paid" },
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
      const url = req.url ?? "";
      const raw = Buffer.concat(chunks).toString();
      let model: string | undefined;
      try {
        model = raw ? (JSON.parse(raw) as { model?: string }).model : undefined;
      } catch {
        model = undefined;
      }
      const isCatalog = url.startsWith("/v1/models");
      const isFree = model === FREE_UPSTREAM || model?.startsWith("nvidia/") === true;
      const isAccountRead = req.method === "GET" && url.startsWith("/v1/usage");
      const signed = Boolean(req.headers["payment-signature"] || req.headers["x-payment"]);
      const withKey = Boolean(req.headers.authorization);

      if (!isCatalog && !isFree && !isAccountRead) {
        if (!signed && !withKey) {
          res.writeHead(402, {
            "Content-Type": "application/json",
            "PAYMENT-REQUIRED": challenge,
          });
          res.end(JSON.stringify({ error: "payment required" }));
          return;
        }
        billed.push(url);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "x",
          object: "chat.completion",
          model,
          data: [{ url: "data:image/png;base64,AAAA" }],
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
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
});

const proxies: ProxyHandle[] = [];
afterAll(async () => {
  await Promise.all(proxies.map((p) => p.close()));
});

async function proxy(
  rail: "wallet" | "key",
  cap: number,
  mode: "strict" | "graceful" = "graceful",
): Promise<ProxyHandle> {
  const options: ProxyOptions = {
    apiBase: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    port: 0,
    skipBalanceCheck: true,
    maxCostPerRunUsd: cap,
    maxCostPerRunMode: mode,
    spendControl: new SpendControl({ storage: new InMemorySpendControlStorage() }),
    ...(rail === "key" ? { apiKey: KEY } : { wallet: generatePrivateKey() }),
  };
  const handle = await startProxy(options);
  proxies.push(handle);
  return handle;
}

function post(p: ProxyHandle, path: string, body: unknown): Promise<Response> {
  return fetch(`${p.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
}

const user = (content: string) => [{ role: "user", content }];

const PAID_ROUTES: Array<[string, () => { path: string; body: unknown }]> = [
  [
    "/v1/messages",
    () => ({
      path: "/v1/messages",
      body: { model: PAID_MODEL, max_tokens: 10, messages: user("hi") },
    }),
  ],
  [
    "/v1/audio/speech",
    () => ({
      path: "/v1/audio/speech",
      body: { model: "elevenlabs/eleven-v3", input: "hi", voice: "x" },
    }),
  ],
  [
    "/v1/images/generations",
    () => ({
      path: "/v1/images/generations",
      body: { model: "openai/gpt-image-1", prompt: "apple" },
    }),
  ],
  [
    "/v1/audio/generations",
    () => ({
      path: "/v1/audio/generations",
      body: { model: "minimax/music-2.5", prompt: "song" },
    }),
  ],
  [
    "/v1/videos/generations",
    () => ({
      path: "/v1/videos/generations",
      body: { model: "xai/grok-imagine-video", prompt: "clip" },
    }),
  ],
  ["/v1/exa/search", () => ({ path: "/v1/exa/search", body: { query: "x" } })],
  [
    "the /imagegen chat command",
    () => ({
      path: "/v1/chat/completions",
      body: { model: "auto", messages: user("/imagegen a red apple") },
    }),
  ],
];

async function expectRefused(res: Response): Promise<void> {
  expect(res.status).toBe(429);
  expect(res.headers.get("x-clawrouter-cost-cap-exceeded")).toBe("1");
  const json = (await res.json()) as { error: { type: string } };
  expect(json.error.type).toBe("cost_cap_exceeded");
  expect(billed).toEqual([]);
}

describe("maxCostPerRun of 0", () => {
  describe.each(["wallet", "key"] as const)("on the %s rail", (rail) => {
    it.each(PAID_ROUTES)("refuses %s", async (_name, route) => {
      const p = await proxy(rail, 0);
      const { path, body } = route();
      await expectRefused(await post(p, path, body));
    });

    it("still serves a free model over /v1/messages", async () => {
      const p = await proxy(rail, 0);
      const res = await post(p, "/v1/messages", {
        model: FREE_UPSTREAM,
        max_tokens: 10,
        messages: user("hi"),
      });
      expect(res.status).toBe(200);
      expect(billed).toEqual([]);
    });

    it.each(["strict", "graceful"] as const)(
      "still serves a free chat model in %s mode",
      async (mode) => {
        const p = await proxy(rail, 0, mode);
        const res = await post(p, "/v1/chat/completions", {
          model: "free/nemotron-3.5-lightning",
          max_tokens: 10,
          messages: user("hi"),
        });
        expect(res.status).toBe(200);
        expect(billed).toEqual([]);
      },
    );

    it.each(["strict", "graceful"] as const)(
      "refuses a paid chat model with no session to charge in %s mode",
      async (mode) => {
        const p = await proxy(rail, 0, mode);
        const res = await post(p, "/v1/chat/completions", {
          model: PAID_MODEL,
          max_tokens: 10,
          messages: [{ role: "system", content: "be brief" }],
        });
        expect(res.status).toBe(429);
        expect(billed).toEqual([]);
      },
    );
  });

  it.each([
    ["a partner data route", "/v1/pm/markets"],
    ["the poll that settles a finished video", "/v1/videos/generations/job-1"],
    ["a data route outside the partner prefixes", "/v1/defillama/protocols"],
    ["a route it has never heard of", "/v1/something-new"],
  ])("refuses a GET to %s on the key rail", async (_name, path) => {
    const p = await proxy("key", 0);
    await expectRefused(await fetch(`${p.baseUrl}${path}`));
  });

  it("still lets the key rail read account data", async () => {
    const p = await proxy("key", 0);
    const res = await fetch(`${p.baseUrl}/v1/usage`);
    expect(res.status).toBe(200);
    expect(billed).toEqual([]);
  });

  it("refuses a model with no local price in strict mode on the key rail", async () => {
    const p = await proxy("key", 0, "strict");
    const res = await post(p, "/v1/chat/completions", {
      model: "acme/not-in-catalog",
      max_tokens: 10,
      messages: user("hi"),
    });
    expect(res.status).toBe(429);
    expect(billed).toEqual([]);
  });
});

describe("a positive maxCostPerRun", () => {
  it("still counts requests that carry no session", async () => {
    // Under the floor of any priced call, so a session-less request must be refused.
    const p = await proxy("wallet", 0.0001, "strict");
    const res = await post(p, "/v1/chat/completions", {
      model: PAID_MODEL,
      max_tokens: 10,
      messages: [{ role: "system", content: "be brief" }],
    });
    expect(res.status).toBe(429);
    expect(billed).toEqual([]);
  });

  it("refuses an unpriced model on the key rail once the session is out of budget", async () => {
    const PRICED = "google/gemini-2.5-flash-lite";
    const body = (model: string) => JSON.stringify({ model, max_tokens: 1, messages: user("hi") });
    // A cap of exactly one priced call, so that call leaves nothing behind.
    const estimate = estimateAmount(PRICED, Buffer.byteLength(body(PRICED)), 1);
    const p = await proxy("key", Number(estimate) / 1_000_000, "strict");
    const send = (model: string) =>
      fetch(`${p.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-session-id": "key-exhausted" },
        body: body(model),
      });

    expect((await send(PRICED)).status).toBe(200);
    expect(billed).toHaveLength(1);

    const res = await send("acme/not-in-catalog");
    expect(res.status).toBe(429);
    expect(billed).toHaveLength(1);
  });

  it("leaves routes outside chat and /v1/messages uncapped, as documented", async () => {
    const p = await proxy("wallet", 0.0001);
    const res = await post(p, "/v1/audio/speech", {
      model: "elevenlabs/eleven-v3",
      input: "hi",
      voice: "x",
    });
    expect(res.status).toBe(200);
    expect(billed).toEqual(["/v1/audio/speech"]);
  });
});

describe("a cap that is not a finite number", () => {
  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["null", null as unknown as number],
  ])("%s means no cap, and an identical retry does not hang", async (_name, cap) => {
    const p = await proxy("wallet", cap, "strict");
    const send = () =>
      post(p, "/v1/chat/completions", {
        model: PAID_MODEL,
        max_tokens: 10,
        messages: user("identical retry"),
      });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
  });
});
