/**
 * SpendControl tests — limits, recording, window expiry, persistence.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import { SpendControl, InMemorySpendControlStorage, formatDuration } from "./spend-control.js";

function createControl(nowMs = Date.now()) {
  let clock = nowMs;
  const storage = new InMemorySpendControlStorage();
  const control = new SpendControl({ storage, now: () => clock });
  const advance = (ms: number) => {
    clock += ms;
  };
  return { control, storage, advance };
}

describe("SpendControl", () => {
  describe("per-request limit", () => {
    it("allows requests under the limit", () => {
      const { control } = createControl();
      control.setLimit("perRequest", 0.1);
      expect(control.check(0.05).allowed).toBe(true);
    });

    it("blocks requests over the limit", () => {
      const { control } = createControl();
      control.setLimit("perRequest", 0.1);
      const result = control.check(0.15);
      expect(result.allowed).toBe(false);
      expect(result.blockedBy).toBe("perRequest");
    });

    it("blocks requests exactly at the limit boundary", () => {
      const { control } = createControl();
      control.setLimit("perRequest", 0.1);
      // Exactly equal should pass
      expect(control.check(0.1).allowed).toBe(true);
      // Just over should fail
      expect(control.check(0.100001).allowed).toBe(false);
    });
  });

  describe("hourly limit", () => {
    it("accumulates spending within the hour", () => {
      const { control } = createControl();
      control.setLimit("hourly", 1.0);

      control.record(0.4);
      control.record(0.4);
      expect(control.check(0.25).allowed).toBe(false);
      expect(control.check(0.15).allowed).toBe(true);
    });

    it("resets after the hour window passes", () => {
      const { control, advance } = createControl();
      control.setLimit("hourly", 1.0);

      control.record(0.9);
      expect(control.check(0.2).allowed).toBe(false);

      // Advance past the 1-hour window
      advance(61 * 60 * 1000);
      expect(control.check(0.2).allowed).toBe(true);
    });

    it("provides resetIn seconds", () => {
      const { control } = createControl();
      control.setLimit("hourly", 0.5);

      control.record(0.5);
      const result = control.check(0.01);
      expect(result.allowed).toBe(false);
      expect(result.resetIn).toBeGreaterThan(0);
      expect(result.resetIn).toBeLessThanOrEqual(3600);
    });
  });

  describe("daily limit", () => {
    it("accumulates across hours within the day", () => {
      const { control, advance } = createControl();
      control.setLimit("daily", 5.0);

      control.record(2.0);
      advance(2 * 60 * 60 * 1000); // 2 hours later
      control.record(2.0);
      expect(control.check(1.5).allowed).toBe(false);
      expect(control.check(0.9).allowed).toBe(true);
    });

    it("resets after the day window passes", () => {
      const { control, advance } = createControl();
      control.setLimit("daily", 5.0);

      control.record(4.9);
      expect(control.check(0.2).allowed).toBe(false);

      advance(25 * 60 * 60 * 1000); // 25 hours
      expect(control.check(0.2).allowed).toBe(true);
    });
  });

  describe("session limit", () => {
    it("tracks spending within the session", () => {
      const { control } = createControl();
      control.setLimit("session", 2.0);

      control.record(1.5);
      expect(control.check(0.6).allowed).toBe(false);
      expect(control.check(0.4).allowed).toBe(true);
    });

    it("resetSession clears session spending", () => {
      const { control } = createControl();
      control.setLimit("session", 2.0);

      control.record(1.9);
      expect(control.check(0.2).allowed).toBe(false);

      control.resetSession();
      expect(control.check(0.2).allowed).toBe(true);
    });
  });

  describe("multiple limits", () => {
    it("checks all limits and reports the first violation", () => {
      const { control } = createControl();
      control.setLimit("perRequest", 0.5);
      control.setLimit("hourly", 2.0);

      // Over per-request limit
      const result = control.check(0.6);
      expect(result.allowed).toBe(false);
      expect(result.blockedBy).toBe("perRequest");
    });

    it("checks hourly after per-request passes", () => {
      const { control } = createControl();
      control.setLimit("perRequest", 1.0);
      control.setLimit("hourly", 2.0);

      control.record(1.8);
      const result = control.check(0.3);
      expect(result.allowed).toBe(false);
      expect(result.blockedBy).toBe("hourly");
    });
  });

  describe("getStatus", () => {
    it("returns current spending and remaining amounts", () => {
      const { control } = createControl();
      control.setLimit("hourly", 3.0);
      control.setLimit("daily", 10.0);

      control.record(1.0);
      control.record(0.5);

      const status = control.getStatus();
      expect(status.spending.hourly).toBeCloseTo(1.5);
      expect(status.spending.session).toBeCloseTo(1.5);
      expect(status.remaining.hourly).toBeCloseTo(1.5);
      expect(status.remaining.daily).toBeCloseTo(8.5);
      expect(status.calls).toBe(2);
    });
  });

  describe("getHistory", () => {
    it("returns records in reverse chronological order", () => {
      const { control, advance } = createControl();
      control.record(0.1, { model: "first" });
      advance(1000);
      control.record(0.2, { model: "second" });

      const history = control.getHistory();
      expect(history).toHaveLength(2);
      expect(history[0].model).toBe("second");
      expect(history[1].model).toBe("first");
    });

    it("respects limit parameter", () => {
      const { control, advance } = createControl();
      control.record(0.1);
      advance(100);
      control.record(0.2);
      advance(100);
      control.record(0.3);

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
      const clock = Date.now();

      const c1 = new SpendControl({ storage, now: () => clock });
      c1.setLimit("hourly", 5.0);
      c1.record(2.0);

      // New instance, same storage
      const c2 = new SpendControl({ storage, now: () => clock });
      expect(c2.getLimits().hourly).toBe(5.0);
      expect(c2.getSpending("hourly")).toBeCloseTo(2.0);
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
      expect(() => control.record(-0.5)).toThrow();
    });

    it("rejects non-finite values", () => {
      const { control } = createControl();
      expect(() => control.setLimit("hourly", Infinity)).toThrow();
      expect(() => control.setLimit("hourly", NaN)).toThrow();
    });
  });
});

describe("counterparty policy", () => {
  describe("payee allowlist/blocklist", () => {
    it("has no effect when not configured", () => {
      const { control } = createControl();
      expect(control.check(0.01, { payTo: "0xanything" }).allowed).toBe(true);
      expect(control.check(0.01).allowed).toBe(true);
    });

    it("allows a payee in the allowlist", () => {
      const { control } = createControl();
      control.setPolicy("allowedPayees", ["0xgood"]);
      expect(control.check(0.01, { payTo: "0xgood" }).allowed).toBe(true);
    });

    it("blocks a payee not in the allowlist", () => {
      const { control } = createControl();
      control.setPolicy("allowedPayees", ["0xgood"]);
      const result = control.check(0.01, { payTo: "0xother" });
      expect(result.allowed).toBe(false);
      expect(result.blockedByPolicy).toBe("allowedPayees");
    });

    it("blocks a payee on the blocklist", () => {
      const { control } = createControl();
      control.setPolicy("blockedPayees", ["0xbad"]);
      const result = control.check(0.01, { payTo: "0xbad" });
      expect(result.allowed).toBe(false);
      expect(result.blockedByPolicy).toBe("blockedPayees");
    });

    it("passes a payee not on the blocklist", () => {
      const { control } = createControl();
      control.setPolicy("blockedPayees", ["0xbad"]);
      expect(control.check(0.01, { payTo: "0xfine" }).allowed).toBe(true);
    });

    it("blocklist wins when a payee is on both lists", () => {
      const { control } = createControl();
      control.setPolicy("allowedPayees", ["0xboth"]);
      control.setPolicy("blockedPayees", ["0xboth"]);
      const result = control.check(0.01, { payTo: "0xboth" });
      expect(result.allowed).toBe(false);
      expect(result.blockedByPolicy).toBe("blockedPayees");
    });

    it("fails closed when policy is configured but no payTo is given", () => {
      const { control } = createControl();
      control.setPolicy("allowedPayees", ["0xgood"]);
      const result = control.check(0.01);
      expect(result.allowed).toBe(false);
      expect(result.blockedByPolicy).toBe("allowedPayees");
    });

    it("clearPolicy removes a configured list", () => {
      const { control } = createControl();
      control.setPolicy("allowedPayees", ["0xgood"]);
      control.clearPolicy("allowedPayees");
      expect(control.check(0.01, { payTo: "0xanything" }).allowed).toBe(true);
    });

    it("does not set blockedBy (SpendWindow) for a policy denial", () => {
      const { control } = createControl();
      control.setLimit("perRequest", 1000);
      control.setPolicy("blockedPayees", ["0xbad"]);
      const result = control.check(0.01, { payTo: "0xbad" });
      expect(result.allowed).toBe(false);
      expect(result.blockedByPolicy).toBe("blockedPayees");
      expect(result.blockedBy).toBeUndefined();
    });
  });

  describe("network allowlist", () => {
    it("has no effect when not configured", () => {
      const { control } = createControl();
      expect(control.check(0.01, { network: "anything" }).allowed).toBe(true);
    });

    it("allows a network in the allowlist", () => {
      const { control } = createControl();
      control.setPolicy("allowedNetworks", ["base"]);
      expect(control.check(0.01, { network: "base" }).allowed).toBe(true);
    });

    it("blocks a network not in the allowlist", () => {
      const { control } = createControl();
      control.setPolicy("allowedNetworks", ["base"]);
      const result = control.check(0.01, { network: "solana" });
      expect(result.allowed).toBe(false);
      expect(result.blockedByPolicy).toBe("allowedNetworks");
    });

    it("fails closed when configured but no network is given", () => {
      const { control } = createControl();
      control.setPolicy("allowedNetworks", ["base"]);
      const result = control.check(0.01);
      expect(result.allowed).toBe(false);
      expect(result.blockedByPolicy).toBe("allowedNetworks");
    });
  });

  describe("asset allowlist", () => {
    it("allows an asset in the allowlist", () => {
      const { control } = createControl();
      control.setPolicy("allowedAssets", ["USDC"]);
      expect(control.check(0.01, { asset: "USDC" }).allowed).toBe(true);
    });

    it("blocks an asset not in the allowlist", () => {
      const { control } = createControl();
      control.setPolicy("allowedAssets", ["USDC"]);
      const result = control.check(0.01, { asset: "SOL" });
      expect(result.allowed).toBe(false);
      expect(result.blockedByPolicy).toBe("allowedAssets");
    });
  });

  describe("setPolicy validation", () => {
    it("rejects an empty list", () => {
      const { control } = createControl();
      expect(() => control.setPolicy("allowedPayees", [])).toThrow();
    });

    it("rejects non-string or empty-string entries", () => {
      const { control } = createControl();
      // @ts-expect-error deliberately invalid entry type, for a runtime validation test
      expect(() => control.setPolicy("allowedPayees", [123])).toThrow();
      expect(() => control.setPolicy("allowedPayees", [""])).toThrow();
    });

    it("rejects a SpendWindow name passed as a policy list, and does not touch that limit", () => {
      const { control } = createControl();
      control.setLimit("perRequest", 0.5);
      // @ts-expect-error deliberately invalid list, for a runtime validation test
      expect(() => control.setPolicy("perRequest", ["0xgood"])).toThrow();
      expect(control.getLimits().perRequest).toBe(0.5);
    });

    it("clearPolicy rejects a SpendWindow name and does not clear that limit", () => {
      const { control } = createControl();
      control.setLimit("hourly", 1.0);
      // @ts-expect-error deliberately invalid list, for a runtime validation test
      expect(() => control.clearPolicy("hourly")).toThrow();
      expect(control.getLimits().hourly).toBe(1.0);
    });
  });

  describe("defensive copies", () => {
    it("mutating the array returned by getLimits() does not affect live policy", () => {
      const { control } = createControl();
      control.setPolicy("allowedPayees", ["0xgood"]);
      const limits = control.getLimits();
      limits.allowedPayees?.push("0xsneaky");
      expect(control.check(0.01, { payTo: "0xsneaky" }).allowed).toBe(false);
      expect(control.getLimits().allowedPayees).toEqual(["0xgood"]);
    });

    it("mutating the array returned by getStatus().limits does not affect live policy", () => {
      const { control } = createControl();
      control.setPolicy("blockedPayees", ["0xbad"]);
      const status = control.getStatus();
      status.limits.blockedPayees?.push("0xalsogood");
      expect(control.check(0.01, { payTo: "0xalsogood" }).allowed).toBe(true);
    });
  });

  describe("amount checks still run after policy passes", () => {
    it("still enforces perRequest once payee policy passes", () => {
      const { control } = createControl();
      control.setPolicy("allowedPayees", ["0xgood"]);
      control.setLimit("perRequest", 0.1);
      const result = control.check(0.5, { payTo: "0xgood" });
      expect(result.allowed).toBe(false);
      expect(result.blockedBy).toBe("perRequest");
    });
  });
});

describe("FileSpendControlStorage persistence", () => {
  let tmpHome: string | undefined;
  const originalHome = process.env.HOME;

  afterEach(() => {
    if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
    tmpHome = undefined;
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
  });

  it("round-trips policy lists, not just spend limits, across save/load", async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawrouter-spend-"));
    process.env.HOME = tmpHome;
    vi.resetModules();
    const mod = await import("./spend-control.js");
    const storage = new mod.FileSpendControlStorage();

    storage.save({
      limits: {
        perRequest: 0.5,
        allowedPayees: ["0xgood"],
        blockedPayees: ["0xbad"],
        allowedNetworks: ["base"],
        allowedAssets: ["USDC"],
      },
      history: [],
    });

    const loaded = storage.load();
    expect(loaded?.limits.perRequest).toBe(0.5);
    expect(loaded?.limits.allowedPayees).toEqual(["0xgood"]);
    expect(loaded?.limits.blockedPayees).toEqual(["0xbad"]);
    expect(loaded?.limits.allowedNetworks).toEqual(["base"]);
    expect(loaded?.limits.allowedAssets).toEqual(["USDC"]);
  });

  it("drops malformed policy entries instead of throwing", async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawrouter-spend-"));
    process.env.HOME = tmpHome;
    vi.resetModules();
    const mod = await import("./spend-control.js");
    const storage = new mod.FileSpendControlStorage();
    const spendingFile = path.join(tmpHome, ".openclaw", "blockrun", "spending.json");
    fs.mkdirSync(path.dirname(spendingFile), { recursive: true });
    fs.writeFileSync(
      spendingFile,
      JSON.stringify({ limits: { allowedPayees: ["ok", 123, ""] }, history: [] }),
    );

    const loaded = storage.load();
    expect(loaded?.limits.allowedPayees).toBeUndefined();
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
