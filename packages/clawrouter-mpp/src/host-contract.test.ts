import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import {
  InMemorySpendControlStorage,
  SpendControl,
  startProxy,
  type PayFetch,
} from "@blockrun/clawrouter";
import { MppPaidNoCompletionError } from "./index.js";

// The package and the host only share a name and a flag (see PayFetch). This proves they line up.
describe("host proxy + this package's rails", () => {
  const sc = new SpendControl({ storage: new InMemorySpendControlStorage() });
  const payFetch = vi.fn(async () => {
    throw new MppPaidNoCompletionError("signed and sent, no completion (HTTP 500)", "mpp-abc", 500);
  }) as unknown as PayFetch;
  payFetch.enforcesSpend = true;
  let proxy: Awaited<ReturnType<typeof startProxy>>;

  beforeAll(async () => {
    proxy = await startProxy({
      spendControl: sc,
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

  it("the package's error makes the proxy answer 502 payment_settled_no_completion, paying once", async () => {
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
    expect(text).toContain("mpp-abc");
    expect(payFetch).toHaveBeenCalledTimes(1);
  });
});
