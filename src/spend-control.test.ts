/**
 * SpendControl tests — limits, recording, window expiry, persistence.
 */

import { describe, it, expect } from "vitest";
import {
  SpendControl,
  InMemorySpendControlStorage,
  formatDuration,
} from "./spend-control.js";

function createControl(nowMs = Date.now()) {
  let clock = nowMs;
  const storage = new InMemorySpendControlStorage();
  const control = new SpendControl({ storage, now: () => clock });
  const advance = (ms: number) => { clock += ms; };
  return { control, storage, advance };
}

describe("SpendControl", () => {
  describe("per-request limit", () => {
    it("allows requests under the limit", () => {
      const { control } = createControl();
      control.setLimit("perRequest", 0.10);
      expect(control.check(0.05).allowed).toBe(true);
    });

    it("blocks requests over the limit", () => {
      const { control } = createControl();
      control.setLimit("perRequest", 0.10);
      const result = control.check(0.15);
      expect(result.allowed).toBe(false);
      expect(result.blockedBy).toBe("perRequest");
    });

    it("blocks requests exactly at the limit boundary", () => {
      const { control } = createControl();
      control.setLimit("perRequest", 0.10);
      // Exactly equal should pass
      expect(control.check(0.10).allowed).toBe(true);
      // Just over should fail
      expect(control.check(0.100001).allowed).toBe(false);
    });
  });

  describe("hourly limit", () => {
    it("accumulates spending within the hour", () => {
      const { control } = createControl();
      control.setLimit("hourly", 1.00);

      control.record(0.40);
      control.record(0.40);
      expect(control.check(0.25).allowed).toBe(false);
      expect(control.check(0.15).allowed).toBe(true);
    });

    it("resets after the hour window passes", () => {
      const { control, advance } = createControl();
      control.setLimit("hourly", 1.00);

      control.record(0.90);
      expect(control.check(0.20).allowed).toBe(false);

      // Advance past the 1-hour window
      advance(61 * 60 * 1000);
      expect(control.check(0.20).allowed).toBe(true);
    });

    it("provides resetIn seconds", () => {
      const { control } = createControl();
      control.setLimit("hourly", 0.50);

      control.record(0.50);
      const result = control.check(0.01);
      expect(result.allowed).toBe(false);
      expect(result.resetIn).toBeGreaterThan(0);
      expect(result.resetIn).toBeLessThanOrEqual(3600);
    });
  });

  describe("daily limit", () => {
    it("accumulates across hours within the day", () => {
      const { control, advance } = createControl();
      control.setLimit("daily", 5.00);

      control.record(2.00);
      advance(2 * 60 * 60 * 1000); // 2 hours later
      control.record(2.00);
      expect(control.check(1.50).allowed).toBe(false);
      expect(control.check(0.90).allowed).toBe(true);
    });

    it("resets after the day window passes", () => {
      const { control, advance } = createControl();
      control.setLimit("daily", 5.00);

      control.record(4.90);
      expect(control.check(0.20).allowed).toBe(false);

      advance(25 * 60 * 60 * 1000); // 25 hours
      expect(control.check(0.20).allowed).toBe(true);
    });
  });

  describe("session limit", () => {
    it("tracks spending within the session", () => {
      const { control } = createControl();
      control.setLimit("session", 2.00);

      control.record(1.50);
      expect(control.check(0.60).allowed).toBe(false);
      expect(control.check(0.40).allowed).toBe(true);
    });

    it("resetSession clears session spending", () => {
      const { control } = createControl();
      control.setLimit("session", 2.00);

      control.record(1.90);
      expect(control.check(0.20).allowed).toBe(false);

      control.resetSession();
      expect(control.check(0.20).allowed).toBe(true);
    });
  });

  describe("multiple limits", () => {
    it("checks all limits and reports the first violation", () => {
      const { control } = createControl();
      control.setLimit("perRequest", 0.50);
      control.setLimit("hourly", 2.00);

      // Over per-request limit
      const result = control.check(0.60);
      expect(result.allowed).toBe(false);
      expect(result.blockedBy).toBe("perRequest");
    });

    it("checks hourly after per-request passes", () => {
      const { control } = createControl();
      control.setLimit("perRequest", 1.00);
      control.setLimit("hourly", 2.00);

      control.record(1.80);
      const result = control.check(0.30);
      expect(result.allowed).toBe(false);
      expect(result.blockedBy).toBe("hourly");
    });
  });

  describe("getStatus", () => {
    it("returns current spending and remaining amounts", () => {
      const { control } = createControl();
      control.setLimit("hourly", 3.00);
      control.setLimit("daily", 10.00);

      control.record(1.00);
      control.record(0.50);

      const status = control.getStatus();
      expect(status.spending.hourly).toBeCloseTo(1.50);
      expect(status.spending.session).toBeCloseTo(1.50);
      expect(status.remaining.hourly).toBeCloseTo(1.50);
      expect(status.remaining.daily).toBeCloseTo(8.50);
      expect(status.calls).toBe(2);
    });
  });

  describe("getHistory", () => {
    it("returns records in reverse chronological order", () => {
      const { control, advance } = createControl();
      control.record(0.10, { model: "first" });
      advance(1000);
      control.record(0.20, { model: "second" });

      const history = control.getHistory();
      expect(history).toHaveLength(2);
      expect(history[0].model).toBe("second");
      expect(history[1].model).toBe("first");
    });

    it("respects limit parameter", () => {
      const { control, advance } = createControl();
      control.record(0.10);
      advance(100);
      control.record(0.20);
      advance(100);
      control.record(0.30);

      expect(control.getHistory(2)).toHaveLength(2);
    });
  });

  describe("clearLimit", () => {
    it("removes a specific limit", () => {
      const { control } = createControl();
      control.setLimit("perRequest", 0.01);
      expect(control.check(0.05).allowed).toBe(false);

      control.clearLimit("perRequest");
      expect(control.check(0.05).allowed).toBe(true);
    });
  });

  describe("persistence", () => {
    it("persists limits and history across instances via shared storage", () => {
      const storage = new InMemorySpendControlStorage();
      let clock = Date.now();

      const c1 = new SpendControl({ storage, now: () => clock });
      c1.setLimit("hourly", 5.00);
      c1.record(2.00);

      // New instance, same storage
      const c2 = new SpendControl({ storage, now: () => clock });
      expect(c2.getLimits().hourly).toBe(5.00);
      expect(c2.getSpending("hourly")).toBeCloseTo(2.00);
    });
  });

  describe("validation", () => {
    it("rejects non-positive limits", () => {
      const { control } = createControl();
      expect(() => control.setLimit("hourly", 0)).toThrow();
      expect(() => control.setLimit("hourly", -1)).toThrow();
    });

    it("rejects negative record amounts", () => {
      const { control } = createControl();
      expect(() => control.record(-0.50)).toThrow();
    });

    it("rejects non-finite values", () => {
      const { control } = createControl();
      expect(() => control.setLimit("hourly", Infinity)).toThrow();
      expect(() => control.setLimit("hourly", NaN)).toThrow();
    });
  });
});

describe("formatDuration", () => {
  it("formats seconds", () => {
    expect(formatDuration(30)).toBe("30s");
  });

  it("formats minutes", () => {
    expect(formatDuration(120)).toBe("2 min");
    expect(formatDuration(90)).toBe("2 min");
  });

  it("formats hours and minutes", () => {
    expect(formatDuration(3660)).toBe("1h 1m");
    expect(formatDuration(7200)).toBe("2h");
  });
});
