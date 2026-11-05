/**
 * OpenClaw compatibility gate for deferred streaming headers (STREAMING-RECEIPT-SPEC.md §3.3).
 *
 * Drives OpenClaw's real model transport against a loopback proxy whose paid call is held for PAY_DELAY_MS:
 * `@openclaw/ai` createNodeLlmRuntime + registerBuiltInApiProviders, api "openai-completions". That is the
 * registry the gateway builds (it calls registerBuiltInApiProviders), so this is the "direct" completions
 * path an OpenAI-compatible provider such as ClawRouter takes. It then records what OpenClaw's run
 * watchdog (streamWithIdleTimeout) can observe:
 *
 *  - provider acceptance: a 2xx response's headers. `onResponse` fires at the same point as the
 *    acceptance observer that ends the first-event deadline (CLOUD_LLM_FIRST_EVENT_TIMEOUT_MS = 120 s);
 *  - request activity: `onLlmRequestActivity`, which re-arms the idle deadline (DEFAULT_LLM_IDLE_TIMEOUT_MS
 *    = 120 s, armed at acceptance).
 *
 * Finding (2026.9.4 and 2026.10.9): on this path neither HTTP 102 nor the legacy `: heartbeat` SSE comments
 * reach the watchdog. Legacy: accepted at ~0, then 120 s idle until the first data chunk. Deferred: 120 s
 * first-event until the final 200, whose data follows at once. Same budget for the paid call either way.
 *
 * Set OPENCLAW_AI_DIR to an `@openclaw/ai` package directory to test another OpenClaw install (default: the
 * devDependency). Loopback only; payFetch is a fake; receipts are fake strings.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("./updater.js", () => ({ checkForUpdates: async () => {} }));
import { generatePrivateKey } from "viem/accounts";
import { startProxy } from "./proxy.js";
import { PAYMENT_SETTLED_NO_COMPLETION, type PayFetch } from "./pay-fetch.js";
import { InMemorySpendControlStorage, SpendControl } from "./spend-control.js";

type AiModules = {
  createApiRegistry: () => unknown;
  createNodeLlmRuntime: (registry: unknown) => {
    stream: (model: unknown, context: unknown, options: unknown) => AsyncIterable<unknown>;
  };
  registerBuiltInApiProviders: (registry: unknown) => void;
  onLlmRequestActivity: (signal: AbortSignal, listener: (progress: boolean) => void) => () => void;
};
let ai: AiModules;
let aiVersion = "devDependency";

async function loadOpenClawAi(): Promise<AiModules> {
  const dir = process.env.OPENCLAW_AI_DIR;
  const spec = (sub: string, file: string) =>
    dir ? pathToFileURL(path.join(dir, "dist", file)).href : `@openclaw/ai${sub}`;
  if (dir) {
    const { createRequire } = await import("node:module");
    aiVersion = createRequire(import.meta.url)(path.join(dir, "package.json")).version;
  }
  const index = await import(spec("", "index.mjs"));
  const providers = await import(spec("/providers", "providers.mjs"));
  const runtime = await import(spec("/internal/runtime", "internal/runtime.mjs"));
  return {
    createApiRegistry: index.createApiRegistry,
    // 2026.10.x: createNodeLlmRuntime; 2026.9.x exposes only createLlmRuntime.
    createNodeLlmRuntime: index.createNodeLlmRuntime ?? index.createLlmRuntime,
    registerBuiltInApiProviders: providers.registerBuiltInApiProviders,
    onLlmRequestActivity: runtime.onLlmRequestActivity,
  };
}

const FAKE_RECEIPT = "fake-receipt.test-only.not-a-credential.openclaw-0001";
const PAY_DELAY_MS = 5_500; // spans the 102s sent at 1 s, 3 s, 5 s

function rail(defer: boolean) {
  const fn = vi.fn(async () => {
    await new Promise((r) => setTimeout(r, PAY_DELAY_MS));
    return new Response(
      JSON.stringify({
        id: "chatcmpl-openclaw",
        object: "chat.completion",
        created: 1,
        model: "test-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "openclaw ok" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json", "Payment-Receipt": FAKE_RECEIPT },
      },
    );
  });
  const payFetch = fn as unknown as PayFetch;
  payFetch.enforcesSpend = true;
  if (defer) payFetch.deferStreamingHeaders = true;
  return { payFetch, fn };
}

type Timeline = {
  acceptedAtMs?: number;
  acceptedStatus?: number;
  receipt?: string;
  activityMs: number[];
  progressMs: number[];
  text: string;
  terminal?: string;
  error?: string;
  totalMs: number;
};

async function runOpenClaw(baseUrl: string): Promise<Timeline> {
  const registry = ai.createApiRegistry();
  ai.registerBuiltInApiProviders(registry);
  const runtime = ai.createNodeLlmRuntime(registry);
  const controller = new AbortController();
  const t0 = Date.now();
  const tl: Timeline = { activityMs: [], progressMs: [], text: "", totalMs: 0 };
  let watchdog: ReturnType<typeof setTimeout>;
  const armWatchdog = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(
      () => controller.abort(new Error("120s OpenClaw activity budget exceeded")),
      120_000,
    );
  };
  armWatchdog();
  const off = ai.onLlmRequestActivity(controller.signal, (progress) => {
    armWatchdog();
    const elapsed = Date.now() - t0;
    tl.activityMs.push(elapsed);
    if (progress) tl.progressMs.push(elapsed);
  });
  const model = {
    id: "blockrun/auto",
    name: "auto",
    api: "openai-completions",
    provider: "clawrouter-loopback",
    baseUrl: `${baseUrl}/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16,
  } as const;
  const stream = runtime.stream(
    model as never,
    {
      messages: [{ role: "user", content: `openclaw ${Date.now()}`, timestamp: Date.now() }],
    } as never,
    {
      apiKey: "unused-loopback",
      signal: controller.signal,
      onResponse: (response: { status: number; headers: Record<string, string> }) => {
        armWatchdog();
        tl.acceptedAtMs ??= Date.now() - t0;
        tl.acceptedStatus = response.status;
        tl.receipt = response.headers["payment-receipt"];
      },
    } as never,
  );
  try {
    for await (const ev of stream as AsyncIterable<{
      type: string;
      delta?: string;
      error?: unknown;
    }>) {
      if (ev.type === "text_delta" && ev.delta) tl.text += ev.delta;
      if (ev.type === "done" || ev.type === "error") {
        tl.terminal = ev.type;
        if (ev.type === "error") tl.error = JSON.stringify(ev.error ?? ev).slice(0, 400);
      }
    }
  } catch (err) {
    tl.error = String(err);
  } finally {
    clearTimeout(watchdog!);
    off();
  }
  tl.totalMs = Date.now() - t0;
  return tl;
}

async function start(payFetch: PayFetch) {
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

async function requestNativeStream(baseUrl: string) {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "blockrun/auto",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    }),
  });
}

function nativeStreamingRail(delayMs: number) {
  const requestBodies: Record<string, unknown>[] = [];
  const fn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBodies.push(
      JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) as Record<string, unknown>,
    );
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (value: unknown) =>
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
        const base = {
          id: "chatcmpl-native-stream",
          object: "chat.completion.chunk",
          created: 1,
          model: "test-model",
        };
        send({
          ...base,
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        });
        send({
          ...base,
          choices: [{ index: 0, delta: { content: "A".repeat(40) }, finish_reason: null }],
        });
        timer = setTimeout(() => {
          send({
            ...base,
            choices: [{ index: 0, delta: { content: "B".repeat(40) }, finish_reason: null }],
          });
          timer = setTimeout(() => {
            send({
              ...base,
              choices: [{ index: 0, delta: { content: "C".repeat(40) }, finish_reason: null }],
            });
            send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
            send({
              ...base,
              choices: [],
              usage: { prompt_tokens: 3, completion_tokens: 120, total_tokens: 123 },
            });
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          }, delayMs);
        }, delayMs);
      },
      cancel() {
        if (timer) clearTimeout(timer);
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream", "Payment-Receipt": FAKE_RECEIPT },
    });
  });
  const payFetch = fn as unknown as PayFetch;
  payFetch.enforcesSpend = true;
  payFetch.deferStreamingHeaders = true;
  payFetch.supportsNativeStreaming = true;
  return { payFetch, fn, requestBodies };
}

describe("OpenClaw transport against deferred streaming headers", () => {
  beforeAll(async () => {
    ai = await loadOpenClawAi();
  });
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("deferred: completes, sees the receipt, one paid call; 102s are not acceptance or activity", async () => {
    const { payFetch, fn } = rail(true);
    const proxy = await start(payFetch);
    close = () => proxy.close();
    const tl = await runOpenClaw(proxy.baseUrl);
    console.log(
      `[openclaw-102] @openclaw/ai ${aiVersion} deferred`,
      JSON.stringify({ ...tl, receipt: !!tl.receipt }),
    );

    expect(tl.error).toBeUndefined();
    expect(tl.terminal).toBe("done");
    expect(tl.text).toBe("openclaw ok");
    expect(tl.acceptedStatus).toBe(200);
    expect(tl.receipt).toBe(FAKE_RECEIPT);
    expect(fn).toHaveBeenCalledTimes(1); // no retry
    // OpenClaw's watchdog saw nothing while the 102s went out: acceptance and first activity both wait
    // for the paid call. Its first-event deadline therefore spans the whole payment + completion.
    expect(tl.acceptedAtMs!).toBeGreaterThanOrEqual(PAY_DELAY_MS - 200);
    expect(tl.activityMs.every((t) => t >= PAY_DELAY_MS - 200)).toBe(true);
  }, 30_000);

  it("legacy: early 200 is accepted at once, but its heartbeats are not watchdog activity", async () => {
    const { payFetch, fn } = rail(false);
    const proxy = await start(payFetch);
    close = () => proxy.close();
    const tl = await runOpenClaw(proxy.baseUrl);
    console.log(
      `[openclaw-102] @openclaw/ai ${aiVersion} legacy`,
      JSON.stringify({ ...tl, receipt: !!tl.receipt }),
    );

    expect(tl.terminal).toBe("done");
    expect(tl.text).toBe("openclaw ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(tl.receipt).toBeUndefined(); // the bug deferred mode fixes
    expect(tl.acceptedAtMs!).toBeLessThan(1_000);
    // The `: heartbeat` comments sent while paying never reach the watchdog on this path, so the legacy
    // early 200 buys OpenClaw no extra time over deferred mode: both wait on the paid call's first data.
    expect(tl.activityMs.filter((t) => t < PAY_DELAY_MS - 200)).toEqual([]);
  }, 30_000);

  it("native upstream chunks keep OpenClaw alive and deliver the receipt past 120 seconds", async () => {
    const { payFetch, fn, requestBodies } = nativeStreamingRail(65_000);
    const proxy = await start(payFetch);
    close = () => proxy.close();
    const tl = await runOpenClaw(proxy.baseUrl);

    expect(tl.error).toBeUndefined();
    expect(tl.terminal).toBe("done");
    expect(tl.text).toBe(`${"A".repeat(40)}${"B".repeat(40)}${"C".repeat(40)}`);
    expect(tl.acceptedAtMs).toBeLessThan(3_000);
    expect(tl.acceptedStatus).toBe(200);
    expect(tl.receipt).toBe(FAKE_RECEIPT);
    expect(tl.totalMs).toBeGreaterThanOrEqual(125_000);
    expect(tl.progressMs.some((time) => time >= 120_000)).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(requestBodies).toHaveLength(1);
    expect(requestBodies[0]).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
  }, 180_000);

  it("paid stream body failure is terminal, reports the original Response, and never retries", async () => {
    const encoder = new TextEncoder();
    const original = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "partial" } }] })}\n\n`,
            ),
          );
          controller.error(new Error("fixture stream broke"));
        },
      }),
      { headers: { "content-type": "text/event-stream", "Payment-Receipt": FAKE_RECEIPT } },
    );
    const payFetch = vi.fn(async () => original) as unknown as PayFetch;
    payFetch.enforcesSpend = true;
    payFetch.deferStreamingHeaders = true;
    payFetch.supportsNativeStreaming = true;
    payFetch.onNoCompletion = vi.fn((response, reason) => {
      expect(response).toBe(original);
      expect(reason).toContain("fixture stream broke");
      throw Object.assign(new Error("paid stream produced no completion"), {
        name: PAYMENT_SETTLED_NO_COMPLETION,
      });
    });
    const proxy = await start(payFetch);
    close = () => proxy.close();

    const response = await requestNativeStream(proxy.baseUrl);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("payment-receipt")).toBe(FAKE_RECEIPT);
    expect(body).toContain("payment_settled_no_completion");
    expect(body).toContain("[DONE]");
    expect(payFetch).toHaveBeenCalledTimes(1);
    expect(payFetch.onNoCompletion).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("paid stream EOF without finish and [DONE] records a terminal failure", async () => {
    const encoder = new TextEncoder();
    const original = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "unfinished answer" } }] })}\n\n`,
            ),
          );
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream", "Payment-Receipt": FAKE_RECEIPT } },
    );
    const payFetch = vi.fn(async () => original) as unknown as PayFetch;
    payFetch.enforcesSpend = true;
    payFetch.deferStreamingHeaders = true;
    payFetch.supportsNativeStreaming = true;
    payFetch.onNoCompletion = vi.fn((response, reason) => {
      expect(response).toBe(original);
      expect(reason).toContain("without the [DONE] marker");
      throw Object.assign(new Error("paid stream ended early"), {
        name: PAYMENT_SETTLED_NO_COMPLETION,
      });
    });
    const proxy = await start(payFetch);
    close = () => proxy.close();

    const response = await requestNativeStream(proxy.baseUrl);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("payment_settled_no_completion");
    expect(payFetch).toHaveBeenCalledTimes(1);
    expect(payFetch.onNoCompletion).toHaveBeenCalledTimes(1);
  }, 20_000);
});
