/**
 * New installs default to the Solana payment chain.
 *
 * Only brand-new wallet generation persists payment-chain=solana.
 * Every other path (saved wallet, env-var restore, explicit base choice)
 * must leave the chain file alone so existing users stay on Base.
 *
 * Uses a temp HOME set BEFORE importing auth.js — WALLET_DIR is computed
 * from homedir() at module load (same pattern as test/smoke-wallet-scenarios.ts).
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEMP_HOME = mkdtempSync(join(tmpdir(), "clawrouter-chain-default-"));
process.env.HOME = TEMP_HOME;
process.env.USERPROFILE = TEMP_HOME;
delete process.env.BLOCKRUN_WALLET_KEY;
delete process.env.CLAWROUTER_PAYMENT_CHAIN;

const { resolveOrGenerateWalletKey, loadPaymentChain, resolvePaymentChain, CHAIN_FILE } =
  await import("./auth.js");

const WALLET_DIR = join(TEMP_HOME, ".openclaw", "blockrun");
const TEST_KEY = "0x" + "ab".repeat(32);

beforeEach(() => {
  if (existsSync(WALLET_DIR)) rmSync(WALLET_DIR, { recursive: true });
});

afterEach(() => {
  delete process.env.BLOCKRUN_WALLET_KEY;
  delete process.env.CLAWROUTER_PAYMENT_CHAIN;
});

afterAll(() => {
  rmSync(TEMP_HOME, { recursive: true, force: true });
});

describe("payment chain default for new installs", () => {
  it("fresh wallet generation persists solana as the default chain", async () => {
    const result = await resolveOrGenerateWalletKey();

    expect(result.source).toBe("generated");
    expect(existsSync(CHAIN_FILE)).toBe(true);
    expect(readFileSync(CHAIN_FILE, "utf8").trim()).toBe("solana");
    await expect(loadPaymentChain()).resolves.toBe("solana");
  });

  it("existing wallet.key is left on base — no chain file is created", async () => {
    mkdirSync(WALLET_DIR, { recursive: true });
    writeFileSync(join(WALLET_DIR, "wallet.key"), TEST_KEY + "\n", { mode: 0o600 });

    const result = await resolveOrGenerateWalletKey();

    expect(result.source).toBe("saved");
    expect(existsSync(CHAIN_FILE)).toBe(false);
    await expect(loadPaymentChain()).resolves.toBe("base");
  });

  it("env-var wallet restore does not write a chain file", async () => {
    process.env.BLOCKRUN_WALLET_KEY = TEST_KEY;

    const result = await resolveOrGenerateWalletKey();

    expect(result.source).toBe("env");
    expect(existsSync(CHAIN_FILE)).toBe(false);
    await expect(loadPaymentChain()).resolves.toBe("base");
  });

  it("an explicit base selection is preserved for existing wallets", async () => {
    mkdirSync(WALLET_DIR, { recursive: true });
    writeFileSync(join(WALLET_DIR, "wallet.key"), TEST_KEY + "\n", { mode: 0o600 });
    writeFileSync(CHAIN_FILE, "base\n", { mode: 0o600 });

    const result = await resolveOrGenerateWalletKey();

    expect(result.source).toBe("saved");
    expect(readFileSync(CHAIN_FILE, "utf8").trim()).toBe("base");
    await expect(loadPaymentChain()).resolves.toBe("base");
  });

  it("CLAWROUTER_PAYMENT_CHAIN=base still overrides the persisted solana default", async () => {
    await resolveOrGenerateWalletKey();
    await expect(loadPaymentChain()).resolves.toBe("solana");

    process.env.CLAWROUTER_PAYMENT_CHAIN = "base";
    await expect(resolvePaymentChain()).resolves.toBe("base");
  });
});
