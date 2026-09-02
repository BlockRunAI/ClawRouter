/**
 * SpendControl tests — limits, recording, window expiry, persistence.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import { x402Client } from "@x402/fetch";
import {
  SpendControl,
  InMemorySpendControlStorage,
  formatDuration,
  registerSpendPolicyHook,
  assertSpendPolicyAllows,
  getSharedSpendControl,
  MalformedSpendPolicyError,
  setSharedSpendControl,
  SpendPolicyError,
  CAIP2_BASE,
  CAIP2_SOLANA_MAINNET,
} from "./spend-control.js";

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

    it("matches checksummed EVM denylist entries case-insensitively", () => {
      const { control } = createControl();
      const checksummed = "0xAbcDef0123456789AbcDef0123456789AbcDef01";
      control.setPolicy("blockedPayees", [checksummed]);
      const result = control.check(0.01, { payTo: checksummed.toLowerCase() });
      expect(result.allowed).toBe(false);
      expect(result.blockedByPolicy).toBe("blockedPayees");
    });

    it("leaves Solana base58 payees case-sensitive", () => {
      const { control } = createControl();
      control.setPolicy("blockedPayees", ["SoLanaPayee1111111111111111111111111111111"]);
      expect(
        control.check(0.01, { payTo: "SoLanaPayee1111111111111111111111111111111" }).allowed,
      ).toBe(false);
      expect(
        control.check(0.01, { payTo: "solanapayee1111111111111111111111111111111" }).allowed,
      ).toBe(true);
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
      control.setPolicy("allowedNetworks", [CAIP2_BASE]);
      expect(control.check(0.01, { network: CAIP2_BASE }).allowed).toBe(true);
    });

    it("blocks a network not in the allowlist", () => {
      const { control } = createControl();
      control.setPolicy("allowedNetworks", [CAIP2_BASE]);
      const result = control.check(0.01, { network: CAIP2_SOLANA_MAINNET });
      expect(result.allowed).toBe(false);
      expect(result.blockedByPolicy).toBe("allowedNetworks");
    });

    it("does not treat the nickname 'base' as eip155:8453", () => {
      const { control } = createControl();
      control.setPolicy("allowedNetworks", [CAIP2_BASE]);
      const result = control.check(0.01, { network: "base" });
      expect(result.allowed).toBe(false);
      expect(result.blockedByPolicy).toBe("allowedNetworks");
    });

    it("fails closed when configured but no network is given", () => {
      const { control } = createControl();
      control.setPolicy("allowedNetworks", [CAIP2_BASE]);
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
        allowedNetworks: [CAIP2_BASE],
        allowedAssets: ["USDC"],
      },
      history: [],
    });

    const loaded = storage.load();
    expect(loaded?.limits.perRequest).toBe(0.5);
    expect(loaded?.limits.allowedPayees).toEqual(["0xgood"]);
    expect(loaded?.limits.blockedPayees).toEqual(["0xbad"]);
    expect(loaded?.limits.allowedNetworks).toEqual([CAIP2_BASE]);
    expect(loaded?.limits.allowedAssets).toEqual(["USDC"]);
  });

  it("refuses to load when a policy list has a malformed entry", async () => {
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

    expect(() => storage.load()).toThrow(/refusing to load spending.json/);
  });

  it("treats an empty policy array as cleared, not corrupted", async () => {
    // Hand-editing a list to [] is how an operator clears it. Refusing to load
    // would take the proxy down over a legal edit.
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawrouter-spend-"));
    process.env.HOME = tmpHome;
    vi.resetModules();
    const mod = await import("./spend-control.js");
    const storage = new mod.FileSpendControlStorage();
    const spendingFile = path.join(tmpHome, ".openclaw", "blockrun", "spending.json");
    fs.mkdirSync(path.dirname(spendingFile), { recursive: true });
    fs.writeFileSync(
      spendingFile,
      JSON.stringify({ limits: { blockedPayees: [], hourly: 1 }, history: [] }),
    );

    const loaded = storage.load();
    expect(loaded?.limits.blockedPayees).toBeUndefined();
    expect(loaded?.limits.hourly).toBe(1);
  });

  it("normalizes persisted checksummed payees on load", async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawrouter-spend-"));
    process.env.HOME = tmpHome;
    vi.resetModules();
    const mod = await import("./spend-control.js");
    const storage = new mod.FileSpendControlStorage();
    const spendingFile = path.join(tmpHome, ".openclaw", "blockrun", "spending.json");
    fs.mkdirSync(path.dirname(spendingFile), { recursive: true });
    fs.writeFileSync(
      spendingFile,
      JSON.stringify({
        limits: { blockedPayees: ["0xAbcDef0123456789AbcDef0123456789AbcDef01"] },
        history: [],
      }),
    );

    expect(storage.load()?.limits.blockedPayees).toEqual([
      "0xabcdef0123456789abcdef0123456789abcdef01",
    ]);
  });

  it("recording spend does not overwrite a policy edit made on disk", async () => {
    // The proxy loads limits once at startup. Writing its in-memory copy back
    // on every payment would erase an operator's hand-edit seconds later.
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawrouter-spend-"));
    process.env.HOME = tmpHome;
    vi.resetModules();
    const mod = await import("./spend-control.js");
    const spendingFile = path.join(tmpHome, ".openclaw", "blockrun", "spending.json");
    fs.mkdirSync(path.dirname(spendingFile), { recursive: true });
    fs.writeFileSync(spendingFile, JSON.stringify({ limits: {}, history: [] }));

    const control = new mod.SpendControl({ storage: new mod.FileSpendControlStorage() });

    // Operator blocks a payee while the proxy is already running.
    fs.writeFileSync(
      spendingFile,
      JSON.stringify({ limits: { blockedPayees: ["0xdead"] }, history: [] }),
    );

    control.record(0.01, { action: "x402 payment" });

    const onDisk = JSON.parse(fs.readFileSync(spendingFile, "utf8"));
    expect(onDisk.limits.blockedPayees).toEqual(["0xdead"]);
    expect(onDisk.history).toHaveLength(1);
  });
});

describe("x402 onBeforePaymentCreation spend policy", () => {
  const blocked = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  function payment(client: x402Client, amount: string, payTo = blocked) {
    return client.createPaymentPayload({
      x402Version: 2,
      resource: { url: "https://example.invalid/pay" },
      accepts: [
        {
          scheme: "exact",
          network: CAIP2_BASE,
          amount,
          asset: "USDC",
          payTo,
          maxTimeoutSeconds: 60,
          extra: {},
        },
      ],
    });
  }

  it("aborts before the scheme signer is invoked", async () => {
    let signerCalls = 0;
    const storage = new InMemorySpendControlStorage();
    const control = new SpendControl({ storage });
    control.setPolicy("blockedPayees", [blocked]);

    const client = new x402Client();
    registerSpendPolicyHook(client, control);
    client.register(CAIP2_BASE, {
      scheme: "exact",
      async createPaymentPayload() {
        signerCalls += 1;
        return { x402Version: 2, payload: {} };
      },
    });

    await expect(payment(client, "1000")).rejects.toThrow(/Payment creation aborted/);
    expect(signerCalls).toBe(0);
  });

  it("reserves aggregate budget before signing the next payment", async () => {
    let signerCalls = 0;
    const control = new SpendControl({ storage: new InMemorySpendControlStorage() });
    control.setLimit("hourly", 0.015);
    const client = new x402Client();
    registerSpendPolicyHook(client, control);
    client.register(CAIP2_BASE, {
      scheme: "exact",
      async createPaymentPayload() {
        signerCalls += 1;
        return { x402Version: 2, payload: {} };
      },
    });

    await payment(client, "10000", "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    await expect(
      payment(client, "10000", "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
    ).rejects.toThrow(/Payment creation aborted/);
    expect(signerCalls).toBe(1);
    expect(control.getSpending("hourly")).toBe(0.01);
  });

  it("only one of two concurrent payments clears the same remaining budget", async () => {
    let signerCalls = 0;
    const control = new SpendControl({ storage: new InMemorySpendControlStorage() });
    control.setLimit("hourly", 0.015);
    const client = new x402Client();
    registerSpendPolicyHook(client, control);
    client.register(CAIP2_BASE, {
      scheme: "exact",
      async createPaymentPayload() {
        signerCalls += 1;
        return { x402Version: 2, payload: {} };
      },
    });

    const payee = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const results = await Promise.allSettled([
      payment(client, "10000", payee),
      payment(client, "10000", payee),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(signerCalls).toBe(1);
  });

  describe("amount parsing is fail-closed", () => {
    // parseInt(v, 10) stops at the first non-decimal character while the EVM
    // scheme signs BigInt(v), which accepts radix prefixes:
    //   parseInt("0x1DCD6500", 10) === 0   BigInt("0x1DCD6500") === 500000000n
    // A gateway quoting hex would otherwise read as $0 against every cap and
    // still get a $500 authorization signed.
    const nonCanonical = ["0x1DCD6500", "0X10", "0b1010", "0o17", "1e9", "abc", "-1000", ""];

    for (const amount of nonCanonical) {
      it(`refuses to sign a quote of ${JSON.stringify(amount)} when a limit is set`, async () => {
        let signerCalls = 0;
        const control = new SpendControl({ storage: new InMemorySpendControlStorage() });
        control.setLimit("perRequest", 0.01);
        const client = new x402Client();
        registerSpendPolicyHook(client, control);
        client.register(CAIP2_BASE, {
          scheme: "exact",
          async createPaymentPayload() {
            signerCalls += 1;
            return { x402Version: 2, payload: {} };
          },
        });

        await expect(
          payment(client, amount, "0xcccccccccccccccccccccccccccccccccccccccc"),
        ).rejects.toThrow(/no usable amount/);
        expect(signerCalls).toBe(0);
      });
    }

    it("still signs a canonical decimal quote", async () => {
      let signerCalls = 0;
      const control = new SpendControl({ storage: new InMemorySpendControlStorage() });
      control.setLimit("perRequest", 0.02);
      const client = new x402Client();
      registerSpendPolicyHook(client, control);
      client.register(CAIP2_BASE, {
        scheme: "exact",
        async createPaymentPayload() {
          signerCalls += 1;
          return { x402Version: 2, payload: {} };
        },
      });

      await payment(client, "10000", "0xcccccccccccccccccccccccccccccccccccccccc");
      expect(signerCalls).toBe(1);
    });

    it("reads the v1 maxAmountRequired field, which carries no `amount`", () => {
      const control = new SpendControl({ storage: new InMemorySpendControlStorage() });
      control.setLimit("perRequest", 0.005);

      // v1 quote for $0.01 — over the $0.005 cap, so it must be refused on
      // amount rather than sail through as an unparseable $0.
      expect(() =>
        assertSpendPolicyAllows(control, {
          payTo: "0xcccccccccccccccccccccccccccccccccccccccc",
          network: CAIP2_BASE,
          maxAmountRequired: "10000",
        }),
      ).toThrow(/Per-request limit exceeded/);
    });

    it("allows an unparseable amount through when no amount window is configured", () => {
      // Policy-only setups never compare an amount, so a missing quote is not
      // a reason to refuse — the payee allowlist still decides.
      const control = new SpendControl({ storage: new InMemorySpendControlStorage() });
      control.setPolicy("allowedPayees", ["0xcccccccccccccccccccccccccccccccccccccccc"]);

      expect(() =>
        assertSpendPolicyAllows(control, {
          payTo: "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
          network: CAIP2_BASE,
        }),
      ).not.toThrow();
    });
  });

  it("releases the reservation when the signer fails, instead of draining the window", async () => {
    const control = new SpendControl({ storage: new InMemorySpendControlStorage() });
    control.setLimit("hourly", 0.015);
    const client = new x402Client();
    registerSpendPolicyHook(client, control);
    client.register(CAIP2_BASE, {
      scheme: "exact",
      async createPaymentPayload() {
        throw new Error("signer boom");
      },
    });

    await expect(
      payment(client, "10000", "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
    ).rejects.toThrow(/signer boom/);

    // Nothing was signed, so nothing was spent — a failed payment must not
    // consume budget, or a burst of failures locks the window with no money moved.
    expect(control.getSpending("hourly")).toBe(0);
    expect(control.getHistory()).toHaveLength(0);
  });

  it("throws a typed SpendPolicyError so callers can tell refusal from an upstream fault", async () => {
    const control = new SpendControl({ storage: new InMemorySpendControlStorage() });
    control.setPolicy("blockedPayees", [blocked]);
    const client = new x402Client();
    registerSpendPolicyHook(client, control);
    client.register(CAIP2_BASE, {
      scheme: "exact",
      async createPaymentPayload() {
        return { x402Version: 2, payload: {} };
      },
    });

    const err = await payment(client, "1000").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpendPolicyError);
    expect((err as SpendPolicyError).blockedByPolicy).toBe("blockedPayees");
  });
});

describe("in-flight reservations under a live (non-frozen) clock", () => {
  // Every other test in this file injects a FROZEN clock (`now: () => clock`, see
  // createControl above): both clock reads inside a single check() return the same
  // value, so a reservation is always counted and the race below cannot surface.
  // Production uses Date.now(), which advances — when a millisecond ticks between
  // the `now` check() captures at its top and the second `this.now()` the window
  // helper used to read, the hourly/daily window silently dropped the pending
  // total. This live clock (each read 1ms later) models that sub-ms advance so the
  // concurrent-overspend path is actually exercised.
  const liveClock = (startMs = 1_000_000_000_000) => {
    let t = startMs;
    return () => (t += 1);
  };

  it("counts an in-flight reservation against the hourly window while the clock advances mid-check", () => {
    const control = new SpendControl({
      storage: new InMemorySpendControlStorage(),
      now: liveClock(),
    });
    control.setLimit("hourly", 1.0);

    // Payment A is signed-in-flight: it cleared check() and reserved its cost but
    // has not settled yet.
    control.reserve(0.8);

    // Payment B arrives concurrently. A's live $0.80 hold plus B's $0.80 is $1.60,
    // over the $1.00/hr cap — B must be refused, or the two together overspend.
    const result = control.check(0.8, {});
    expect(result.allowed).toBe(false);
    expect(result.blockedBy).toBe("hourly");
  });

  it("counts an in-flight reservation against the daily window while the clock advances mid-check", () => {
    const control = new SpendControl({
      storage: new InMemorySpendControlStorage(),
      now: liveClock(),
    });
    control.setLimit("daily", 1.0);
    control.reserve(0.8);

    const result = control.check(0.8, {});
    expect(result.allowed).toBe(false);
    expect(result.blockedBy).toBe("daily");
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

describe("process-wide shared instance", () => {
  it("hands every surface the same instance", () => {
    const control = new SpendControl({ storage: new InMemorySpendControlStorage() });
    setSharedSpendControl(control);

    expect(getSharedSpendControl()).toBe(control);
    expect(getSharedSpendControl()).toBe(getSharedSpendControl());
  });

  it("a restart sees history from every surface because both recorded on ONE instance", () => {
    const storage = new InMemorySpendControlStorage();
    const clock = Date.now();
    setSharedSpendControl(new SpendControl({ storage, now: () => clock }));

    // The proxy's x402 hook settles with "x402 payment"; signUnderSpendPolicy
    // with "polymarket order". Both must land on the same instance.
    const control = getSharedSpendControl();
    control.settleReservation(control.reserve(2), { action: "x402 payment" });
    control.settleReservation(control.reserve(25), { action: "polymarket order" });
    expect(control.getSpending("hourly")).toBeCloseTo(27);

    // Restart: a fresh instance must see BOTH records — the old per-surface
    // shape last-writer-won the file and dropped the other surface's history.
    const restarted = new SpendControl({ storage, now: () => clock });
    expect(restarted.getSpending("hourly")).toBeCloseTo(27);
    const actions = restarted.getHistory().map((r) => r.action);
    expect(actions).toContain("x402 payment");
    expect(actions).toContain("polymarket order");
  });
});

// The singleton is process state; leave a fresh in-memory one behind so no
// test in this file can see another's instance.
afterEach(() => {
  setSharedSpendControl(new SpendControl({ storage: new InMemorySpendControlStorage() }));
});

describe("reloadLimits (in-process proxy restart)", () => {
  it("adopts an on-disk edit and keeps this instance's history and windows", () => {
    const storage = new InMemorySpendControlStorage();
    const clock = Date.now();
    const live = new SpendControl({ storage, now: () => clock });
    live.record(2, { action: "x402 payment" });

    // A CLI in another process (or a hand-edit) lands a new cap on disk.
    new SpendControl({ storage, now: () => clock }).setLimit("hourly", 5);
    expect(live.getLimits().hourly).toBeUndefined();

    live.reloadLimits();

    expect(live.getLimits().hourly).toBe(5);
    expect(live.getSpending("hourly")).toBeCloseTo(2);
    expect(live.check(4).allowed).toBe(false); // 2 recorded + 4 > 5: the window survived
  });

  it("fails closed on a malformed file and recovers once it is repaired", () => {
    let broken = false;
    class FlakyStorage extends InMemorySpendControlStorage {
      override load() {
        if (broken) throw new MalformedSpendPolicyError("blockedPayees");
        return super.load();
      }
    }
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const live = new SpendControl({ storage: new FlakyStorage() });
    expect(live.check(0.01).allowed).toBe(true);

    broken = true;
    live.reloadLimits();
    expect(live.check(0.01).allowed).toBe(false);
    expect(live.getPolicyFileError()).toMatch(/blockedPayees/);

    broken = false;
    live.reloadLimits();
    expect(live.check(0.01).allowed).toBe(true);
    expect(live.getPolicyFileError()).toBeUndefined();
    errors.mockRestore();
  });
});
