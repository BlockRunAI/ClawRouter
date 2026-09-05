/**
 * Spend windows on the rail that never signs anything (#329).
 *
 * `SpendControl` was reached only through the x402 pre-sign hook, so on
 * `authMode === "api-key"` none of it ran. A `daily=5` written while on a wallet
 * went on reading like a $5/day cap after `clawrouter login` while the real
 * ceiling was the account balance — the startup warning was the only thing
 * standing between those two readings.
 *
 * `withSpendPolicy` moves the amount windows to that rail's only equivalent
 * choke point. What these pin is not the arithmetic (the windows already have
 * coverage) but the three things that are specific to enforcing at a fetch
 * rather than at a signature: which dispatches count, what amount is recorded,
 * and what happens when the call fails.
 */

import { describe, expect, it, vi } from "vitest";
import {
  InMemorySpendControlStorage,
  SpendControl,
  SpendPolicyError,
  withSpendPolicy,
} from "./spend-control.js";

function control(limits: Partial<Record<"perRequest" | "hourly" | "daily" | "session", number>>) {
  const c = new SpendControl({ storage: new InMemorySpendControlStorage() });
  for (const [window, amount] of Object.entries(limits)) {
    c.setLimit(window as "perRequest", amount as number);
  }
  return c;
}

/** A dispatch the caller marked billable at `usd`, then nothing (the polls). */
function publishOnce(usd: number): () => number | undefined {
  let pending: number | undefined = usd;
  return () => {
    const v = pending;
    pending = undefined;
    return v;
  };
}

const ok = (headers: Record<string, string> = {}) => new Response("{}", { status: 200, headers });

describe("withSpendPolicy on the API-key rail", () => {
  it("refuses a call over the per-request limit before it is dispatched", async () => {
    const inner = vi.fn(async () => ok());
    const fetchWithPolicy = withSpendPolicy(inner, control({ perRequest: 0.05 }), publishOnce(0.2));

    await expect(fetchWithPolicy("https://api.blockrun.ai/v1/chat/completions")).rejects.toThrow(
      SpendPolicyError,
    );
    // The point of enforcing here rather than after the fact: the account is
    // never charged, because the request never leaves.
    expect(inner).not.toHaveBeenCalled();
  });

  it("refuses once a rolling window is exhausted, and names the window", async () => {
    const c = control({ daily: 1 });
    c.record(0.99);
    const fetchWithPolicy = withSpendPolicy(async () => ok(), c, publishOnce(0.5));

    await expect(fetchWithPolicy("https://api.blockrun.ai/v1/chat/completions")).rejects.toThrow(
      /Daily limit exceeded/,
    );
  });

  it("records what the gateway charged, not what we guessed", async () => {
    const c = control({ daily: 5 });
    // The estimate is 152x the real charge — the exact shape of the chat
    // overstatement this rail already had in its journal. The window must move
    // by the settled figure.
    const fetchWithPolicy = withSpendPolicy(
      async () => ok({ "x-blockrun-cost-usd": "0.004000" }),
      c,
      publishOnce(0.61),
    );

    await fetchWithPolicy("https://api.blockrun.ai/v1/chat/completions");
    expect(c.getStatus().spending.daily).toBeCloseTo(0.004, 6);
  });

  it("falls back to the estimate when no charge has settled yet", async () => {
    // Absent is not zero: chat commits its charge after the response, and
    // recording $0 there is how paid calls went missing from /stats.
    const c = control({ daily: 5 });
    const fetchWithPolicy = withSpendPolicy(async () => ok(), c, publishOnce(0.02));

    await fetchWithPolicy("https://api.blockrun.ai/v1/chat/completions");
    expect(c.getStatus().spending.daily).toBeCloseTo(0.02, 6);
  });

  it("believes an explicit zero charge over the estimate", async () => {
    const c = control({ daily: 5 });
    const fetchWithPolicy = withSpendPolicy(
      async () => ok({ "x-blockrun-cost-usd": "0.000000" }),
      c,
      publishOnce(0.02),
    );

    await fetchWithPolicy("https://api.blockrun.ai/v1/chat/completions");
    expect(c.getStatus().spending.daily).toBe(0);
  });

  it("does not charge the window for a request the gateway rejected", async () => {
    // Unlike a signed x402 payment, account credit is not debited for a
    // request that came back 4xx/5xx.
    const c = control({ daily: 5 });
    const fetchWithPolicy = withSpendPolicy(
      async () => new Response("nope", { status: 500 }),
      c,
      publishOnce(0.3),
    );

    await fetchWithPolicy("https://api.blockrun.ai/v1/chat/completions");
    expect(c.getStatus().spending.daily).toBe(0);
  });

  it("does not charge the window when the dispatch throws", async () => {
    const c = control({ daily: 5 });
    const fetchWithPolicy = withSpendPolicy(
      async () => {
        throw new Error("fetch failed");
      },
      c,
      publishOnce(0.3),
    );

    await expect(fetchWithPolicy("https://api.blockrun.ai/v1/chat/completions")).rejects.toThrow(
      /fetch failed/,
    );
    expect(c.getStatus().spending.daily).toBe(0);
    // The reservation must be released too, or the next call inherits a
    // window that a failure drained.
    expect(c.checkAmount(4.9).allowed).toBe(true);
  });

  it("bills an async media job once, not once per poll", async () => {
    // Submit returns 202 + poll_url and the completing poll carries the settled
    // charge. Both go through payFetch. Only the submit published an estimate,
    // so the polls are neither checked nor recorded — otherwise a 30-poll video
    // job would drain a daily window on status checks alone.
    const c = control({ daily: 5 });
    const consume = publishOnce(0.4);
    let call = 0;
    const fetchWithPolicy = withSpendPolicy(
      async () => {
        call += 1;
        if (call === 1) return new Response("{}", { status: 202 });
        if (call < 4) return ok(); // queued / in_progress
        return ok({ "x-blockrun-cost-usd": "0.500000" }); // completed, settled
      },
      c,
      consume,
    );

    for (let i = 0; i < 4; i++) await fetchWithPolicy("https://api.blockrun.ai/v1/videos/x");

    // The submit's estimate, once. The polls contributed nothing — including
    // the completing one, whose charge belongs to the job already counted.
    expect(c.getStatus().spending.daily).toBeCloseTo(0.4, 6);
    expect(c.getStatus().calls).toBe(1);
  });

  it("passes through untouched when no amount window is configured", async () => {
    const inner = vi.fn(async () => ok());
    const c = new SpendControl({ storage: new InMemorySpendControlStorage() });
    c.setPolicy("blockedPayees", ["0x" + "a".repeat(40)]);

    // Counterparty lists are vacuous on this rail — one counterparty, no
    // on-chain asset — so a policy made only of them must not gate anything.
    await withSpendPolicy(inner, c, publishOnce(9_999))("https://api.blockrun.ai/v1/chat/x");
    expect(inner).toHaveBeenCalledOnce();
  });

  it("refuses everything when the policy file cannot be read", async () => {
    const c = control({ daily: 5 });
    // Same fail-closed posture as the signing hook: a policy we could not read
    // is not a policy that allows everything.
    (c as unknown as { policyFileBroken: string }).policyFileBroken = "EACCES";

    await expect(
      withSpendPolicy(
        async () => ok(),
        c,
        publishOnce(0.001),
      )("https://api.blockrun.ai/v1/chat/completions"),
    ).rejects.toThrow(/unreadable/i);
  });
});
