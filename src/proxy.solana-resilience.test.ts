/**
 * Regression test: proxy must start on Base chain even when @solana/kit is unavailable.
 *
 * Root cause: solana-balance.ts statically imports @solana/kit. If proxy.ts
 * statically imports solana-balance.ts, a missing @solana/kit breaks the ENTIRE
 * proxy at startup — even for users on Base (EVM) chain.
 *
 * Fix: proxy.ts must only import solana-balance.ts dynamically, inside the
 * `paymentChain === "solana"` branch.
 */

import { vi, describe, it, expect, afterEach } from "vitest";

// Simulate @solana/kit being unavailable: make solana-balance.js throw on load.
// Before fix: proxy.ts has a static import of solana-balance.js → this factory
//   throws when proxy.ts is evaluated → startProxy can't be imported → test fails.
// After fix: proxy.ts uses `import type` + dynamic import for Solana only →
//   proxy.ts loads fine → test passes.
vi.mock("./solana-balance.js", () => {
  throw new Error("Cannot find module '@solana/kit' (simulated missing dep)");
});

describe("proxy resilience - missing @solana/kit", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("starts Base chain proxy even when @solana/kit is unavailable", async () => {
    const { startProxy } = await import("./proxy.js");
    const { generatePrivateKey } = await import("viem/accounts");

    const walletKey = generatePrivateKey();
    const port = 23500 + Math.floor(Math.random() * 500);

    const proxy = await startProxy({
      wallet: walletKey,
      paymentChain: "base",
      port,
      skipBalanceCheck: true,
    });

    expect(proxy.port).toBe(port);
    await proxy.close();
  });
});
