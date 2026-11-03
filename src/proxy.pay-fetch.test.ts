import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
