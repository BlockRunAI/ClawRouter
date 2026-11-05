/**
 * Streaming callers get the rail's Payment-Receipt (STREAMING-RECEIPT-SPEC.md, cases 1-12).
 *
 * A rail that sets `deferStreamingHeaders` makes the proxy hold the final headers of a `stream: true`
 * response until payFetch returns, keeping the client alive with HTTP 102. Loopback only: payFetch is a
 * fake, `apiBase` points at a closed loopback port, and the updater is stubbed. Receipts are fake strings.
 */
import http from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("./updater.js", () => ({ checkForUpdates: async () => {} }));
import { generatePrivateKey } from "viem/accounts";
import OpenAI from "openai";
import { startProxy } from "./proxy.js";
import { PAYMENT_SETTLED_NO_COMPLETION, type PayFetch } from "./pay-fetch.js";
import { InMemorySpendControlStorage, SpendControl, SpendPolicyError } from "./spend-control.js";

type Proxy = Awaited<ReturnType<typeof startProxy>>;

const FAKE_RECEIPT = "fake-receipt.test-only.not-a-credential.stream-0001";
const INJECTED_RECEIPT = "injected-by-caller.test-only.0002";

const completionJson = (content: string) =>
  JSON.stringify({
    id: "chatcmpl-stream-test",
    object: "chat.completion",
    created: 1,
    model: "test-model",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A paid rail fake: optional delay (abortable via init.signal), optional receipt, records forwarded headers. */
function fakeRail(opts: {
  defer?: boolean;
  delayMs?: number;
  receipt?: string | null;
  content?: string;
  fail?: () => Error;
}) {
  const seenHeaders: Array<Record<string, string>> = [];
  const aborted: boolean[] = [];
  const fn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    seenHeaders.push({ ...((init?.headers as Record<string, string>) ?? {}) });
    if (opts.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, opts.delayMs);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          aborted.push(true);
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    }
    if (opts.fail) throw opts.fail();
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.receipt) headers["Payment-Receipt"] = opts.receipt;
    return new Response(completionJson(opts.content ?? "hello"), { status: 200, headers });
  });
  const payFetch = fn as unknown as PayFetch;
  payFetch.enforcesSpend = true;
  if (opts.defer !== false) payFetch.deferStreamingHeaders = true;
  return { payFetch, fn, seenHeaders, aborted };
}

async function start(payFetch: PayFetch): Promise<Proxy> {
  return startProxy({
    spendControl: new SpendControl({ storage: new InMemorySpendControlStorage() }),
    wallet: generatePrivateKey(),
    apiBase: "http://127.0.0.1:9",
    payFetch,
    skipBalanceCheck: true,
    port: 0,
    allowExistingProxy: false,
  });
}

let nonce = 0;
/** Unique content per call so dedup/cache never couples tests unless a test means it to. */
const chatBody = (stream: boolean, content = `hi ${++nonce} ${Date.now()}`) =>
  JSON.stringify({
    model: "blockrun/auto",
    max_tokens: 8,
    stream,
    messages: [{ role: "user", content }],
  });

type RawResult = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  informational: number[];
  firstChunkBeforeMs?: number;
};

/** Raw node:http POST that records 1xx informational responses. */
function rawPost(
  baseUrl: string,
  body: string,
  extraHeaders: Record<string, string> = {},
  abortAfterMs?: number,
): Promise<RawResult> {
  const url = new URL("/v1/chat/completions", baseUrl);
  return new Promise((resolve, reject) => {
    const informational: number[] = [];
    const started = Date.now();
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: { "content-type": "application/json", ...extraHeaders },
      },
      (res) => {
        let text = "";
        let firstChunkBeforeMs: number | undefined;
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          if (firstChunkBeforeMs === undefined) firstChunkBeforeMs = Date.now() - started;
          text += c;
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: text,
            informational,
            firstChunkBeforeMs,
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("information", (info) => informational.push(info.statusCode));
    req.on("error", (err) => {
      if (abortAfterMs !== undefined) {
        resolve({ status: 0, headers: {}, body: "", informational });
      } else {
        reject(err);
      }
    });
    if (abortAfterMs !== undefined) setTimeout(() => req.destroy(), abortAfterMs);
    req.end(body);
  });
}

