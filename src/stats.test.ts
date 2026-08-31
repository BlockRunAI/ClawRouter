import { describe, expect, it } from "vitest";

import { resolveStatsDays, DEFAULT_STATS_DAYS, MAX_STATS_DAYS } from "./stats.js";

describe("resolveStatsDays", () => {
  it("defaults to the standard window when no param is given", () => {
    expect(resolveStatsDays(null)).toBe(DEFAULT_STATS_DAYS);
    expect(resolveStatsDays(undefined)).toBe(DEFAULT_STATS_DAYS);
    expect(resolveStatsDays("")).toBe(DEFAULT_STATS_DAYS);
  });

  it("passes a valid positive count through, clamped to the cap", () => {
    expect(resolveStatsDays("1")).toBe(1);
    expect(resolveStatsDays("7")).toBe(7);
    expect(resolveStatsDays(String(MAX_STATS_DAYS))).toBe(MAX_STATS_DAYS);
    expect(resolveStatsDays("31")).toBe(MAX_STATS_DAYS);
    expect(resolveStatsDays("500")).toBe(MAX_STATS_DAYS);
  });

  // Moved from /tmp/clawrepro/stats-days.test.ts. A non-numeric param used to
  // coerce to NaN, and Math.min(NaN, 30) stayed NaN, and getStats' slice(0, NaN)
  // read as slice(0, 0) — so `?days=abc` reported zero usage instead of the
  // default window.
  it("falls back to the default for a non-numeric param instead of coercing to NaN", () => {
    expect(resolveStatsDays("abc")).toBe(DEFAULT_STATS_DAYS);
    expect(resolveStatsDays("   ")).toBe(DEFAULT_STATS_DAYS);
  });

  // A negative value survived Math.min, and getStats' slice(0, -1) dropped the
  // newest day while the response mislabelled itself "last -1 days". Zero has the
  // same shape. The `> 0` guard covers both.
  it("rejects zero and negative windows, falling back to the default", () => {
    expect(resolveStatsDays("0")).toBe(DEFAULT_STATS_DAYS);
    expect(resolveStatsDays("-1")).toBe(DEFAULT_STATS_DAYS);
    expect(resolveStatsDays("-30")).toBe(DEFAULT_STATS_DAYS);
  });
});
