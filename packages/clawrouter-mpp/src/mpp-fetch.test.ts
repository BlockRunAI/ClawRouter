import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
import { InMemorySpendControlStorage, SpendControl, SpendPolicyError } from "@twzrd1111/clawrouter";
import { MppPaidNoCompletionError, readCredits } from "./mpp-paid-failure.js";
import {
  createTempoFixtureFetch,
  guardMethod,
  parseTempoChargeHeader,
  quoteFromChallenge,
} from "./mpp-fetch.js";

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

const OPENROUTER_FIXTURE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../test/fixtures/openrouter-tempo-402.json", import.meta.url)),
    "utf8",
  ),
) as {
  request: { url: string; body: unknown };
  response: { headers: Record<string, string>; body: unknown };
  decoded: { request: Record<string, unknown>; realm?: string };
};

const FIXTURE_PAYEE = "0xca4e835F803cB0b7C428222B3A3B98518d4779Fe";
const FIXTURE_RECEIPT = "tempo-receipt-fixture";
const COMPLETION_BODY = { id: "chatcmpl-fixture", choices: [{ message: { content: "hi" } }] };

function openRouterControl() {
  const control = new SpendControl({ storage: new InMemorySpendControlStorage() });
  control.setLimit("perRequest", 0.001);
  control.setLimit("daily", 1);
  control.setPolicy("allowedPayees", [FIXTURE_PAYEE]);
  control.setPolicy("allowedNetworks", ["eip155:4217"]);
  return control;
}

/** Stub the seller. No socket: 402 from the fixture, then the scripted paid response. */
function stubOpenRouter(paid: Response) {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const base = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization");
    calls.push({ url: String(input), authorization });
    if (!authorization) {
      return new Response(JSON.stringify(OPENROUTER_FIXTURE.response.body), {
        status: 402,
        headers: OPENROUTER_FIXTURE.response.headers,
      });
    }
    return paid.clone();
  }) as unknown as typeof fetch;
  return { base, calls };
}

describe("OpenRouter Tempo fixture, no network", () => {
  const header = OPENROUTER_FIXTURE.response.headers["www-authenticate"];
  const parsed = parseTempoChargeHeader(header);
  const url = OPENROUTER_FIXTURE.request.url;
  const body = JSON.stringify(OPENROUTER_FIXTURE.request.body);

  it("parses the recorded charge: 750 units, chain 4217, fixture payee", () => {
    expect(parsed.request).toEqual(OPENROUTER_FIXTURE.decoded.request);
    expect(parsed.realm).toBe("openrouter.mpp.tempo.xyz");
    expect(quoteFromChallenge(parsed)).toMatchObject({
      payTo: FIXTURE_PAYEE,
      network: "eip155:4217",
      amount: "750",
      priceable: true,
    });
  });

  it("reserves, signs once, attaches the credential, and returns the completion plus receipt", async () => {
    const control = openRouterControl();
    const signed: string[] = [];
    const { base, calls } = stubOpenRouter(
      new Response(JSON.stringify(COMPLETION_BODY), {
        status: 200,
        headers: { "content-type": "application/json", "Payment-Receipt": FIXTURE_RECEIPT },
      }),
    );
    const payFetch = createTempoFixtureFetch({
      payer: account.address,
      spend: control,
      sign: async (challenge) => {
        expect(control.getStatus().spending.daily).toBeCloseTo(0.00075, 8);
        expect(signed).toEqual([]);
        signed.push(challenge.id);
        return challenge.id;
      },
      fetch: base,
    });
    const once = () =>
      payFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });

    const res = await once();
    expect(res.status).toBe(200);
    expect(payFetch.isPaidResponse?.(res)).toBe(true);
    expect(await res.json()).toEqual(COMPLETION_BODY);
    expect(res.headers.get("payment-receipt")).toBe(FIXTURE_RECEIPT);
    expect(signed).toEqual(["fixture-challenge-id"]);
    expect(calls[0].authorization).toBeNull();
    expect(calls[1].authorization).toBe("Payment fixture-challenge-id");
    expect(
      calls.every((c) => c.url === "https://openrouter.mpp.tempo.xyz/v1/chat/completions"),
    ).toBe(true);
    expect(control.getStatus().spending.daily).toBeCloseTo(0.00075, 8);

    const again = await once();
    expect(again.status).toBe(200);
    expect(again.headers.get("payment-receipt")).toBe(FIXTURE_RECEIPT);
    expect(signed).toEqual(["fixture-challenge-id"]);
    expect(calls).toHaveLength(4);
    expect(calls[3].authorization).toBe("Payment fixture-challenge-id");
    expect(control.getStatus().spending.daily).toBeCloseTo(0.00075, 8);
  });

  it("a signed call with no completion yields exactly one credit and is idempotent across retries", async () => {
    const control = openRouterControl();
    const signed: string[] = [];
    const { base, calls } = stubOpenRouter(new Response("no completion", { status: 502 }));
    const payFetch = createTempoFixtureFetch({
      payer: account.address,
      spend: control,
      sign: async (challenge) => {
        signed.push(challenge.id);
        return challenge.id;
      },
      fetch: base,
    });
    const before = readCredits().length;
    const err = await payFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }).catch((e: unknown) => e);
    await payFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }).catch(() => {});
    expect(err).toBeInstanceOf(MppPaidNoCompletionError);
    expect((err as Error).message).toContain("Not retrying");
    expect((err as MppPaidNoCompletionError).status).toBe(502);
    expect(readCredits().slice(before)).toEqual([
      {
        payer: account.address,
        amount: "750",
        challengeId: "fixture-challenge-id",
        reason: "HTTP 502",
      },
    ]);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(signed).toEqual(["fixture-challenge-id"]);
  });
});
