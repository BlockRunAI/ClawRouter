import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./updater.js", () => ({ checkForUpdates: async () => {} }));
import { generatePrivateKey } from "viem/accounts";
import { startProxy } from "./proxy.js";
import { PAYMENT_SETTLED_NO_COMPLETION, type PayFetch } from "./pay-fetch.js";
import { InMemorySpendControlStorage, SpendControl } from "./spend-control.js";

const proxies: Awaited<ReturnType<typeof startProxy>>[] = [];
afterEach(async () => {
  for (const proxy of proxies.splice(0)) await proxy.close();
});
const frame = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;

function fixture(mode: "success" | "error" | "stall" = "success") {
  const bodies: Record<string, unknown>[] = [];
  const cancelled = vi.fn();
  let finished = false;
  let original: Response;
  const fn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)));
    let timer: ReturnType<typeof setTimeout>;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(frame("one ")));
        if (mode === "stall") return;
        timer = setTimeout(() => {
          if (mode === "error") {
            controller.enqueue(encoder.encode('data: {"error":"fixture model failed"}\n\n'));
          } else {
            controller.enqueue(encoder.encode(frame("two")));
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3}}\n\ndata: [DONE]\n\n',
              ),
            );
            finished = true;
          }
          controller.close();
        }, 250);
      },
      cancel() {
        clearTimeout(timer);
        cancelled();
      },
    });
    original = new Response(body, {
      headers: { "content-type": "text/event-stream", "payment-receipt": "native-fixture-receipt" },
    });
    return original;
  });
  const payFetch = fn as unknown as PayFetch;
  payFetch.supportsNativeStreaming = true;
  payFetch.enforcesSpend = true;
  payFetch.onNoCompletion = vi.fn((response, reason) => {
    expect(response).toBe(original);
    throw Object.assign(new Error(reason), { name: PAYMENT_SETTLED_NO_COMPLETION });
  });
  return { payFetch, fn, bodies, cancelled, finished: () => finished };
}

async function start(payFetch: PayFetch, requestTimeoutMs?: number) {
  const proxy = await startProxy({
    wallet: generatePrivateKey(),
    port: 0,
    skipBalanceCheck: true,
    paymentChain: "base",
    apiBase: "http://127.0.0.1:1",
    allowExistingProxy: false,
    payFetch,
    requestTimeoutMs,
    spendControl: new SpendControl({ storage: new InMemorySpendControlStorage() }),
  });
  proxies.push(proxy);
  return proxy;
}
const body = () =>
  JSON.stringify({
    model: "openai/gpt-4o-mini",
    stream: true,
    max_tokens: 8,
    messages: [{ role: "user", content: `native-${Math.random()}` }],
  });
const post = (url: string, payload: string, signal?: AbortSignal) =>
  fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
    signal,
  });
async function firstContent(response: Response) {
  const reader = response.body!.getReader();
  let text = "";
  while (!text.includes("one ")) {
    const next = await reader.read();
    expect(next.done).toBe(false);
    text += new TextDecoder().decode(next.value);
  }
  return { reader, text };
}
async function rest(read: Awaited<ReturnType<typeof firstContent>>) {
  let text = read.text;
  while (true) {
    const next = await read.reader.read();
    if (next.done) return text;
    text += new TextDecoder().decode(next.value);
  }
}

