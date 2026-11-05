import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// startProxy calls checkForUpdates() unconditionally (proxy.ts), which dials registry.npmjs.org.
// Stub it so these tests never leave loopback.
vi.mock("./updater.js", () => ({ checkForUpdates: async () => {} }));
import { generatePrivateKey } from "viem/accounts";
import { startProxy } from "./proxy.js";
import { PAYMENT_SETTLED_NO_COMPLETION, type PayFetch } from "./pay-fetch.js";
import { InMemorySpendControlStorage, SpendControl } from "./spend-control.js";

const baseOptions = (spendControl: SpendControl, payFetch: PayFetch) => ({
  spendControl,
  wallet: generatePrivateKey(),
  apiBase: "http://127.0.0.1:9",
  payFetch,
  skipBalanceCheck: true,
  port: 0,
  allowExistingProxy: false,
});
const newControl = () => new SpendControl({ storage: new InMemorySpendControlStorage() });

// A rail that signed a payment and then failed must not be paid again by a retry or a fallback model.
describe("proxy: custom payFetch, payment signed then no completion", () => {
  class SettledNoCompletion extends Error {
    constructor(
      message: string,
      readonly reference: string,
    ) {
      super(message);
      this.name = PAYMENT_SETTLED_NO_COMPLETION; // matched by name, so a rail in another package works
    }
  }
  const payFetch = vi.fn(async () => {
    throw new SettledNoCompletion("signed and sent, no completion (HTTP 500)", "ref-0123456789");
  }) as unknown as PayFetch;
  payFetch.enforcesSpend = true;
  let proxy: Awaited<ReturnType<typeof startProxy>>;

  beforeAll(async () => {
    proxy = await startProxy(baseOptions(newControl(), payFetch));
  });
  afterAll(async () => {
    await proxy?.close();
  });

  it("answers 502 payment_settled_no_completion with the reference, and pays once", async () => {
    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "blockrun/auto",
        max_tokens: 8,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const text = await res.text();
    expect(res.status).toBe(502);
    expect(text).toContain("payment_settled_no_completion");
    expect(text).toContain("ref-0123456789");
    expect(payFetch).toHaveBeenCalledTimes(1); // no retry, no fallback model
  });
});

// A rail that cannot honour configured spend limits must not be started, or it signs past them.
describe("proxy: custom payFetch that does not enforce spend limits", () => {
  const unguarded = vi.fn() as unknown as PayFetch; // enforcesSpend left unset

  it("refuses to start when amount limits are configured", async () => {
    const sc = newControl();
    sc.setLimit("perRequest", 0.1);
    await expect(startProxy(baseOptions(sc, unguarded))).rejects.toThrow(
      /does not enforce spend limits/,
    );
  });

  it("starts when no amount limits are configured", async () => {
    const p = await startProxy(baseOptions(newControl(), unguarded));
    await p.close();
  });

  it("starts when the rail declares it enforces them", async () => {
    const guarded = vi.fn() as unknown as PayFetch;
    guarded.enforcesSpend = true;
    const sc = newControl();
    sc.setLimit("perRequest", 0.1);
    const p = await startProxy(baseOptions(sc, guarded));
    await p.close();
  });
});

const chatBody = JSON.stringify({
  model: "blockrun/auto",
  max_tokens: 8,
  stream: false,
  messages: [{ role: "user", content: "hi" }],
});

// A rail that settles and gets a completion: the caller must see the rail's Payment-Receipt.
describe("proxy: custom payFetch, Payment-Receipt on a paid completion", () => {
  const FAKE_RECEIPT = "fake-receipt.test-only.not-a-credential.0001";
  const payFetch = vi.fn(async () => {
    return new Response(
      JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 1,
        model: "test-model",
        choices: [
          { index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json", "Payment-Receipt": FAKE_RECEIPT },
      },
    );
  }) as unknown as PayFetch;
  payFetch.enforcesSpend = true;
  let proxy: Awaited<ReturnType<typeof startProxy>>;

  beforeAll(async () => {
    proxy = await startProxy(baseOptions(newControl(), payFetch));
  });
  afterAll(async () => {
    await proxy?.close();
  });

  it("forwards the Payment-Receipt header to the caller unchanged", async () => {
    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody,
    });
    await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("payment-receipt")).toBe(FAKE_RECEIPT);
    expect(payFetch).toHaveBeenCalledTimes(1);
  });
});

describe("proxy: do not pay a fallback after a degenerate paid completion", () => {
  const paidResponses = new WeakSet<Response>();
  const paidCalls = vi.fn(async () => {
    const response = new Response(
      JSON.stringify({
        id: "chatcmpl-degenerate",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "!".repeat(80) },
            finish_reason: "length",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    paidResponses.add(response);
    return response;
  }) as unknown as PayFetch;
  paidCalls.enforcesSpend = true;
  paidCalls.isPaidResponse = (response) => paidResponses.has(response);
  let proxy: Awaited<ReturnType<typeof startProxy>>;

  beforeAll(async () => {
    proxy = await startProxy(baseOptions(newControl(), paidCalls));
  });
  afterAll(async () => {
    await proxy?.close();
  });

  it("returns the paid result instead of signing against a fallback model", async () => {
    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody,
    });
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).toContain("!".repeat(80));
    expect(paidCalls).toHaveBeenCalledTimes(1);
  });
});

describe("proxy: preserve the global timeout for a connected caller", () => {
  it("returns a timeout error instead of treating the removed in-flight entry as a disconnect", async () => {
    const payFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => {
            controller.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        },
      });
      return new Response(body, { headers: { "content-type": "application/json" } });
    }) as unknown as PayFetch;
    payFetch.enforcesSpend = true;
    const proxy = await startProxy({
      ...baseOptions(newControl(), payFetch),
      requestTimeoutMs: 300,
    });

    try {
      const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: chatBody,
      });
      const text = await res.text();

      expect(res.status).toBe(502);
      expect(text).toContain("Request timed out after 300ms");
      expect(payFetch).toHaveBeenCalledTimes(1);
    } finally {
      await proxy.close();
    }
  });
});

// Paid, no completion: typed 502, no receipt header invented, exactly one paid call.
describe("proxy: custom payFetch, paid-no-completion error shape", () => {
  const payFetch = vi.fn(async () => {
    const err = new Error("signed and sent, no completion (HTTP 503)") as Error & {
      reference?: string;
    };
    err.name = PAYMENT_SETTLED_NO_COMPLETION;
    err.reference = "ref-fake-abcdef";
    throw err;
  }) as unknown as PayFetch;
  payFetch.enforcesSpend = true;
  let proxy: Awaited<ReturnType<typeof startProxy>>;

  beforeAll(async () => {
    proxy = await startProxy(baseOptions(newControl(), payFetch));
  });
  afterAll(async () => {
    await proxy?.close();
  });

  it("answers 502 with type/code payment_settled_no_completion, no Payment-Receipt, one call", async () => {
    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody,
    });
    const text = await res.text();
    expect(res.status).toBe(502);
    const body = JSON.parse(text) as { error: { type: string; code: string } };
    expect(body.error.type).toBe("payment_settled_no_completion");
    expect(body.error.code).toBe("payment_settled_no_completion");
    expect(res.headers.get("payment-receipt")).toBeNull();
    expect(payFetch).toHaveBeenCalledTimes(1); // no retry, no fallback model
  });
});
