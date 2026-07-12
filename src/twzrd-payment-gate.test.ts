/**
 * TWZRD optional pre-sign gate — enablement, defaults, install path.
 */

import { describe, it, expect, vi } from "vitest";
import {
  isTwzrdPaymentGateEnabled,
  isTwzrdGateOnCanSpend,
  maybeInstallTwzrdPaymentGate,
  type TwzrdGateX402Client,
} from "./twzrd-payment-gate.js";

function mockClient(): TwzrdGateX402Client & {
  hooks: Array<(ctx: unknown) => unknown>;
} {
  const hooks: Array<(ctx: unknown) => unknown> = [];
  return {
    hooks,
    onBeforePaymentCreation(hook) {
      hooks.push(hook as (ctx: unknown) => unknown);
      return this;
    },
  };
}

describe("isTwzrdPaymentGateEnabled", () => {
  it("defaults to disabled", () => {
    expect(isTwzrdPaymentGateEnabled({})).toBe(false);
  });

  it("accepts CLAWROUTER_TWZRD truthy values", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on", " On "]) {
      expect(isTwzrdPaymentGateEnabled({ CLAWROUTER_TWZRD: v }), v).toBe(true);
    }
  });

  it("accepts CLAWROUTER_TWZRD_ENABLED alias", () => {
    expect(isTwzrdPaymentGateEnabled({ CLAWROUTER_TWZRD_ENABLED: "1" })).toBe(
      true,
    );
  });

  it("rejects falsy / garbage", () => {
    for (const v of ["0", "false", "off", "no", "", "maybe"]) {
      expect(isTwzrdPaymentGateEnabled({ CLAWROUTER_TWZRD: v }), v).toBe(false);
    }
  });
});

describe("isTwzrdGateOnCanSpend", () => {
  it("defaults to decision-only (false)", () => {
    expect(isTwzrdGateOnCanSpend({})).toBe(false);
    expect(isTwzrdGateOnCanSpend({ CLAWROUTER_TWZRD: "1" })).toBe(false);
  });

  it("opts in via CLAWROUTER_TWZRD_GATE_ON_CAN_SPEND or TWZRD_GATE_ON_CAN_SPEND", () => {
    expect(
      isTwzrdGateOnCanSpend({ CLAWROUTER_TWZRD_GATE_ON_CAN_SPEND: "1" }),
    ).toBe(true);
    expect(isTwzrdGateOnCanSpend({ TWZRD_GATE_ON_CAN_SPEND: "true" })).toBe(
      true,
    );
  });
});

