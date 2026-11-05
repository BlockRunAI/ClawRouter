import { describe, expect, it, vi } from "vitest";
import { InMemorySpendControlStorage, SpendControl, SpendPolicyError } from "@twzrd1111/clawrouter";
import { MppPaidNoCompletionError } from "./mpp-paid-failure.js";
import {
  createStripePayFetch,
  STRIPE_ALREADY_PAID_HEADER,
  type StripeQuote,
} from "./stripe-rail.js";

const quote: StripeQuote = { amount: "750", currency: "usd", payee: "acct_merchant" };
const url = "http://127.0.0.1:1/stripe";

function control(configure: (c: SpendControl) => void) {
  const c = new SpendControl({ storage: new InMemorySpendControlStorage() });
  configure(c);
  return c;
}

describe("createStripePayFetch", () => {
  it("is a PayFetch and marks enforcesSpend only when a spend control is supplied", () => {
    const plain = createStripePayFetch({ quote, http: vi.fn() as unknown as typeof fetch });
    const guarded = createStripePayFetch({
      quote,
      spend: new SpendControl({ storage: new InMemorySpendControlStorage() }),
      http: vi.fn() as unknown as typeof fetch,
    });
    expect(typeof plain).toBe("function");
    expect(plain.enforcesSpend).toBe(false);
    expect(guarded.enforcesSpend).toBe(true);
  });

  it("returns the stub's 2xx body and calls it once", async () => {
    const http = vi.fn(async () => new Response("paid", { status: 200 }));
    const spend = control((c) => c.setLimit("daily", 1));
    const res = await createStripePayFetch({ quote, spend, http })(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("paid");
    expect(http).toHaveBeenCalledTimes(1);
    expect(spend.getStatus().spending.daily).toBeCloseTo(0.00075, 8);
  });

  it("marks successful charges and treats a paid response without completion as terminal", async () => {
    const http = vi.fn(async () => new Response("paid", { status: 200 }));
    const spend = control((c) => c.setLimit("daily", 1));
    const pay = createStripePayFetch({ quote, spend, http });
    const response = await pay(url);

    expect(pay.isPaidResponse?.(response)).toBe(true);
    expect(() => pay.onNoCompletion?.(response, "degenerate completion")).toThrow(
      MppPaidNoCompletionError,
    );
    await expect(pay(url)).rejects.toBeInstanceOf(MppPaidNoCompletionError);
    expect(http).toHaveBeenCalledTimes(1);
    expect(spend.getHistory()[0]?.note).toContain("degenerate completion");
  });

  it("refuses an over-limit amount before the stub", async () => {
    const http = vi.fn(async () => new Response("nope", { status: 200 }));
    const spend = control((c) => c.setLimit("perRequest", 0.0005));
    await expect(createStripePayFetch({ quote, spend, http })(url)).rejects.toBeInstanceOf(
      SpendPolicyError,
    );
    expect(http).not.toHaveBeenCalled();
    expect(spend.getStatus().spending.daily).toBe(0);
  });

  it("refuses a blocked payee, a non-usd currency under amount limits, and a bad amount", async () => {
    const http = vi.fn(async () => new Response("nope", { status: 200 }));
    const blocked = control((c) => c.setPolicy("blockedPayees", [quote.payee]));
    await expect(createStripePayFetch({ quote, spend: blocked, http })(url)).rejects.toBeInstanceOf(
      SpendPolicyError,
    );
    const foreign = control((c) => c.setLimit("perRequest", 1));
    await expect(
      createStripePayFetch({
        quote: { ...quote, currency: "eur" },
        spend: foreign,
        http,
      })(url),
    ).rejects.toThrow(/cannot be priced/);
    await expect(
      createStripePayFetch({
        quote: { ...quote, amount: "0x2ee" },
        spend: control((c) => c.setLimit("perRequest", 1)),
        http,
      })(url),
    ).rejects.toBeInstanceOf(SpendPolicyError);
    await expect(
      createStripePayFetch({ quote: { ...quote, payee: "  " }, http })(url),
    ).rejects.toBeInstanceOf(SpendPolicyError);
    expect(http).not.toHaveBeenCalled();
  });

  it("a non-2xx after the check is paid-no-completion and the stub is not called again", async () => {
    const http = vi.fn(async () => new Response("model crashed", { status: 500 }));
    const spend = control((c) => c.setLimit("daily", 1));
    const pay = createStripePayFetch({ quote, spend, http });
    const err = await pay(url).catch((e) => e);
    expect(err).toBeInstanceOf(MppPaidNoCompletionError);
    expect(err.name).toBe("PaymentSettledNoCompletionError");
    expect(err.status).toBe(500);
    expect(err.reference).toMatch(/^mpp-[0-9a-f]{16}$/);
    expect(err.message).toContain("model crashed");
    expect(spend.getHistory()[0]?.note).toContain("signed, no completion (HTTP 500)");
    const again = await pay(url).catch((e) => e);
    expect(again).toBeInstanceOf(MppPaidNoCompletionError);
    expect(http).toHaveBeenCalledTimes(1);
    expect(spend.getStatus().spending.daily).toBeCloseTo(0.00075, 8);
  });

  it("a caller signal that payment already happened does not call the stub", async () => {
    const http = vi.fn(async () => new Response("paid", { status: 200 }));
    const pay = createStripePayFetch({ quote, http });
    const err = await pay(url, {
      headers: { [STRIPE_ALREADY_PAID_HEADER]: "stripe-ref-1" },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MppPaidNoCompletionError);
    expect(err.reference).toBe("stripe-ref-1");
    expect(err.message).toContain("already happened");
    expect(http).not.toHaveBeenCalled();
  });

  it("the default stub throws and does not replace global fetch", async () => {
    const before = globalThis.fetch;
    const pay = createStripePayFetch({ quote });
    await expect(pay(url)).rejects.toThrow(/no HTTP stub/);
    expect(globalThis.fetch).toBe(before);
  });

  it("releases the reservation when the stub throws, so the charge was not sent", async () => {
    const http = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const spend = control((c) => c.setLimit("daily", 1));
    const pay = createStripePayFetch({ quote, spend, http });
    await expect(pay(url)).rejects.toThrow(/socket hang up/);
    expect(spend.getStatus().spending.daily).toBe(0);
    const res = await pay(url);
    expect(res.status).toBe(200);
    expect(http).toHaveBeenCalledTimes(2);
    expect(spend.getStatus().spending.daily).toBeCloseTo(0.00075, 8);
  });
});
