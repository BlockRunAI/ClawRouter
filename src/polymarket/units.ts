// src/polymarket/units.ts
//
// Dollar amounts arrive from the agent as JS numbers (e.g. 2.01). Multiplying
// by 10 ** decimals is not exact in IEEE-754 (2.01 * 1e6 === 2009999.9999999998),
// so Math.floor() silently drops one base unit for ~1.5% of two-decimal
// amounts. Round to the nearest base unit instead: the caller meant the
// decimal value they typed, not the float just below it.

/** Convert a dollar amount to integer token base units (6 decimals for USDC/pUSD). */
export function usdToBaseUnits(usd: number, decimals: number): bigint {
  return BigInt(Math.round(usd * 10 ** decimals));
}
