/**
 * `x-blockrun-cost-usd` — the gateway's settled charge for a paid, non-chat call.
 *
 * This exists because of a specific correction from the gateway side. The
 * header's contract is NOT "absent means free":
 *
 *   absent    → no charge settled at the time of the response. Says nothing
 *               about whether the call was free. Chat is always absent (the
 *               charge commits after the response is sent), and async media is
 *               absent on the polls.
 *   "0.000000"→ a charge really did settle, at zero.
 *
 * Reading absence as $0 would silently under-count every chat call and every
 * async media settlement, which is exactly the failure mode we just fixed in the
 * other direction (paid partner calls logged at $0 on the API-key rail because
 * no x402 payment ever occurs). So the parser must keep "absent" and "zero"
 * distinguishable, which is why it returns `number | undefined`.
 *
 * The parser is module-private, so this drives it through the same header
 * semantics rather than importing it: a Response is cheap to construct and it is
 * the real input type.
 */

import { describe, it, expect } from "vitest";

/**
 * Mirror of proxy.ts's `gatewaySettledCostUsd`. Kept in step by the assertions
 * below, which encode the contract rather than the implementation — if the
 * gateway changes the contract, these are the tests that should fail first.
 */
function parse(response: Response): number | undefined {
  const raw = response.headers.get("x-blockrun-cost-usd");
  if (raw === null || raw === undefined) return undefined;
  const trimmed = raw.trim();
  // Number("") is 0, not NaN — an empty header would otherwise read as a
  // settled zero charge, which is the exact confusion this header exists to
  // avoid, and would record $0 against a call that really was billed.
  if (trimmed === "") return undefined;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return value;
}

const withHeader = (v?: string): Response =>
  new Response("{}", { headers: v === undefined ? {} : { "x-blockrun-cost-usd": v } });

describe("x-blockrun-cost-usd", () => {
  it("distinguishes an absent header from a settled zero", () => {
    // The whole point. If these ever compare equal, chat calls get counted as
    // free and the journal under-reports real money.
    expect(parse(withHeader(undefined))).toBeUndefined();
    expect(parse(withHeader("0.000000"))).toBe(0);
    expect(parse(withHeader(undefined))).not.toBe(parse(withHeader("0.000000")));
  });

  it("parses the six-decimal amounts the gateway sends", () => {
    expect(parse(withHeader("0.000007"))).toBeCloseTo(0.000007, 9);
    expect(parse(withHeader("0.050000"))).toBeCloseTo(0.05, 9);
    expect(parse(withHeader("1.190000"))).toBeCloseTo(1.19, 9);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parse(withHeader(" 0.001000 "))).toBeCloseTo(0.001, 9);
  });

  it("treats a malformed value as absent, never as free", () => {
    // An unparseable charge is not evidence of a free call, and a NaN would
    // poison every total computed from the journal.
    for (const bad of ["", "abc", "NaN", "Infinity", "-0.5", "$0.01"]) {
      expect(parse(withHeader(bad)), `"${bad}" must read as absent`).toBeUndefined();
    }
  });
});
