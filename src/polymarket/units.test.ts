import { describe, it, expect } from "vitest";
import { usdToBaseUnits } from "./units.js";

describe("usdToBaseUnits", () => {
  it("does not lose a base unit to float error (2.01 USDC = 2_010_000)", () => {
    // 2.01 * 1e6 === 2009999.9999999998 in IEEE-754; Math.floor gave 2_009_999.
    expect(usdToBaseUnits(2.01, 6)).toBe(2_010_000n);
    expect(usdToBaseUnits(4.02, 6)).toBe(4_020_000n);
    expect(usdToBaseUnits(8.19, 6)).toBe(8_190_000n);
  });

  it("is exact for every two-decimal amount from $0.01 to $100", () => {
    for (let cents = 1; cents <= 10_000; cents++) {
      expect(usdToBaseUnits(cents / 100, 6)).toBe(BigInt(cents) * 10_000n);
    }
  });

  it("keeps sub-cent precision", () => {
    expect(usdToBaseUnits(0.000001, 6)).toBe(1n);
    expect(usdToBaseUnits(1.234567, 6)).toBe(1_234_567n);
  });
});
