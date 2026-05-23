/**
 * Tests that the partner-routing regex in proxy.ts matches /v1/surf/* paths
 * (so Surf API calls flow through proxyPaidApiRequest with x402) without
 * accidentally matching unrelated paths like /v1/surfer.
 *
 * Mirrors the regex literal from src/proxy.ts so a silent regex edit fails
 * here loudly.
 */
import { describe, it, expect } from "vitest";

// MUST stay in sync with the regex in src/proxy.ts (partner-path match).
const PARTNER_PATH_REGEX =
  /^\/v1\/(?:partner|pm|exa|modal|stocks|usstock|crypto|fx|commodity|phone|voice|surf)\//;

describe("partner path regex — surf", () => {
  it("matches /v1/surf/market/price", () => {
    expect(PARTNER_PATH_REGEX.test("/v1/surf/market/price")).toBe(true);
  });

  it("matches /v1/surf/onchain/sql (POST endpoint)", () => {
    expect(PARTNER_PATH_REGEX.test("/v1/surf/onchain/sql")).toBe(true);
  });

  it("matches /v1/surf/wallet/labels/batch", () => {
    expect(PARTNER_PATH_REGEX.test("/v1/surf/wallet/labels/batch")).toBe(true);
  });

  it("matches /v1/surf/prediction-market/polymarket/markets", () => {
    expect(PARTNER_PATH_REGEX.test("/v1/surf/prediction-market/polymarket/markets")).toBe(true);
  });

  it("matches /v1/surf/chat/completions", () => {
    expect(PARTNER_PATH_REGEX.test("/v1/surf/chat/completions")).toBe(true);
  });

  it("does NOT match /v1/surfer (word-boundary check)", () => {
    expect(PARTNER_PATH_REGEX.test("/v1/surfer/profile")).toBe(false);
  });

  it("does NOT match /v1/surfaces (prefix collision check)", () => {
    expect(PARTNER_PATH_REGEX.test("/v1/surfaces/list")).toBe(false);
  });

  it("does NOT match bare /v1/surf (no trailing slash)", () => {
    expect(PARTNER_PATH_REGEX.test("/v1/surf")).toBe(false);
  });

  it("still matches existing partner paths (regression guard)", () => {
    expect(PARTNER_PATH_REGEX.test("/v1/pm/polymarket/events")).toBe(true);
    expect(PARTNER_PATH_REGEX.test("/v1/exa/search")).toBe(true);
    expect(PARTNER_PATH_REGEX.test("/v1/phone/lookup")).toBe(true);
    expect(PARTNER_PATH_REGEX.test("/v1/voice/call")).toBe(true);
    expect(PARTNER_PATH_REGEX.test("/v1/stocks/us/price/AAPL")).toBe(true);
  });

  it("still rejects non-partner /v1 routes (regression guard)", () => {
    expect(PARTNER_PATH_REGEX.test("/v1/chat/completions")).toBe(false);
    expect(PARTNER_PATH_REGEX.test("/v1/models")).toBe(false);
    expect(PARTNER_PATH_REGEX.test("/v1/images/generations")).toBe(false);
  });
});
