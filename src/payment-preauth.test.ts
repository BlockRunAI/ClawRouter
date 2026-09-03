/**
 * Pre-auth cache correctness under per-request (token-based) pricing.
 *
 * BlockRun prices each call on input + max_tokens, so the same model can cost
 * different amounts. These tests pin the guarantees that keep that from
 * underpaying via a stale cached authorization:
 *  - pre-auth is reused only when an up-front estimate proves it still covers
 *    the request (fires on a same/cheaper repeat, skipped when the request grows),
 *  - a rejected pre-auth is discarded and the request re-fetched cleanly — the
 *    rejection is never treated as a fresh challenge (no "Failed to parse…"),
 *  - with no estimator, pre-auth is disabled rather than risking an underpay.
 */
import { describe, it, expect, vi } from "vitest";
import { x402Client } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { deriveAllKeys } from "./wallet.js";
import { createPayFetchWithPreAuth } from "./payment-preauth.js";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

function testClient(): x402Client {
  const keys = deriveAllKeys(MNEMONIC);
  const account = privateKeyToAccount(keys.evmPrivateKey);
  const pc = createPublicClient({ chain: base, transport: http() });
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: toClientEvmSigner(account, pc) });
  return client;
}

const CHALLENGE = {
  x402Version: 2,
  accepts: [
    {
      scheme: "exact",
      network: "eip155:8453",
      amount: "1000",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: "0xe9030014F5DAe217d0A152f02A043567b16c1aBf",
      maxTimeoutSeconds: 300,
      extra: { name: "USD Coin", version: "2" },
    },
  ],
  resource: { url: "https://gw/api", description: "t", mimeType: "application/json" },
};

function challenge402(): Response {
  const b64 = Buffer.from(JSON.stringify(CHALLENGE)).toString("base64");
  return new Response(JSON.stringify({ error: "Payment Required" }), {
    status: 402,
    headers: {
      "payment-required": b64,
      "www-authenticate": `X402 requirements="${b64}"`,
      "content-type": "application/json",
    },
  });
}

/** A fake gateway: 200 when a payment is attached, a fresh 402 challenge when
 *  not. `rejectNextPaid` makes the next paid request 402 (an underpayment), to
 *  exercise the safety-net path. Records whether each call carried payment. */
function fakeGateway() {
  const calls: Array<{ paid: boolean }> = [];
  // `rejectNextPaid` returns a 402 (an underpayment the gateway declined).
  // `throwNextPaidSend` instead makes the SEND ITSELF reject, after the request
  // carrying the signed payment has already reached the gateway — a reset or a
  // socket hang-up on a call the gateway may well have settled.
  const ctl = { rejectNextPaid: false, throwNextPaidSend: false };
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const paid = req.headers.has("payment-signature");
    calls.push({ paid });
    if (paid) {
      if (ctl.throwNextPaidSend) {
        ctl.throwNextPaidSend = false;
        // The gateway HAS the payment; only the response is lost.
        throw new TypeError("fetch failed: socket hang up");
      }
      if (ctl.rejectNextPaid) {
        ctl.rejectNextPaid = false;
        return challenge402(); // underpayment rejected
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return challenge402();
  });
  return { fn: fn as unknown as typeof fetch, calls, ctl };
}

const URL = "https://gw/api/v1/chat/completions";
function body(maxTokens = 10) {
  return JSON.stringify({ model: "test/model", max_tokens: maxTokens, messages: [] });
}

