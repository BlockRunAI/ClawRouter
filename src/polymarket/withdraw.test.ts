import { describe, it, expect } from "vitest";
import { withdrawFunds } from "./withdraw.js";

describe("withdraw gating (input validation, no network)", () => {
  // A non-positive amount_usd would otherwise reach the balance check
  // (amountRaw > balanceRaw is false for zero or negative amounts) and the
  // bridge/transfer call downstream. Reject before any network call, same as
  // fund.ts's amount_usd guard.
  it("rejects a negative amount_usd before touching the network", async () => {
    const r = await withdrawFunds({ amount_usd: -5 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/amount_usd must be a positive dollar amount/i);
  });

  it("rejects amount_usd of zero before touching the network", async () => {
    const r = await withdrawFunds({ amount_usd: 0 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/amount_usd must be a positive dollar amount/i);
  });
});
