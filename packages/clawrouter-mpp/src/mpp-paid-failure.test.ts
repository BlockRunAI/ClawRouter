import { describe, expect, it, vi } from "vitest";
import {
  boundedSnippet,
  creditFromChallenge,
  guardPaid as guardWithPayer,
  markSigned,
  MppPaidNoCompletionError,
  readCredits,
  rejectPaidNoCompletion,
} from "./mpp-paid-failure.js";
import { guardMethod } from "./mpp-fetch.js";
import { InMemorySpendControlStorage, SpendControl, SpendPolicyError } from "@twzrd1111/clawrouter";

const PATHUSD = "0x20c0000000000000000000000000000000000000";
const TEST_PAYER = "0x0000000000000000000000000000000000000001";
const guardPaid = (spend: SpendControl | undefined, run: () => Promise<Response>) =>
  guardWithPayer(spend, run, TEST_PAYER);
const challenge = {
  id: "c1",
  request: {
    amount: "750",
    currency: PATHUSD,
    recipient: "0x000000000000000000000000000000000000dEaD",
    methodDetails: { chainId: 42431 },
  },
};
const fakeMethod = () => ({
  name: "tempo",
  intent: "charge",
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  createCredential: async (_options?: unknown) => "Payment secret-credential-bytes",
});
const control = () => {
  const c = new SpendControl({ storage: new InMemorySpendControlStorage() });
  c.setLimit("daily", 1); // an aggregate window, so the spend is written to the ledger
  return c;
};
const history = (c: SpendControl) =>
  (c as unknown as { history: Array<{ amount: number; note?: string }> }).history;

/** Sign through the real guard, then return what the seller says. */
const paidCall = (
  c: SpendControl,
  respond: () => Response | Promise<Response>,
  id = challenge.id,
) =>
  guardPaid(c, async () => {
    await guardMethod(fakeMethod(), c).createCredential({ challenge: { ...challenge, id } });
    return respond();
  });