describe("payment pre-auth — per-request pricing safety", () => {
  it("reuses pre-auth when the estimate proves the cache still covers it (no extra 402)", async () => {
    const est = vi.fn(() => "1000"); // every request estimated equal
    const gw = fakeGateway();
    const pay = createPayFetchWithPreAuth(gw.fn, testClient(), undefined, { estimateAmount: est });

    await pay(URL, { method: "POST", body: body() }); // seed: [unpaid→402, paid→200]
    const seeded = gw.calls.length;
    expect(gw.calls.map((c) => c.paid)).toEqual([false, true]);

    const res = await pay(URL, { method: "POST", body: body() }); // identical → pre-auth
    expect(res.status).toBe(200);
    expect(gw.calls.length - seeded).toBe(1); // one round-trip, no 402
    expect(gw.calls[seeded].paid).toBe(true); // it pre-paid
  });

  it("skips pre-auth (clean fresh 402) when the request grows beyond the cached amount", async () => {
    let big = false;
    const est = vi.fn(() => (big ? "5000" : "1000"));
    const gw = fakeGateway();
    const pay = createPayFetchWithPreAuth(gw.fn, testClient(), undefined, { estimateAmount: est });

    await pay(URL, { method: "POST", body: body(10) }); // seed cover=1000
    const seeded = gw.calls.length;

    big = true;
    const res = await pay(URL, { method: "POST", body: body(9000) }); // needs 5000 > 1000
    expect(res.status).toBe(200); // NOT a 500 "Failed to parse payment requirements"
    // Skipped pre-auth → clean unpaid request first, then the paid retry.
    expect(gw.calls.slice(seeded).map((c) => c.paid)).toEqual([false, true]);
  });

  it("discards a rejected pre-auth and re-fetches cleanly (no parse error)", async () => {
    const est = vi.fn(() => "1000");
    const gw = fakeGateway();
    const pay = createPayFetchWithPreAuth(gw.fn, testClient(), undefined, { estimateAmount: est });

    await pay(URL, { method: "POST", body: body() }); // seed (cache warm, cover=1000)
    gw.calls.length = 0;
    // Now make the next PAID request (the pre-auth) get rejected by the gateway.
    gw.ctl.rejectNextPaid = true;
    // pre-auth fires (covered) → rejected 402 → clean refetch → paid retry → 200
    const res = await pay(URL, { method: "POST", body: body() });
    expect(res.status).toBe(200);
    const seq = gw.calls.map((c) => c.paid);
    expect(seq[0]).toBe(true); // pre-auth attempt (got rejected)
    expect(seq).toContain(false); // a CLEAN refetch followed (rejection not reused)
    expect(seq[seq.length - 1]).toBe(true); // then paid correctly
  });

  it("sizes the request by max_completion_tokens too, so a grown request can't reuse a small pre-auth", async () => {
    // OpenAI deprecated `max_tokens` for `max_completion_tokens`. Reading only
    // the legacy field made a 9000-token request look like a 0-token one, so a
    // pre-auth cached for a tiny request was reused to pay for a large one.
    const est = vi.fn((_m: string, _len: number, maxTokens: number) =>
      String(maxTokens * 10 + 100),
    );
    const gw = fakeGateway();
    const pay = createPayFetchWithPreAuth(gw.fn, testClient(), undefined, { estimateAmount: est });

    await pay(URL, { method: "POST", body: body(10) }); // seed cover = 10*10+100 = 200
    const seeded = gw.calls.length;

    const grown = JSON.stringify({
      model: "test/model",
      max_completion_tokens: 9000, // needs 90100 ≫ the cached 200
      messages: [],
    });
    const res = await pay(URL, { method: "POST", body: grown });

    expect(res.status).toBe(200);
    // The estimator must have SEEN the real budget, not 0.
    expect(est).toHaveBeenCalledWith(expect.anything(), expect.anything(), 9000);
    // Too big for the cached authorization → clean unpaid request, then paid retry.
    expect(gw.calls.slice(seeded).map((c) => c.paid)).toEqual([false, true]);
  });

  it("never signs a second payment when the pre-auth SEND fails (issue #317)", async () => {
    // The pre-auth request carries a signed payment. If the send rejects, the
    // client cannot tell "never arrived" from "arrived, settled, response lost".
    // Falling through to the clean-402 path signs a SECOND, distinct payment
    // with a fresh nonce — every replay and dedup guard correctly passes it,
    // so one user request becomes two USDC charges. Fail closed instead.
    const est = vi.fn(() => "1000");
    const gw = fakeGateway();
    const pay = createPayFetchWithPreAuth(gw.fn, testClient(), undefined, { estimateAmount: est });

    await pay(URL, { method: "POST", body: body() }); // seed the cache
    gw.calls.length = 0;
    gw.ctl.throwNextPaidSend = true;

    await expect(pay(URL, { method: "POST", body: body() })).rejects.toThrow(/socket hang up/);

    // Exactly one payment left this process for this request.
    expect(gw.calls.filter((c) => c.paid).length).toBe(1);
  });

  it("still falls through when pre-auth fails BEFORE anything is sent", async () => {
    // Signing failures are unambiguous — no payment went out, so falling
    // through to the normal 402 flow cannot double-charge. Keep that path.
    const est = vi.fn(() => "1000");
    const gw = fakeGateway();
    const client = testClient();
    const pay = createPayFetchWithPreAuth(gw.fn, client, undefined, { estimateAmount: est });

    await pay(URL, { method: "POST", body: body() }); // seed the cache
    gw.calls.length = 0;

    const spy = vi
      .spyOn(client, "createPaymentPayload")
      .mockRejectedValueOnce(new Error("signing blew up"));

    const res = await pay(URL, { method: "POST", body: body() });
    expect(res.status).toBe(200);
    // Nothing was ever sent with a payment attached before the failure, so the
    // clean unpaid request + paid retry is correct and charges exactly once.
    expect(gw.calls.map((c) => c.paid)).toEqual([false, true]);
    spy.mockRestore();
  });

  it("disables pre-auth entirely when no estimator is provided (never underpays)", async () => {
    const gw = fakeGateway();
    const pay = createPayFetchWithPreAuth(gw.fn, testClient(), undefined, {}); // no estimateAmount

    await pay(URL, { method: "POST", body: body() });
    const seeded = gw.calls.length;
    const res = await pay(URL, { method: "POST", body: body() }); // identical
    expect(res.status).toBe(200);
    // No pre-auth → still a fresh 402 + paid retry, never a pre-signed first call.
    expect(gw.calls.slice(seeded).map((c) => c.paid)).toEqual([false, true]);
  });
});