describe("maybeInstallTwzrdPaymentGate", () => {
  it("no-ops when disabled (does not import gate)", async () => {
    const client = mockClient();
    const loadGate = vi.fn();
    const result = await maybeInstallTwzrdPaymentGate(client, {
      env: {},
      loadGate,
      log: () => {},
    });
    expect(result).toEqual({ installed: false, reason: "disabled" });
    expect(loadGate).not.toHaveBeenCalled();
    expect(client.hooks).toHaveLength(0);
  });

  it("installs decision-only hook when enabled", async () => {
    const client = mockClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const install = vi.fn((c: TwzrdGateX402Client, opts?: any) => {
      c.onBeforePaymentCreation(async () => undefined);
      expect(opts.gateOnCanSpend).toBe(false);
      expect(opts.refuseWashFlagged).toBe(true);
      expect(opts.attribution).toEqual({
        integration: "clawrouter",
        runId: expect.any(String),
      });
      return c;
    });

    const logs: string[] = [];
    const result = await maybeInstallTwzrdPaymentGate(client, {
      env: { CLAWROUTER_TWZRD: "1" },
      loadGate: async () => ({ installTwzrdX402ClientHook: install }),
      log: (m) => logs.push(m),
    });

    expect(result).toEqual({ installed: true, mode: "decision-only" });
    expect(install).toHaveBeenCalledTimes(1);
    expect(client.hooks).toHaveLength(1);
    expect(logs.some((l) => l.includes("TWZRD x402 pre-sign gate ON"))).toBe(
      true,
    );
    expect(logs.some((l) => l.includes("decision-only"))).toBe(true);
  });

  it("installs strict-can-spend when second opt-in set", async () => {
    const client = mockClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const install = vi.fn((c: TwzrdGateX402Client, opts?: any) => {
      expect(opts.gateOnCanSpend).toBe(true);
      return c;
    });

    const result = await maybeInstallTwzrdPaymentGate(client, {
      env: {
        CLAWROUTER_TWZRD: "1",
        CLAWROUTER_TWZRD_GATE_ON_CAN_SPEND: "1",
      },
      loadGate: async () => ({ installTwzrdX402ClientHook: install }),
      log: () => {},
    });

    expect(result).toEqual({ installed: true, mode: "strict-can-spend" });
  });

  it("honors attribution env overrides", async () => {
    const client = mockClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const install = vi.fn((_c: TwzrdGateX402Client, opts?: any) => {
      expect(opts.attribution).toEqual({
        integration: "clawrouter-ci",
        runId: "run-42",
      });
      return _c;
    });

    await maybeInstallTwzrdPaymentGate(client, {
      env: {
        CLAWROUTER_TWZRD: "1",
        TWZRD_ATTRIBUTION_INTEGRATION: "clawrouter-ci",
        TWZRD_ATTRIBUTION_RUN_ID: "run-42",
      },
      loadGate: async () => ({ installTwzrdX402ClientHook: install }),
      log: () => {},
    });

    expect(install).toHaveBeenCalled();
  });

  it("reports package-missing without throwing", async () => {
    const client = mockClient();
    const logs: string[] = [];
    const result = await maybeInstallTwzrdPaymentGate(client, {
      env: { CLAWROUTER_TWZRD: "1" },
      loadGate: async () => {
        throw new Error("Cannot find package 'twzrd-x402-gate'");
      },
      log: (m) => logs.push(m),
    });

    expect(result.installed).toBe(false);
    if (!result.installed) {
      expect(result.reason).toBe("package-missing");
    }
    expect(logs.some((l) => l.includes("not installed"))).toBe(true);
    expect(client.hooks).toHaveLength(0);
  });

  it("onDecision logger fires allow and block shapes", async () => {
    const client = mockClient();
    let capturedOnDecision:
      | ((d: {
          approved: boolean;
          reason: string;
          verdict: string;
          payTo?: string;
          network?: string;
          amountMicro?: string;
        }) => void)
      | undefined;

    await maybeInstallTwzrdPaymentGate(client, {
      env: { CLAWROUTER_TWZRD: "1" },
      loadGate: async () => ({
        installTwzrdX402ClientHook: (_c, opts) => {
          capturedOnDecision = opts?.onDecision as typeof capturedOnDecision;
          return _c;
        },
      }),
      log: () => {},
    });

    const logs: string[] = [];
    // Re-install with log capture on the same path via manual call to captured
    await maybeInstallTwzrdPaymentGate(client, {
      env: { CLAWROUTER_TWZRD: "1" },
      loadGate: async () => ({
        installTwzrdX402ClientHook: (_c, opts) => {
          capturedOnDecision = opts?.onDecision as typeof capturedOnDecision;
          return _c;
        },
      }),
      log: (m) => logs.push(m),
    });

    expect(capturedOnDecision).toBeTypeOf("function");
    capturedOnDecision!({
      approved: true,
      reason: "ok",
      verdict: "allow",
      payTo: "Seller111",
      network: "solana:mainnet",
      amountMicro: "1000",
    });
    capturedOnDecision!({
      approved: false,
      reason: "twzrd_wash_flagged",
      verdict: "block",
      payTo: "Wash222",
      network: "solana:mainnet",
      amountMicro: "5000",
    });

    expect(logs.some((l) => l.includes("pre-sign allow") && l.includes("Seller111"))).toBe(
      true,
    );
    expect(logs.some((l) => l.includes("pre-sign BLOCK") && l.includes("Wash222"))).toBe(
      true,
    );
  });
});

describe("hook seat contract (TOCTOU framing)", () => {
  /**
   * Documents the invariant this integration relies on: the hook receives the
   * same selectedRequirements the client will sign — not a prior probe.
   */
  it("registers onBeforePaymentCreation, not a pre-request probe", async () => {
    const client = mockClient();
    let registered = false;
    await maybeInstallTwzrdPaymentGate(client, {
      env: { CLAWROUTER_TWZRD: "1" },
      loadGate: async () => ({
        installTwzrdX402ClientHook: (c) => {
          c.onBeforePaymentCreation(async (ctx) => {
            // Selected requirement fields are what we score
            expect(ctx.selectedRequirements).toBeDefined();
            registered = true;
          });
          return c;
        },
      }),
      log: () => {},
    });

    expect(client.hooks).toHaveLength(1);
    await client.hooks[0]!({
      selectedRequirements: {
        payTo: "MerchantXYZ",
        network: "solana:mainnet",
        amount: "1000",
        resource: "https://example.com/paid",
      },
    });
    expect(registered).toBe(true);
  });
});