describe("failure after an MPP payment was signed", () => {
  it("turns a host-detected HTTP 200 error into a terminal paid failure with one credit", async () => {
    const c = control();
    const response = await paidCall(
      c,
      () =>
        new Response('{"error":"overloaded"}', { headers: { "content-type": "application/json" } }),
      "paid-200-error-unit",
    );
    const reject = () => rejectPaidNoCompletion(response, "provider overloaded");
    expect(reject).toThrow(MppPaidNoCompletionError);
    expect(reject).toThrow(MppPaidNoCompletionError);
    expect(
      readCredits().filter(
        (r) => r.payer === TEST_PAYER && r.challengeId === "paid-200-error-unit",
      ),
    ).toHaveLength(1);
    expect(history(c)).toHaveLength(1);
    expect(history(c)[0].note).toContain("signed, no completion (HTTP 200)");
  });

  it("turns a broken streaming body into one terminal paid failure and credit", async () => {
    const c = control();
    const before = readCredits().length;
    const brokenBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n'));
        controller.error(new Error("stream socket broke"));
      },
    });
    const response = await paidCall(
      c,
      () => new Response(brokenBody, { headers: { "content-type": "text/event-stream" } }),
      "paid-stream-body-error",
    );
    await expect(response.body!.getReader().read()).rejects.toThrow("stream socket broke");
    const reject = () => rejectPaidNoCompletion(response, "stream socket broke");
    expect(reject).toThrow(MppPaidNoCompletionError);
    expect(readCredits().slice(before)).toEqual([
      {
        payer: TEST_PAYER,
        amount: challenge.request.amount,
        challengeId: "paid-stream-body-error",
        reason: "HTTP 200",
      },
    ]);
    expect(history(c)).toHaveLength(1);
    expect(history(c)[0].note).toContain("signed, no completion (HTTP 200)");
  });

  it("leaves an unsigned HTTP 200 error eligible for ordinary provider fallback", () => {
    expect(() =>
      rejectPaidNoCompletion(new Response('{"error":"overloaded"}'), "provider overloaded"),
    ).not.toThrow();
  });

  it("a seller 500 after signing stops the call, keeps the spend, and notes it in the ledger", async () => {
    const c = control();
    const before = readCredits().length;
    const err = await paidCall(c, () => new Response("model crashed", { status: 500 })).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(MppPaidNoCompletionError);
    expect(err.status).toBe(500);
    expect(err.reference).toMatch(/^mpp-[0-9a-f]{16}$/);
    expect(err.message).toContain(err.reference);
    expect(err.message).toContain("model crashed");
    expect(err.message).not.toContain("secret-credential-bytes");
    expect(history(c)).toHaveLength(1); // the spend stays
    expect(history(c)[0].note).toContain("signed, no completion (HTTP 500)");
    expect(history(c)[0].note).toContain(err.reference);
    await paidCall(c, () => new Response("model crashed", { status: 500 })).catch(() => {});
    const added = readCredits().slice(before);
    expect(added).toEqual([
      {
        payer: TEST_PAYER,
        amount: challenge.request.amount,
        challengeId: challenge.id,
        reason: "HTTP 500",
      },
    ]);
  });

  it("a never-ending error body cannot stall the failure report", async () => {
    const c = control();
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        pulled++;
        ctrl.enqueue(new TextEncoder().encode("x".repeat(4096)));
      },
    });
    const started = Date.now();
    const err = await paidCall(c, () => new Response(endless, { status: 500 })).catch((e) => e);
    expect(err).toBeInstanceOf(MppPaidNoCompletionError);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(pulled).toBeLessThan(50); // read a bounded amount, not the whole stream
    expect(err.message.length).toBeLessThan(600);
    expect(history(c)[0].note).toContain("signed, no completion (HTTP 500)");
  });

  it("a body that goes silent mid-read is cut off by the timeout", async () => {
    const stalled = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode("partial"));
      }, // never closes, never sends more
    });
    const started = Date.now();
    const snippet = await boundedSnippet(new Response(stalled, { status: 500 }), 100);
    expect(snippet).toBe("partial");
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("a thrown error after signing is the same outcome, with the cause kept", async () => {
    const c = control();
    const boom = new Error("socket hang up");
    const err = await guardPaid(c, async () => {
      await guardMethod(fakeMethod(), c).createCredential({ challenge });
      throw boom;
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MppPaidNoCompletionError);
    expect(err.cause).toBe(boom);
    expect(history(c)[0].note).toContain("request failed");
  });

  it("a 200 after signing passes through and the ledger gets no note", async () => {
    const c = control();
    const res = await paidCall(c, () => new Response("pong", { status: 200 }));
    expect(await res.text()).toBe("pong");
    expect(history(c)).toHaveLength(1);
    expect(history(c)[0].note).toBeUndefined();
  });

  it("a failure before anything was signed passes through unchanged", async () => {
    const c = control();
    const res = await guardPaid(c, async () => new Response("nope", { status: 500 }));
    expect(res.status).toBe(500);
    await expect(
      guardPaid(c, async () => {
        throw new Error("dns");
      }),
    ).rejects.toThrow("dns");
  });

  it("a local policy refusal is never reported as a paid failure", async () => {
    const c = control();
    c.setLimit("perRequest", 0.0001);
    const err = await paidCall(c, () => new Response("x")).catch((e) => e);
    expect(err).toBeInstanceOf(SpendPolicyError);
    expect(history(c)).toHaveLength(0);
  });

  it("works without a spend control: still stops, no ledger to annotate", async () => {
    const err = await guardPaid(undefined, async () => {
      markSigned("tx-bytes", creditFromChallenge(challenge, TEST_PAYER)!);
      return new Response("bad gateway", { status: 502 });
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MppPaidNoCompletionError);
    expect(err.reference).toMatch(/^mpp-[0-9a-f]{16}$/);
  });

  it("runs the call once: the guard itself never retries", async () => {
    const run = vi.fn(async () => {
      markSigned("tx", creditFromChallenge(challenge, TEST_PAYER)!);
      return new Response("x", { status: 503 });
    });
    await guardPaid(undefined, run).catch(() => {});
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("the reference is stable for the same payload and differs between payloads", async () => {
    const ref = async (p: string) =>
      (
        await guardPaid(undefined, async () => {
          markSigned(p, creditFromChallenge(challenge, TEST_PAYER)!);
          return new Response("", { status: 500 });
        }).catch((e) => e)
      ).reference;
    expect(await ref("a")).toBe(await ref("a"));
    expect(await ref("a")).not.toBe(await ref("b"));
  });
});

import { loadOptional } from "./mpp-optional.js";

describe("optional MPP packages", () => {
  it("turns a missing package into an install instruction", async () => {
    const missing = Object.assign(new Error("Cannot find package 'mppx' imported from /x"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    const err = await loadOptional("mppx", "~0.17.0", async () => {
      throw missing;
    }).catch((e) => e);
    expect(err.message).toContain('needs the optional package "mppx"');
    expect(err.message).toContain("npm install mppx@~0.17.0");
    expect(err.cause).toBe(missing);
  });

  it("does not mask other failures, or a different missing module", async () => {
    const other = new Error("boom");
    await expect(
      loadOptional("mppx", "~0.17.0", async () => {
        throw other;
      }),
    ).rejects.toBe(other);
    const dep = Object.assign(new Error("Cannot find package 'ox' imported from /y"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    await expect(
      loadOptional("mppx", "~0.17.0", async () => {
        throw dep;
      }),
    ).rejects.toBe(dep);
  });
});