function sseDataLines(body: string): string[] {
  return body
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice(6));
}

describe("deferred streaming: receipt on the final 200", () => {
  const rail = fakeRail({ receipt: FAKE_RECEIPT, delayMs: 1_400, content: "streamed answer" });
  let proxy: Proxy;
  beforeAll(async () => {
    proxy = await start(rail.payFetch);
  });
  afterAll(async () => {
    await proxy?.close();
  });

  // Cases 1 and 2.
  it("sends HTTP 102 while paying, then 200 SSE carrying the exact receipt, one paid call", async () => {
    const r = await rawPost(proxy.baseUrl, chatBody(true));
    expect(r.informational.length).toBeGreaterThanOrEqual(1);
    expect(r.informational.every((s) => s === 102)).toBe(true);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("text/event-stream");
    expect(r.headers["payment-receipt"]).toBe(FAKE_RECEIPT);
    expect(String(r.headers["access-control-expose-headers"])).toMatch(/Payment-Receipt/i);
    expect(r.headers["content-length"]).toBeUndefined();
    const data = sseDataLines(r.body);
    expect(data.filter((d) => d === "[DONE]")).toHaveLength(1);
    const chunks = data.filter((d) => d !== "[DONE]").map((d) => JSON.parse(d));
    const text = chunks.map((c) => c.choices?.[0]?.delta?.content ?? "").join("");
    expect(text).toBe("streamed answer");
    expect(rail.fn).toHaveBeenCalledTimes(1);
  });
});

// Case 3: the OpenAI SDK (OpenClaw's client) consumes the stream after 102s and does not retry.
describe("deferred streaming: OpenAI client compatibility", () => {
  const rail = fakeRail({ receipt: FAKE_RECEIPT, delayMs: 1_400, content: "sdk ok" });
  let proxy: Proxy;
  beforeAll(async () => {
    proxy = await start(rail.payFetch);
  });
  afterAll(async () => {
    await proxy?.close();
  });

  it("streams normally through 102s, exposes the receipt, and makes one paid call", async () => {
    const client = new OpenAI({ baseURL: `${proxy.baseUrl}/v1`, apiKey: "unused-loopback" });
    const { data: stream, response } = await client.chat.completions
      .create({
        model: "blockrun/auto",
        max_tokens: 8,
        stream: true,
        messages: [{ role: "user", content: `sdk ${Date.now()}` }],
      })
      .withResponse();
    expect(response.status).toBe(200);
    expect(response.headers.get("payment-receipt")).toBe(FAKE_RECEIPT);
    let text = "";
    for await (const chunk of stream) text += chunk.choices[0]?.delta?.content ?? "";
    expect(text).toBe("sdk ok");
    expect(rail.fn).toHaveBeenCalledTimes(1); // the SDK retries on errors; one call means no retry
  });
});

