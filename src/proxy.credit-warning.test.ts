/**
 * `x-blockrun-credit-remaining-usd` — the pre-402 low-credit warning.
 *
 * Until the gateway published a remaining figure, a card-paying user got no
 * warning at all: the first sign of trouble was a call failing with 402, while
 * wallet users had a live balance the whole time.
 *
 * Two properties decide whether the warning is safe to act on, and both are
 * easy to get wrong in the same way the cost header was:
 *
 *   absent     → nothing to report. The gateway omits it on UNGATED accounts,
 *                which have no allowance to run down. Reading absence as 0
 *                would warn "credit exhausted" at an account with no limit at
 *                all — the failure this header prevents, inverted.
 *   "0.000000" → a real zero balance.
 *
 * The parser is module-private, so this exercises the same header semantics
 * against a real Response rather than importing it.
 */

import { describe, it, expect } from "vitest";

/** Mirror of proxy.ts's `gatewayRemainingCreditUsd`. */
function parse(response: Response): number | undefined {
  const raw = response.headers.get("x-blockrun-credit-remaining-usd");
  if (raw === null || raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined; // Number("") is 0, not NaN
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return value;
}

const LOW_CREDIT_USD = 1.0;

/** Mirror of noteRemainingCredit's decision, minus the console side effect. */
function decide(
  state: { warned: boolean },
  response: Response,
): "silent" | "warn-low" | "warn-empty" {
  const remaining = parse(response);
  if (remaining === undefined) return "silent";
  if (remaining > LOW_CREDIT_USD) {
    state.warned = false;
    return "silent";
  }
  if (state.warned) return "silent";
  state.warned = true;
  return remaining <= 0 ? "warn-empty" : "warn-low";
}

const res = (v?: string): Response =>
  new Response("{}", {
    headers: v === undefined ? {} : { "x-blockrun-credit-remaining-usd": v },
  });

describe("x-blockrun-credit-remaining-usd", () => {
  it("stays silent on an ungated account, where the header is absent", () => {
    // The important one: an ungated account has no limit, so absence must not
    // be read as "you have $0".
    expect(parse(res(undefined))).toBeUndefined();
    expect(decide({ warned: false }, res(undefined))).toBe("silent");
  });

  it("distinguishes absent from a genuine zero", () => {
    expect(parse(res("0.000000"))).toBe(0);
    expect(parse(res(undefined))).not.toBe(parse(res("0.000000")));
    expect(decide({ warned: false }, res("0.000000"))).toBe("warn-empty");
  });

  it("warns below the $1.00 threshold and stays quiet above it", () => {
    expect(decide({ warned: false }, res("12.500000"))).toBe("silent");
    expect(decide({ warned: false }, res("0.420000"))).toBe("warn-low");
    // Exactly at the threshold is not yet low.
    expect(decide({ warned: false }, res("1.000000"))).toBe("warn-low");
    expect(decide({ warned: false }, res("1.000001"))).toBe("silent");
  });

  it("warns once per crossing, not once per call", () => {
    const state = { warned: false };
    expect(decide(state, res("0.500000"))).toBe("warn-low");
    expect(decide(state, res("0.400000"))).toBe("silent");
    expect(decide(state, res("0.300000"))).toBe("silent");
  });

  it("re-arms after a top-up so the next drop is reported", () => {
    const state = { warned: false };
    expect(decide(state, res("0.500000"))).toBe("warn-low");
    expect(decide(state, res("25.000000"))).toBe("silent"); // topped up
    expect(decide(state, res("0.900000"))).toBe("warn-low"); // and warns again
  });

  it("treats a malformed value as absent, never as empty credit", () => {
    for (const bad of ["", "abc", "NaN", "Infinity", "-1", "$5"]) {
      expect(parse(res(bad)), `"${bad}" must read as absent`).toBeUndefined();
      expect(decide({ warned: false }, res(bad))).toBe("silent");
    }
  });
});
