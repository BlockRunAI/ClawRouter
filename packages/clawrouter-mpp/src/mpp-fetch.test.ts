import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createMppFetch } from "./mpp-fetch.js";

const account = privateKeyToAccount(generatePrivateKey());

describe("createMppFetch", () => {
  it("passes a non-402 response through untouched", async () => {
    const base = vi.fn(async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const res = await createMppFetch(account, base)("http://127.0.0.1:1/x");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("does not pay a 402 that carries no payment challenge", async () => {
    const base = vi.fn(
      async () => new Response("nope", { status: 402 }),
    ) as unknown as typeof fetch;
    const res = await createMppFetch(account, base)("http://127.0.0.1:1/x");
    expect(res.status).toBe(402);
    expect(await res.text()).toBe("nope");
    expect(base).toHaveBeenCalledTimes(1); // no retry: nothing was signed
  });

  it("concurrent calls each get their own unpayable 402 back", async () => {
    // An MPP challenge for a method this client cannot pay: mppx throws, and the caller must receive
    // THIS call's 402, not whichever 402 another in-flight call stored last.
    const challenge = (m: string) =>
      `Payment id="${m}", realm="t", method="${m}", intent="charge", request="e30"`;
    // Both responses resolve in the same tick, so each call's 402 is stored before either call reads it.
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const base = vi.fn(async (input: RequestInfo | URL) => {
      const tag = String(input).endsWith("/slow") ? "slow" : "fast";
      if (++started === 2) release();
      await gate;
      return new Response(`body-${tag}`, {
        status: 402,
        headers: { "www-authenticate": challenge(`nope-${tag}`) },
      });
    }) as unknown as typeof fetch;
    const payFetch = createMppFetch(account, base);
    const [slow, fast] = await Promise.all([
      payFetch("http://127.0.0.1:1/slow"),
      payFetch("http://127.0.0.1:1/fast"),
    ]);
    expect(await slow.text()).toBe("body-slow");
    expect(await fast.text()).toBe("body-fast");
  });

  it("does not touch globalThis.fetch", () => {
    const before = globalThis.fetch;
    createMppFetch(account, vi.fn() as unknown as typeof fetch);
    expect(globalThis.fetch).toBe(before);
  });
});

import { Mppx as ServerMppx, tempo as serverTempo } from "mppx/server";
import { InMemorySpendControlStorage, SpendControl, SpendPolicyError } from "@blockrun/clawrouter";
import { guardMethod, quoteFromChallenge } from "./mpp-fetch.js";

const PATHUSD = "0x20c0000000000000000000000000000000000000";
const RECIPIENT = "0x000000000000000000000000000000000000dEaD";

const challenge = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  request: {
    amount: "750",
    currency: PATHUSD,
    recipient: RECIPIENT,
    methodDetails: { chainId: 42431 },
    ...over,
  },
});

/** A fake mppx method: records whether anything was signed. */
function fakeMethod(fail = false) {
  const signed: string[] = [];
  return {
    signed,
    method: {
      name: "tempo",
      intent: "charge",
      createCredential: async ({ challenge: c }: { challenge: { id: string } }) => {
        if (fail) throw new Error("signer exploded");
        signed.push(c.id);
        return `Payment ${c.id}`;
      },
    },
  };
}

function guarded(configure: (c: SpendControl) => void, fail = false) {
  const control = new SpendControl({ storage: new InMemorySpendControlStorage() });
  configure(control);
  const f = fakeMethod(fail);
  return { control, signed: f.signed, method: guardMethod(f.method, control) };
}

describe("MPP spend controls (guardMethod)", () => {
  it("prices the quote for a known 6-decimal asset and requires an amount", () => {
    expect(quoteFromChallenge(challenge("a"))).toMatchObject({
      payTo: RECIPIENT,
      network: "eip155:42431",
      asset: PATHUSD,
      amount: "750",
      priceable: true,
    });
    expect(quoteFromChallenge(challenge("a", { amount: undefined })).priceable).toBe(false);
  });

  it("refuses over the per-request limit and signs nothing", async () => {
    const g = guarded((c) => c.setLimit("perRequest", 0.0005));
    await expect(g.method.createCredential({ challenge: challenge("a") })).rejects.toBeInstanceOf(
      SpendPolicyError,
    );
    expect(g.signed).toEqual([]);
  });

  it("signs under the limit and records the spend", async () => {
    const g = guarded((c) => c.setLimit("daily", 0.001));
    await expect(g.method.createCredential({ challenge: challenge("a") })).resolves.toBe(
      "Payment a",
    );
    expect(g.control.getStatus().spending.daily).toBeCloseTo(0.00075, 8);
  });

  it("a signed credential counts as spend: the next one is refused once the daily window is used", async () => {
    const g = guarded((c) => c.setLimit("daily", 0.001));
    await g.method.createCredential({ challenge: challenge("a") });
    await expect(g.method.createCredential({ challenge: challenge("b") })).rejects.toBeInstanceOf(
      SpendPolicyError,
    );
    expect(g.signed).toEqual(["a"]);
  });

  it("releases the reservation when signing itself fails", async () => {
    const g = guarded((c) => c.setLimit("daily", 0.001), true);
    await expect(g.method.createCredential({ challenge: challenge("a") })).rejects.toThrow(
      "signer exploded",
    );
    expect(g.control.getStatus().spending.daily).toBe(0);
    // the failed attempt must not have eaten the budget
    const ok = guardMethod(fakeMethod().method, g.control);
    await expect(ok.createCredential({ challenge: challenge("b") })).resolves.toBe("Payment b");
  });

  it("fails closed on an asset it cannot price while amount limits are set", async () => {
    const g = guarded((c) => c.setLimit("perRequest", 1));
    await expect(
      g.method.createCredential({
        challenge: challenge("a", { currency: "0x1111111111111111111111111111111111111111" }),
      }),
    ).rejects.toThrow(/cannot price/);
    expect(g.signed).toEqual([]);
  });

  it("fails closed on a non-canonical (hex) amount rather than reading it as zero", async () => {
    const g = guarded((c) => c.setLimit("perRequest", 0.0005));
    await expect(
      g.method.createCredential({ challenge: challenge("a", { amount: "0x2ee" }) }),
    ).rejects.toBeInstanceOf(SpendPolicyError);
    expect(g.signed).toEqual([]);
  });

  it("applies the counterparty lists: blocked payee and disallowed network", async () => {
    const blocked = guarded((c) => c.setPolicy("blockedPayees", [RECIPIENT]));
    await expect(
      blocked.method.createCredential({ challenge: challenge("a") }),
    ).rejects.toBeInstanceOf(SpendPolicyError);
    const net = guarded((c) => c.setPolicy("allowedNetworks", ["eip155:8453"]));
    await expect(net.method.createCredential({ challenge: challenge("a") })).rejects.toBeInstanceOf(
      SpendPolicyError,
    );
  });

  it("does nothing when no limits are configured", async () => {
    const g = guarded(() => {});
    await expect(
      g.method.createCredential({
        challenge: challenge("a", { currency: "0x1111111111111111111111111111111111111111" }),
      }),
    ).resolves.toBe("Payment a");
  });

  it("marks the fetch as enforcing only when a spend control is supplied", () => {
    const plain = createMppFetch(account, vi.fn() as unknown as typeof fetch);
    const withSpend = createMppFetch(account, vi.fn() as unknown as typeof fetch, {
      spend: new SpendControl({ storage: new InMemorySpendControlStorage() }),
    });
    expect(plain.enforcesSpend).toBe(false);
    expect(withSpend.enforcesSpend).toBe(true);
  });

  // The regression that matters: mppx swallows errors thrown from its event handlers, so a veto has to
  // hold through the real client. A real server-built 402 goes through a real Mppx client; the account is
  // a random unfunded key, so if the guard ever stops vetoing, the failure is a signer/chain error
  // instead of SpendPolicyError (and nothing is spent either way).
  it("vetoes through the real mppx client: an over-limit 402 is never signed", async () => {
    const server = ServerMppx.create({
      methods: [serverTempo.charge({ recipient: RECIPIENT, currency: PATHUSD, testnet: true })],
      realm: "test.local",
      secretKey: "test-secret-key-test-secret-key-12345",
    });
    const seller: typeof fetch = async (input, init) => {
      const r = await server.charge({ amount: "0.00075" })(new Request(input as string, init));
      return r.status === 402 ? r.challenge : new Response("paid", { status: 200 });
    };
    const control = new SpendControl({ storage: new InMemorySpendControlStorage() });
    control.setLimit("perRequest", 0.0005);
    const pay = createMppFetch(account, seller, { spend: control });
    await expect(
      pay("https://test.local/x", { method: "POST", body: "{}" }),
    ).rejects.toBeInstanceOf(SpendPolicyError);
    expect(control.getStatus().spending.daily).toBe(0);
  });
});