describe("deferred streaming: receipt absence, injection, errors", () => {
  afterEach(() => vi.restoreAllMocks());

  // Case 4.
  it("adds no receipt when the upstream returned none", async () => {
    const rail = fakeRail({ receipt: null });
    const proxy = await start(rail.payFetch);
    try {
      const r = await rawPost(proxy.baseUrl, chatBody(true));
      expect(r.status).toBe(200);
      expect(r.headers["payment-receipt"]).toBeUndefined();
      expect(sseDataLines(r.body)).toContain("[DONE]");
    } finally {
      await proxy.close();
    }
  });

  // Case 9.
  it("never forwards a caller-supplied Payment-Receipt or echoes it back", async () => {
    const noReceipt = fakeRail({ receipt: null });
    const p1 = await start(noReceipt.payFetch);
    try {
      const r = await rawPost(p1.baseUrl, chatBody(true), { "Payment-Receipt": INJECTED_RECEIPT });
      expect(r.status).toBe(200);
      expect(r.headers["payment-receipt"]).toBeUndefined();
      expect(Object.keys(noReceipt.seenHeaders[0]).map((k) => k.toLowerCase())).not.toContain(
        "payment-receipt",
      );
      // Non-streaming path too.
      const r2 = await rawPost(p1.baseUrl, chatBody(false), {
        "Payment-Receipt": INJECTED_RECEIPT,
      });
      expect(r2.status).toBe(200);
      expect(r2.headers["payment-receipt"]).toBeUndefined();
    } finally {
      await p1.close();
    }
    const withReceipt = fakeRail({ receipt: FAKE_RECEIPT });
    const p2 = await start(withReceipt.payFetch);
    try {
      const r = await rawPost(p2.baseUrl, chatBody(true), { "Payment-Receipt": INJECTED_RECEIPT });
      expect(r.headers["payment-receipt"]).toBe(FAKE_RECEIPT); // only the upstream's own receipt
    } finally {
      await p2.close();
    }
  });

  // Case 5.
  it("answers a spend-policy refusal with a real 403, no receipt, one call", async () => {
    const rail = fakeRail({
      receipt: FAKE_RECEIPT,
      fail: () => new SpendPolicyError("perRequest limit"),
    });
    const proxy = await start(rail.payFetch);
    try {
      const r = await rawPost(proxy.baseUrl, chatBody(true));
      expect(r.status).toBe(403);
      expect(r.headers["content-type"]).toMatch(/application\/json/);
      expect(r.headers["payment-receipt"]).toBeUndefined();
      expect(r.body).toContain("spend_policy_denied");
      expect(rail.fn).toHaveBeenCalledTimes(1); // no retry, no fallback model
    } finally {
      await proxy.close();
    }
  });

  // Case 6.
  it("answers paid-no-completion with a real 502, no receipt, exactly one paid call", async () => {
    const rail = fakeRail({
      receipt: FAKE_RECEIPT,
      fail: () => {
        const e = new Error("signed and sent, no completion (HTTP 503)") as Error & {
          reference?: string;
        };
        e.name = PAYMENT_SETTLED_NO_COMPLETION;
        e.reference = "ref-fake-stream";
        return e;
      },
    });
    const proxy = await start(rail.payFetch);
    try {
      const r = await rawPost(proxy.baseUrl, chatBody(true));
      expect(r.status).toBe(502);
      expect(r.headers["payment-receipt"]).toBeUndefined();
      const body = JSON.parse(r.body) as { error: { type: string } };
      expect(body.error.type).toBe("payment_settled_no_completion");
      expect(rail.fn).toHaveBeenCalledTimes(1);
    } finally {
      await proxy.close();
    }
  });
});

