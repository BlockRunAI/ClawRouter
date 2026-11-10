import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough, Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";

import { relayWithIdleTimeout, startProxy, type ProxyHandle, type ProxyOptions } from "./proxy.js";
import { CAIP2_BASE, InMemorySpendControlStorage, SpendControl } from "./spend-control.js";

/**
 * /v1/messages relays its response as it arrives, and a read that fails can't reach
 * the client as a 200 with an empty or cut-off body that looks complete.
 */

const MODEL = "anthropic/claude-sonnet-4.6";

let upstream: Server;
let handler: (res: ServerResponse) => void = (res) => res.end();
let upstreamClosed: Promise<void> = Promise.resolve();
let onUpstreamClosed = () => {};

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
    req.resume();
    req.on("end", () => {
      const url = req.url ?? "";
      if (url.startsWith("/v1/models")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"data":[]}');
        return;
      }
      const paid = req.headers.authorization || req.headers["payment-signature"];
      if (!paid && !req.headers["x-payment"]) {
        res.writeHead(402, { "Content-Type": "application/json", "PAYMENT-REQUIRED": challenge });
        res.end("{}");
        return;
      }
      res.on("close", () => onUpstreamClosed());
      handler(res);
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
}, 20_000);

const proxies: ProxyHandle[] = [];
afterAll(async () => {
  await Promise.all(proxies.map((p) => p.close()));
  upstream?.closeAllConnections?.();
  await new Promise<void>((r) => upstream?.close(() => r()));
});

async function proxy(rail: "wallet" | "key", extra: Partial<ProxyOptions> = {}) {
  const handle = await startProxy({
    apiBase: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    port: 0,
    skipBalanceCheck: true,
    spendControl: new SpendControl({ storage: new InMemorySpendControlStorage() }),
    ...(rail === "key" ? { apiKey: "brk_live_test" } : { wallet: generatePrivateKey() }),
    ...extra,
  });
  proxies.push(handle);
  return handle;
}

const post = (p: ProxyHandle, path: string, signal?: AbortSignal) =>
  fetch(`${p.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 5,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }),
    signal: signal ?? AbortSignal.timeout(15_000),
  });

describe.each(["wallet", "key"] as const)("/v1/messages on the %s rail", (rail) => {
  it("relays each chunk before the upstream has finished", async () => {
    let finish = () => {};
    handler = (res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("event: message_start\n\n");
      finish = () => {
        res.write("event: message_stop\n\n");
        res.end();
      };
    };
    const p = await proxy(rail);
    const res = await post(p, "/v1/messages");
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();

    const first = await reader.read();
    expect(Buffer.from(first.value!).toString()).toBe("event: message_start\n\n");

    finish();
    const second = await reader.read();
    expect(Buffer.from(second.value!).toString()).toBe("event: message_stop\n\n");
    expect((await reader.read()).done).toBe(true);
  });

  it("breaks the client's connection when the upstream dies mid-stream", async () => {
    handler = (res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("event: message_start\n\n");
      setTimeout(() => res.destroy(), 20);
    };
    const p = await proxy(rail);
    const res = await post(p, "/v1/messages");
    await expect(res.text()).rejects.toThrow();
  });

  it("cancels the upstream call when the client goes away", async () => {
    upstreamClosed = new Promise((r) => {
      onUpstreamClosed = r;
    });
    handler = (res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("event: message_start\n\n");
    };
    const p = await proxy(rail);
    const client = new AbortController();
    const res = await post(p, "/v1/messages", client.signal);
    await res.body!.getReader().read();
    client.abort();
    await upstreamClosed;
  });

  it("returns its cost-cap hold when the stream ends", async () => {
    handler = (res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end("event: message_stop\n\n");
    };
    const p = await proxy(rail, { maxCostPerRunUsd: 5, maxCostPerRunMode: "strict" });
    for (let i = 0; i < 3; i++) {
      const res = await post(p, "/v1/messages");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("event: message_stop\n\n");
    }
  });

  it("releases in-flight budget reservation immediately when client disconnects during SSE relay", async () => {
    let upstreamAbortedResolve: () => void;
    const upstreamAborted = new Promise<void>((r) => {
      upstreamAbortedResolve = r;
    });

    handler = (res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("event: message_start\n\n");
      res.on("close", () => {
        if (!res.writableEnded) upstreamAbortedResolve();
      });
    };

    // Cap is $0.020. Each request holds an estimate of $0.008.
    // If the in-flight hold is NOT released on disconnect, a second request would be rejected
    // (on wallet rail: 0.008 spent + 0.008 dangling hold + 0.008 next estimate = 0.024 > 0.020).
    const p = await proxy(rail, { maxCostPerRunUsd: 0.02, maxCostPerRunMode: "strict" });
    const client = new AbortController();
    const res = await post(p, "/v1/messages", client.signal);
    await res.body!.getReader().read();

    // Client disconnects mid-stream
    client.abort();
    await upstreamAborted;

    // Next request must be admitted because the hold was released
    handler = (res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end("event: message_stop\n\n");
    };
    const nextRes = await post(p, "/v1/messages");
    expect(nextRes.status).toBe(200);
    expect(await nextRes.text()).toBe("event: message_stop\n\n");
  });
});

describe("a buffered route", () => {
  it.each(["wallet", "key"] as const)(
    "answers 502, not an empty 200, when the body can't be read (%s rail)",
    async (rail) => {
      handler = (res) => {
        res.writeHead(200, { "Content-Type": "audio/mpeg" });
        res.write("partial");
        setTimeout(() => res.destroy(), 20);
      };
      const p = await proxy(rail);
      const res = await post(p, "/v1/audio/speech");
      expect(res.status).toBe(502);
    },
  );
});

describe("relayWithIdleTimeout", () => {
  const sink = () => {
    const chunks: string[] = [];
    const out = new PassThrough();
    out.on("data", (c: Buffer) => chunks.push(c.toString()));
    return { out, chunks };
  };

  it("fails when the source goes quiet, and destroys the destination", async () => {
    const source = new PassThrough();
    source.write("start");
    const { out } = sink();
    await expect(
      relayWithIdleTimeout(source, out, 30, new AbortController().signal),
    ).rejects.toThrow("Body read timeout");
    expect(out.destroyed).toBe(true);
  });

  it("allows a total longer than the limit, as long as chunks keep coming", async () => {
    async function* slow() {
      for (const part of ["a", "b", "c", "d"]) {
        await new Promise((r) => setTimeout(r, 25));
        yield part;
      }
    }
    const { out, chunks } = sink();
    await relayWithIdleTimeout(Readable.from(slow()), out, 60, new AbortController().signal);
    expect(chunks.join("")).toBe("abcd");
  });
});
