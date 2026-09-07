import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isTwzrdAutoGateRequested,
  isTwzrdGateSoftSkip,
  maybeInstallTwzrdAutoGate,
} from "./twzrd-autogate.js";

describe("TWZRD AutoGate opt-in (#355)", () => {
  const prev = process.env.TWZRD_AUTO_GATE;

  afterEach(() => {
    if (prev === undefined) delete process.env.TWZRD_AUTO_GATE;
    else process.env.TWZRD_AUTO_GATE = prev;
  });

  it("is off unless TWZRD_AUTO_GATE is 1/true/on", () => {
    delete process.env.TWZRD_AUTO_GATE;
    expect(isTwzrdAutoGateRequested()).toBe(false);
    process.env.TWZRD_AUTO_GATE = "0";
    expect(isTwzrdAutoGateRequested()).toBe(false);
    process.env.TWZRD_AUTO_GATE = "false";
    expect(isTwzrdAutoGateRequested()).toBe(false);
    process.env.TWZRD_AUTO_GATE = "1";
    expect(isTwzrdAutoGateRequested()).toBe(true);
    process.env.TWZRD_AUTO_GATE = "true";
    expect(isTwzrdAutoGateRequested()).toBe(true);
    process.env.TWZRD_AUTO_GATE = "on";
    expect(isTwzrdAutoGateRequested()).toBe(true);
  });

  it("skips without loading the gate when env is unset", async () => {
    delete process.env.TWZRD_AUTO_GATE;
    const loadGate = vi.fn(async () => {
      throw new Error("must not load");
    });
    const client = { onBeforePaymentCreation() {} };
    await expect(maybeInstallTwzrdAutoGate(client, { loadGate })).resolves.toBe("skipped");
    expect(loadGate).not.toHaveBeenCalled();
  });

  it("installs on the client after opt-in", async () => {
    process.env.TWZRD_AUTO_GATE = "1";
    const hooks: unknown[] = [];
    const client = {
      onBeforePaymentCreation(hook: unknown) {
        hooks.push(hook);
      },
    };
    const installTwzrdAutoGate = vi.fn((c: unknown, _opts?: unknown) => {
      (c as { onBeforePaymentCreation: (h: unknown) => void }).onBeforePaymentCreation(
        async () => undefined,
      );
    });
    const outcome = await maybeInstallTwzrdAutoGate(client, {
      loadGate: async () => ({ installTwzrdAutoGate }),
    });
    expect(outcome).toBe("installed");
    expect(installTwzrdAutoGate).toHaveBeenCalledOnce();
    expect(hooks.length).toBe(1);
    const opts = installTwzrdAutoGate.mock.calls[0][1] as unknown as {
      attribution?: { integration: string };
      refuseWashFlagged?: boolean;
    };
    expect(opts.attribution?.integration).toBe("clawrouter");
    expect(opts.refuseWashFlagged).toBe(true);
  });

  it("soft-skip matcher only accepts missing twzrd-x402-gate itself", () => {
    expect(
      isTwzrdGateSoftSkip(
        Object.assign(new Error("Cannot find package 'twzrd-x402-gate' imported from /app/proxy.js"), {
          code: "ERR_MODULE_NOT_FOUND",
        }),
      ),
    ).toBe(true);
    expect(
      isTwzrdGateSoftSkip(
        Object.assign(
          new Error("Cannot find package 'some-transitive-dep' imported from /app/node_modules/twzrd-x402-gate/index.js"),
          { code: "ERR_MODULE_NOT_FOUND" },
        ),
      ),
    ).toBe(false);
    expect(isTwzrdGateSoftSkip(new Error("boom unrelated"))).toBe(false);
  });

  it("returns missing when the optional package is absent", async () => {
    process.env.TWZRD_AUTO_GATE = "1";
    const err = Object.assign(new Error("Cannot find package 'twzrd-x402-gate'"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    const outcome = await maybeInstallTwzrdAutoGate(
      { onBeforePaymentCreation() {} },
      { loadGate: async () => { throw err; } },
    );
    expect(outcome).toBe("missing");
  });

  it("rethrows a non-missing load error (fail closed)", async () => {
    process.env.TWZRD_AUTO_GATE = "1";
    await expect(
      maybeInstallTwzrdAutoGate(
        { onBeforePaymentCreation() {} },
        { loadGate: async () => { throw new Error("syntax error in gate"); } },
      ),
    ).rejects.toThrow(/syntax error in gate/);
  });
});
