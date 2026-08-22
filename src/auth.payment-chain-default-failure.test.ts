/**
 * Guard: the solana default is only persisted when Solana address derivation
 * actually succeeds. getSolanaAddress dynamically imports @solana/kit, which
 * installers sometimes drop — a user must never be defaulted onto a chain the
 * proxy cannot sign for.
 *
 * Separate file from auth.payment-chain-default.test.ts because vi.mock is
 * per-module-registry (per test file).
 */

import { describe, it, expect, afterAll, vi } from "vitest";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEMP_HOME = mkdtempSync(join(tmpdir(), "clawrouter-chain-fail-"));
process.env.HOME = TEMP_HOME;
process.env.USERPROFILE = TEMP_HOME;
delete process.env.BLOCKRUN_WALLET_KEY;
delete process.env.CLAWROUTER_PAYMENT_CHAIN;

vi.mock("./wallet.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./wallet.js")>();
  return {
    ...actual,
    getSolanaAddress: vi.fn(async () => {
      throw new Error("simulated: @solana/kit unavailable");
    }),
  };
});

const { resolveOrGenerateWalletKey, loadPaymentChain, CHAIN_FILE } = await import("./auth.js");

afterAll(() => {
  rmSync(TEMP_HOME, { recursive: true, force: true });
});

describe("solana default requires successful Solana derivation", () => {
  it("generation still succeeds but no chain file is written when derivation fails", async () => {
    const result = await resolveOrGenerateWalletKey();

    expect(result.source).toBe("generated");
    expect(existsSync(CHAIN_FILE)).toBe(false);
    await expect(loadPaymentChain()).resolves.toBe("base");
  });
});
