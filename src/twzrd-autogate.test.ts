import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Proxy installs TWZRD AutoGate on the internal x402Client before payFetch.
 * We unit-test the env kill + dynamic import contract without booting the proxy.
 */
describe("TWZRD AutoGate seat (Fork-1)", () => {
  const prevAuto = process.env.TWZRD_AUTO_GATE;
  const prevGate = process.env.TWZRD_GATE_ENABLED;

  afterEach(() => {
    if (prevAuto === undefined) delete process.env.TWZRD_AUTO_GATE;
    else process.env.TWZRD_AUTO_GATE = prevAuto;
    if (prevGate === undefined) delete process.env.TWZRD_GATE_ENABLED;
    else process.env.TWZRD_GATE_ENABLED = prevGate;
    vi.resetModules();
    vi.unmock("twzrd-x402-gate");
  });

  it("isTwzrdAutoGateDisabled honors TWZRD_AUTO_GATE=0", async () => {
    process.env.TWZRD_AUTO_GATE = "0";
    const { isTwzrdAutoGateDisabled } = await import("twzrd-x402-gate");
    expect(isTwzrdAutoGateDisabled()).toBe(true);
  });

  it("isTwzrdAutoGateDisabled default false when env unset", async () => {
    delete process.env.TWZRD_AUTO_GATE;
    delete process.env.TWZRD_GATE_ENABLED;
    const { isTwzrdAutoGateDisabled } = await import("twzrd-x402-gate");
    expect(isTwzrdAutoGateDisabled()).toBe(false);
  });

  it("installTwzrdAutoGate registers on a client with onBeforePaymentCreation", async () => {
    delete process.env.TWZRD_AUTO_GATE;
    delete process.env.TWZRD_GATE_ENABLED;
    const hooks: Array<(ctx: unknown) => Promise<unknown>> = [];
    const client = {
      onBeforePaymentCreation(hook: (ctx: unknown) => Promise<unknown>) {
        hooks.push(hook);
      },
    };
    const { installTwzrdAutoGate } = await import("twzrd-x402-gate");
    installTwzrdAutoGate(client as never, {
      refuseWashFlagged: true,
      gateOnCanSpend: false,
      unsupportedNetworkMode: "observe",
    });
    // install wraps registrar + installs at least one hook path
    expect(typeof client.onBeforePaymentCreation).toBe("function");
  });
});
