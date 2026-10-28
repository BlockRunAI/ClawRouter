import { describe, expect, it } from "vitest";

import { chainSwitchInstruction, emptyWalletGuidance } from "./doctor.js";

const EVM = "0xCC8c44AD3dc2A58D841c3EB26131E49b22665EF8";
const SOL = "7Xkr1111111111111111111111111111111111111xyz";

describe("doctor empty-wallet guidance follows the active chain", () => {
  it("on Arc: fund USDC on Arc at the same address, no Base bridge", () => {
    const text = emptyWalletGuidance({
      paymentChain: "arc",
      address: EVM,
      solanaAddress: SOL,
    }).join("\n");
    expect(text).toContain(`USDC on Arc (same address as Base): ${EVM}`);
    expect(text).not.toMatch(/bridge\.base\.org/);
    expect(text).not.toMatch(/USDC on Base:/);
    expect(text).not.toContain(SOL);
  });

  it("on Base: unchanged — Base funding and the Base bridge", () => {
    const text = emptyWalletGuidance({
      paymentChain: "base",
      address: EVM,
      solanaAddress: null,
    }).join("\n");
    expect(text).toContain(`Fund your EVM wallet with USDC on Base: ${EVM}`);
    expect(text).toContain("https://bridge.base.org");
    expect(text).not.toMatch(/on Arc/);
  });

  it("on Solana: still lists the Solana address", () => {
    const text = emptyWalletGuidance({
      paymentChain: "solana",
      address: EVM,
      solanaAddress: SOL,
    }).join("\n");
    expect(text).toContain(`Fund your Solana wallet with USDC: ${SOL}`);
  });
});

describe("doctor chain-switch hints respect CLAWROUTER_PAYMENT_CHAIN", () => {
  it("gives the plain command when the env var is unset or empty", () => {
    expect(chainSwitchInstruction("base", "run chain base", undefined)).toBe("run chain base");
    expect(chainSwitchInstruction("base", "run chain base", "  ")).toBe("run chain base");
  });

  it("names the env var when it is set, since a saved chain would not take effect", () => {
    const hint = chainSwitchInstruction("solana", "run /wallet solana", "arc");
    expect(hint).toContain("set CLAWROUTER_PAYMENT_CHAIN=solana");
    expect(hint).toContain('"arc"');
    expect(hint).toContain("unset CLAWROUTER_PAYMENT_CHAIN and run /wallet solana");
  });

  it("the Arc empty-wallet guidance uses it", () => {
    const saved = process.env.CLAWROUTER_PAYMENT_CHAIN;
    process.env.CLAWROUTER_PAYMENT_CHAIN = "arc";
    try {
      const text = emptyWalletGuidance({
        paymentChain: "arc",
        address: EVM,
        solanaAddress: null,
      }).join("\n");
      expect(text).toContain("set CLAWROUTER_PAYMENT_CHAIN=base");
      expect(text).toContain(
        "unset CLAWROUTER_PAYMENT_CHAIN and npx @blockrun/clawrouter chain base",
      );
    } finally {
      if (saved === undefined) delete process.env.CLAWROUTER_PAYMENT_CHAIN;
      else process.env.CLAWROUTER_PAYMENT_CHAIN = saved;
    }
  });
});
