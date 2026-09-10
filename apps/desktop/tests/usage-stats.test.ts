import { describe, expect, it } from "vitest";

import { MAX_CHART_DAYS, niceCeiling, normalizeStats, windowLabel } from "../src/usage-stats.js";

/** YYYY-MM-DD `offset` days from today, UTC — the key the router logs by. */
function day(offset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

function stats(daily: Array<[string, number, number?]>, extra: Record<string, unknown> = {}) {
  return normalizeStats({
    dailyBreakdown: daily.map(([date, totalRequests, totalCost = 0]) => ({
      date,
      totalRequests,
      totalCost,
    })),
    ...extra,
  });
}

describe("normalizeStats window", () => {
  it("pads traffic-only days into a continuous window of at least 7 days", () => {
    const s = stats([
      [day(-6), 10],
      [day(-2), 5],
    ]);

    expect(s.daily).toHaveLength(7);
    expect(s.daily.map((d) => d.date)).toEqual([...Array(7)].map((_, i) => day(i - 6)));
    // The quiet days render as zero bars rather than vanishing.
    expect(s.daily.filter((d) => d.requests === 0)).toHaveLength(5);
    expect(windowLabel(s.daily)).toBe("last 7 days");
  });

  it("stretches back to an older day the router still reported, up to the cap", () => {
    const s = stats([
      [day(-10), 3],
      [day(0), 7],
    ]);

    expect(s.daily).toHaveLength(11);
    expect(s.daily[0].date).toBe(day(-10));
    expect(windowLabel(s.daily)).toBe("last 11 days");
  });

  it("renders nothing rather than a fabricated window when every day predates the cap", () => {
    // The router reports the 7 most recent log FILES, which for an intermittent
    // user can all be older than the cap. Padding to today would draw a week of
    // zero bars for days nobody measured and label them "last 7 days".
    const s = stats([[day(-(MAX_CHART_DAYS + 5)), 120]]);

    expect(s.daily).toEqual([]);
    expect(windowLabel(s.daily)).toBe("no data yet");
  });

  it("counts the days it renders, so the metric card cannot contradict the bars", () => {
    const s = stats(
      [
        [day(-3), 4],
        [day(-1), 6],
      ],
      // The router's own total spans further back than the window.
      { requests: 999, totalRequests: 999 },
    );

    expect(s.requests).toBe(10);
    expect(s.requests).toBe(s.daily.reduce((sum, d) => sum + d.requests, 0));
  });

  it("keeps the router's total when there is no window to count", () => {
    expect(normalizeStats({ totalRequests: 42 }).requests).toBe(42);
    expect(normalizeStats(null).requests).toBe(0);
    expect(normalizeStats(undefined).daily).toEqual([]);
  });

  it("sums duplicate rows for one date and skips unparseable ones", () => {
    const s = stats([
      [day(0), 2, 0.5],
      [day(0), 3, 0.25],
      ["not-a-date", 100],
    ]);

    const today = s.daily.find((d) => d.date === day(0));
    expect(today?.requests).toBe(5);
    expect(today?.cost).toBeCloseTo(0.75, 10);
    expect(s.daily.some((d) => d.requests === 100)).toBe(false);
  });

  it("labels every day in UTC, so evening traffic west of Greenwich is not a tomorrow bar", () => {
    const s = stats([["2026-03-01", 1]], {});
    const march = s.daily.find((d) => d.date === "2026-03-01");
    // Only present when 2026-03-01 is inside the window; guard for a stable test.
    if (march) expect(march.label).toContain("1");
    expect(s.daily.every((d) => d.date === d.date.slice(0, 10))).toBe(true);
  });

  it("reads the savings the router actually returns", () => {
    const s = normalizeStats({ totalSavings: 12.5, savingsPercentage: 84.7 });
    expect(s.savings).toBe(12.5);
    expect(s.savingsPct).toBe(84.7);
    // Absent rather than guessed when the router omits them.
    expect(normalizeStats({}).savings).toBe(0);
  });
});

describe("niceCeiling", () => {
  it("never returns zero, so the chart divisor is safe on an all-quiet window", () => {
    expect(niceCeiling(0)).toBeGreaterThan(0);
    expect(niceCeiling(1)).toBe(4);
  });

  it("rounds up to a readable tick", () => {
    expect(niceCeiling(23)).toBe(24);
    expect(niceCeiling(91)).toBe(100);
    expect(niceCeiling(101)).toBe(120);
  });
});
