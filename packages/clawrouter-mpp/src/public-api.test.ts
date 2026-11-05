import { describe, expect, it, vi } from "vitest";
import {
  CreditLedger,
  creditPaidNoCompletion,
  fulfillPaidProof,
  MppPaidNoCompletionError,
  readCredits,
  ReplayRejectedError,
  SpentProofLedger,
} from "./index.js";

describe("public replay and credit APIs", () => {
  it("rejects concurrent reuse before the model and exposes the specified error", async () => {
    const ledger = new SpentProofLedger();
    const model = vi.fn(async () => "completion");
    const run = () =>
      fulfillPaidProof({
        ledger,
        networkId: "eip155:4217",
        txSignature: "verified-tx",
        challengeId: "challenge",
        upstream: model,
      });
    const results = await Promise.allSettled([run(), run()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(ReplayRejectedError);
    expect(loser.reason).toMatchObject({ status: 409, code: "proof_replayed" });
    expect(model).toHaveBeenCalledTimes(1);
  });

  it("keeps the proof spent after a model failure", async () => {
    const ledger = new SpentProofLedger();
    const model = vi.fn(async () => {
      throw new Error("model failed");
    });
    const run = () =>
      fulfillPaidProof({
        ledger,
        networkId: "eip155:4217",
        txSignature: "verified-tx",
        challengeId: "challenge",
        upstream: model,
      });
    await expect(run()).rejects.toThrow("model failed");
    await expect(run()).rejects.toBeInstanceOf(ReplayRejectedError);
    expect(model).toHaveBeenCalledTimes(1);
  });

  it("returns the same immutable credit row on retry and never invokes a signer", () => {
    const ledger = new CreditLedger();
    const sign = vi.fn(async () => "forbidden");
    const error = new MppPaidNoCompletionError("no completion", "fixture-ref", 502);
    const fields = {
      payer: "actual-payer",
      amount: "750",
      challengeId: "challenge",
      reason: "HTTP 502",
    };
    const first = creditPaidNoCompletion(ledger, error, fields, { sign });
    const second = creditPaidNoCompletion(ledger, error, { ...fields, reason: "retry" }, { sign });
    expect(second).toBe(first);
    expect(readCredits(ledger)).toEqual([fields]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(readCredits(ledger))).toBe(true);
    expect(sign).not.toHaveBeenCalled();
  });

  it("separates payers and refuses invalid credit errors", () => {
    const ledger = new CreditLedger();
    const error = new MppPaidNoCompletionError("no completion", "fixture-ref");
    const fields = {
      payer: "payer-a",
      amount: "750",
      challengeId: "challenge",
      reason: "request failed",
    };
    creditPaidNoCompletion(ledger, error, fields);
    creditPaidNoCompletion(ledger, error, { ...fields, payer: "payer-b" });
    expect(readCredits(ledger)).toHaveLength(2);
    expect(() =>
      creditPaidNoCompletion(ledger, new Error("unpaid") as MppPaidNoCompletionError, fields),
    ).toThrow(TypeError);
  });
});