describe("native upstream delivery", () => {
  it("sends short content before the upstream finishes and forwards receipt and usage", async () => {
    const rail = fixture();
    const proxy = await start(rail.payFetch);
    const response = await post(proxy.baseUrl, body());
    const first = await firstContent(response);
    expect(rail.finished()).toBe(false);
    expect(response.headers.get("payment-receipt")).toBe("native-fixture-receipt");
    const wire = await rest(first);
    expect(wire).toContain('"content":"two"');
    expect(wire).toContain('"prompt_tokens":2');
    const usageFrames = wire
      .split("\n")
      .filter((line) => line.startsWith("data: {"))
      .map((line) => JSON.parse(line.slice(6)))
      .filter((chunk) => chunk.usage);
    expect(usageFrames).toHaveLength(1);
    expect(wire.split("data: [DONE]")).toHaveLength(2);
    expect(rail.bodies[0]).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(rail.fn).toHaveBeenCalledTimes(1);
  });

  it("streams a single paid attempt to coalesced callers, then strips the receipt on a completed replay", async () => {
    const rail = fixture();
    const proxy = await start(rail.payFetch);
    const payload = body();
    const one = await firstContent(await post(proxy.baseUrl, payload));
    const response = await post(proxy.baseUrl, payload);
    const two = await firstContent(response);
    expect(rail.finished()).toBe(false);
    expect(response.headers.get("payment-receipt")).toBe("native-fixture-receipt");
    expect(await rest(one)).toBe(await rest(two));
    const replay = await post(proxy.baseUrl, payload);
    expect(replay.headers.get("payment-receipt")).toBeNull();
    expect(replay.headers.get("x-clawrouter-cache")).toBe("HIT");
    await replay.text();
    expect(rail.fn).toHaveBeenCalledTimes(1);
  });

  it("gives every coalesced caller the same terminal paid error without retry", async () => {
    const rail = fixture("error");
    const proxy = await start(rail.payFetch);
    const payload = body();
    const one = await firstContent(await post(proxy.baseUrl, payload));
    const two = await firstContent(await post(proxy.baseUrl, payload));
    const [a, b] = await Promise.all([rest(one), rest(two)]);
    expect(a).toBe(b);
    expect(a).toContain("payment_settled_no_completion");
    expect(rail.payFetch.onNoCompletion).toHaveBeenCalledTimes(1);
    expect(rail.fn).toHaveBeenCalledTimes(1);
  });

  it("cancels the upstream and notifies the paid rail when the original client disconnects", async () => {
    const rail = fixture("stall");
    const proxy = await start(rail.payFetch);
    const abort = new AbortController();
    const response = await post(proxy.baseUrl, body(), abort.signal);
    const first = await firstContent(response);
    abort.abort();
    await first.reader.read().catch(() => {});
    await vi.waitFor(() => expect(rail.cancelled).toHaveBeenCalledTimes(1));
    expect(rail.payFetch.onNoCompletion).toHaveBeenCalledTimes(1);
    expect(rail.fn).toHaveBeenCalledTimes(1);
  });

  it("keeps the shared paid stream alive when the producer disconnects but a joiner remains", async () => {
    const rail = fixture();
    const proxy = await start(rail.payFetch);
    const payload = body();
    const abort = new AbortController();
    const original = await firstContent(await post(proxy.baseUrl, payload, abort.signal));
    const joiner = await firstContent(await post(proxy.baseUrl, payload));

    abort.abort();
    await original.reader.read().catch(() => {});
    const joinerWire = await rest(joiner);

    expect(joinerWire).toContain('"content":"two"');
    expect(joinerWire).toContain("data: [DONE]");
    expect(rail.cancelled).not.toHaveBeenCalled();
    expect(rail.payFetch.onNoCompletion).not.toHaveBeenCalled();
    expect(rail.fn).toHaveBeenCalledTimes(1);
  });

  it("retains the global deadline throughout a stalled response body", async () => {
    const rail = fixture("stall");
    const proxy = await start(rail.payFetch, 200);
    const response = await post(proxy.baseUrl, body());
    const wire = await response.text();
    expect(wire).toContain("payment_settled_no_completion");
    expect(rail.cancelled).toHaveBeenCalledTimes(1);
    expect(rail.payFetch.onNoCompletion).toHaveBeenCalledTimes(1);
    expect(rail.fn).toHaveBeenCalledTimes(1);
  });

  it("keeps the upstream non-streaming for a rail without the capability", async () => {
    let upstream: Record<string, unknown> = {};
    const rail: PayFetch = async (_input, init) => {
      upstream = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array));
      return new Response(JSON.stringify({ choices: [{ message: { content: "legacy" } }] }), {
        headers: { "content-type": "application/json" },
      });
    };
    const proxy = await start(rail);
    await (await post(proxy.baseUrl, body())).text();
    expect(upstream.stream).toBe(false);
    expect(upstream.stream_options).toBeUndefined();
  });
});