describe("deferred streaming: dedup and cache", () => {
  // Case 7.
  it("coalesces concurrent identical streams onto one paid call; both get the receipt", async () => {
    const rail = fakeRail({ receipt: FAKE_RECEIPT, delayMs: 1_400, content: "shared" });
    const proxy = await start(rail.payFetch);
    try {
      const body = chatBody(true, `coalesce ${Date.now()}`);
      const first = rawPost(proxy.baseUrl, body);
      await sleep(150); // let the first register in-flight
      const second = rawPost(proxy.baseUrl, body);
      const [a, b] = await Promise.all([first, second]);
      expect(rail.fn).toHaveBeenCalledTimes(1);
      for (const r of [a, b]) {
        expect(r.status).toBe(200);
        expect(r.headers["payment-receipt"]).toBe(FAKE_RECEIPT);
        expect(r.headers["x-clawrouter-cache"]).toBeUndefined();
      }
      expect(b.informational).toContain(102);
      // Same transcript (the routing debug comment is live-only and not part of the dedup record).
      expect(sseDataLines(b.body)).toEqual(sseDataLines(a.body));
    } finally {
      await proxy.close();
    }
  });

  // Case 8.
  it("a completed dedup replay pays nothing and claims no receipt", async () => {
    const rail = fakeRail({ receipt: FAKE_RECEIPT, content: "once" });
    const proxy = await start(rail.payFetch);
    try {
      const body = chatBody(true, `replay ${Date.now()}`);
      const a = await rawPost(proxy.baseUrl, body);
      const b = await rawPost(proxy.baseUrl, body);
      expect(rail.fn).toHaveBeenCalledTimes(1);
      expect(a.headers["payment-receipt"]).toBe(FAKE_RECEIPT);
      expect(b.status).toBe(200);
      expect(b.headers["payment-receipt"]).toBeUndefined();
      expect(b.headers["x-clawrouter-cache"]).toBe("HIT");
      expect(sseDataLines(b.body)).toEqual(sseDataLines(a.body));
    } finally {
      await proxy.close();
    }
  });

  it("a non-streaming cache or dedup hit claims no receipt either", async () => {
    const rail = fakeRail({ receipt: FAKE_RECEIPT });
    const proxy = await start(rail.payFetch);
    try {
      const body = chatBody(false, `json replay ${Date.now()}`);
      const a = await rawPost(proxy.baseUrl, body);
      const b = await rawPost(proxy.baseUrl, body);
      expect(rail.fn).toHaveBeenCalledTimes(1);
      expect(a.headers["payment-receipt"]).toBe(FAKE_RECEIPT);
      expect(b.status).toBe(200);
      expect(b.headers["payment-receipt"]).toBeUndefined();
      expect(b.headers["x-clawrouter-cache"]).toBe("HIT");
    } finally {
      await proxy.close();
    }
  });
});

// Case 10.
describe("deferred streaming: client disconnect", () => {
  it("aborts the paid call, stops the 102 timer, and frees the in-flight slot", async () => {
    const rail = fakeRail({ receipt: FAKE_RECEIPT, delayMs: 5_000 });
    const fast = fakeRail({ receipt: FAKE_RECEIPT });
    const proxy = await start(rail.payFetch);
    try {
      // Warm up (fast) so lazily created proxy timers exist before the baseline.
      rail.fn.mockImplementationOnce(fast.fn);
      await rawPost(proxy.baseUrl, chatBody(false));
      rail.fn.mockClear();
      const timers = () => process.getActiveResourcesInfo().filter((t) => t === "Timeout").length;
      const baseline = timers();

      const body = chatBody(true, `disconnect ${Date.now()}`);
      const r = await rawPost(proxy.baseUrl, body, {}, 1_300);
      expect(r.informational).toContain(102);
      await sleep(300);
      expect(rail.aborted).toEqual([true]);
      expect(timers()).toBeLessThanOrEqual(baseline);

      // The slot is free: the same body is a new request, not a waiter on a dead one.
      rail.fn.mockImplementationOnce(fast.fn);
      const again = await rawPost(proxy.baseUrl, body);
      expect(again.status).toBe(200);
      expect(rail.fn).toHaveBeenCalledTimes(2);
    } finally {
      await proxy.close();
    }
  }, 15_000);
});

// Case 11.
describe("legacy streaming: rail without deferStreamingHeaders", () => {
  it("still commits 200 SSE at once with a heartbeat before the paid call returns", async () => {
    const rail = fakeRail({ defer: false, receipt: FAKE_RECEIPT, delayMs: 1_400 });
    const proxy = await start(rail.payFetch);
    try {
      const r = await rawPost(proxy.baseUrl, chatBody(true));
      expect(r.informational).toEqual([]);
      expect(r.status).toBe(200);
      expect(r.body.startsWith(": heartbeat\n\n")).toBe(true);
      expect(r.firstChunkBeforeMs).toBeLessThan(1_000);
      // Known limitation the capability exists to fix: headers left before the receipt existed.
      expect(r.headers["payment-receipt"]).toBeUndefined();
      expect(sseDataLines(r.body)).toContain("[DONE]");
    } finally {
      await proxy.close();
    }
  });
});
