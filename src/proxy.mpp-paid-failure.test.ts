import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import { startProxy } from "./proxy.js";
import { MppPaidNoCompletionError } from "./mpp-paid-failure.js";
import { InMemorySpendControlStorage, SpendControl } from "./spend-control.js";
import type { PayFetch } from "./mpp-fetch.js";

// A payment that was signed and then failed must not be paid again by a retry or a fallback model.
describe("proxy: MPP payment signed, then no completion", () => {
  const payFetch = vi.fn(async () => {
    throw new MppPaidNoCompletionError(
      "MPP payment was signed and sent but no completion came back (HTTP 500)",
      "mpp-0123456789abcdef",
      500,
    );
  }) as unknown as PayFetch;
  payFetch.enforcesSpend = true;
  let proxy: Awaited<ReturnType<typeof startProxy>>;

  beforeAll(async () => {
    proxy = await startProxy({
      spendControl: new SpendControl({ storage: new InMemorySpendControlStorage() }),
      wallet: generatePrivateKey(),
      apiBase: "http://127.0.0.1:9",
      payFetch,
      skipBalanceCheck: true,
      port: 0,
      allowExistingProxy: false,
    });
  });
  afterAll(async () => {
    await proxy?.close();
  });

  it("returns 502 payment_settled_no_completion with the reference, and pays once", async () => {
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
    expect(text).toContain("mpp-0123456789abcdef");
    expect(payFetch).toHaveBeenCalledTimes(1); // no retry, no fallback model
  });
});
