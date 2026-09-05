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
import { createPrivateKey, createPublicKey } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEMP_HOME = mkdtempSync(join(tmpdir(), "clawrouter-chain-default-"));
process.env.HOME = TEMP_HOME;
process.env.USERPROFILE = TEMP_HOME;
delete process.env.BLOCKRUN_WALLET_KEY;
delete process.env.SOLANA_WALLET_KEY;
delete process.env.CLAWROUTER_PAYMENT_CHAIN;

const {
  resolveExistingWalletKey,
  resolveOrGenerateWalletKey,
  loadPaymentChain,
  resolvePaymentChain,
  setupSolana,
  CHAIN_FILE,
} = await import("./auth.js");

const WALLET_DIR = join(TEMP_HOME, ".openclaw", "blockrun");
const CORE_DIR = join(TEMP_HOME, ".blockrun");
const TEST_KEY = "0x" + "ab".repeat(32);
const CORE_TEST_KEY = "0x" + "cd".repeat(32);
const TEST_MNEMONIC = "test test test test test test test test test test test junk";

function solanaSecret(fill: number): number[] {
  const seed = Buffer.alloc(32, fill);
  const privateDer = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const publicDer = createPublicKey(
    createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" }),
  ).export({ format: "der", type: "spki" });
  return [...seed, ...Buffer.from(publicDer).subarray(-32)];
}

beforeEach(() => {
  if (existsSync(WALLET_DIR)) rmSync(WALLET_DIR, { recursive: true });
  if (existsSync(CORE_DIR)) rmSync(CORE_DIR, { recursive: true });
});

afterEach(() => {
  delete process.env.BLOCKRUN_WALLET_KEY;
  delete process.env.SOLANA_WALLET_KEY;
  delete process.env.CLAWROUTER_PAYMENT_CHAIN;
});

afterAll(() => {
  rmSync(TEMP_HOME, { recursive: true, force: true });
});

describe("Solana is the fresh-install preference", () => {
  it("prefers solana when nothing is on disk at all", async () => {
    await expect(loadPaymentChain()).resolves.toBe("solana");
    await expect(resolvePaymentChain()).resolves.toBe("solana");
  });

  it("stays on base when a legacy wallet exists but no chain file does", async () => {
    // A pre-v0.12.246 install: its USDC is on Base and it never recorded a
    // choice. Flipping it to Solana would point every call at a gateway its
    // money is not on.
    mkdirSync(WALLET_DIR, { recursive: true });
    writeFileSync(join(WALLET_DIR, "wallet.key"), TEST_KEY + "\n");
    expect(existsSync(CHAIN_FILE)).toBe(false);
    await expect(loadPaymentChain()).resolves.toBe("base");
  });

  it("stays on base when a Core wallet exists but no chain file does", async () => {
    mkdirSync(CORE_DIR, { recursive: true });
    writeFileSync(join(CORE_DIR, ".session"), CORE_TEST_KEY + "\n");
    await expect(loadPaymentChain()).resolves.toBe("base");
  });

  it("stays on base for a BLOCKRUN_WALLET_KEY wallet with no chain file", async () => {
    process.env.BLOCKRUN_WALLET_KEY = TEST_KEY;
    await expect(loadPaymentChain()).resolves.toBe("base");
  });

  it("an explicit recorded choice always wins over the preference", async () => {
    mkdirSync(CORE_DIR, { recursive: true });
    writeFileSync(join(CORE_DIR, ".chain"), "base\n");
    await expect(loadPaymentChain()).resolves.toBe("base");
  });

  it("CLAWROUTER_PAYMENT_CHAIN still overrides everything", async () => {
    mkdirSync(WALLET_DIR, { recursive: true });
    writeFileSync(join(WALLET_DIR, "wallet.key"), TEST_KEY + "\n");
    process.env.CLAWROUTER_PAYMENT_CHAIN = "solana";
    await expect(resolvePaymentChain()).resolves.toBe("solana");
    process.env.CLAWROUTER_PAYMENT_CHAIN = "base";
    await expect(resolvePaymentChain()).resolves.toBe("base");
  });
});

describe("payment chain default for new installs", () => {
  it("does not create files when only checking for an existing wallet", async () => {
    await expect(resolveExistingWalletKey()).resolves.toBeUndefined();
    expect(existsSync(WALLET_DIR)).toBe(false);
    expect(existsSync(CORE_DIR)).toBe(false);
  });

  it("fresh wallet generation persists solana as the default chain", async () => {
    const result = await resolveOrGenerateWalletKey();

    expect(result.source).toBe("generated");
    expect(existsSync(CHAIN_FILE)).toBe(true);
    expect(readFileSync(CHAIN_FILE, "utf8").trim()).toBe("solana");
    await expect(loadPaymentChain()).resolves.toBe("solana");
  });

  it("copies an existing wallet.key into Core and leaves its chain on base", async () => {
    mkdirSync(WALLET_DIR, { recursive: true });
    writeFileSync(join(WALLET_DIR, "wallet.key"), TEST_KEY + "\n", { mode: 0o600 });

    const result = await resolveOrGenerateWalletKey();

    expect(result.source).toBe("core");
    expect(readFileSync(join(CORE_DIR, ".session"), "utf8").trim()).toBe(TEST_KEY);
    expect(existsSync(CHAIN_FILE)).toBe(false);
    await expect(loadPaymentChain()).resolves.toBe("base");
  });

  it("migrates legacy Solana and chain data while retaining the recovery files", async () => {
    mkdirSync(WALLET_DIR, { recursive: true });
    writeFileSync(join(WALLET_DIR, "wallet.key"), TEST_KEY + "\n", { mode: 0o600 });
    writeFileSync(join(WALLET_DIR, "mnemonic"), TEST_MNEMONIC + "\n", { mode: 0o600 });
    writeFileSync(CHAIN_FILE, "solana\n", { mode: 0o600 });

    const result = await resolveOrGenerateWalletKey();
    const coreSolana = JSON.parse(readFileSync(join(CORE_DIR, ".solana-session"), "utf8"));

    expect(result.source).toBe("core");
    expect(result.solanaPrivateKeyBytes).toHaveLength(32);
    expect(coreSolana).toHaveLength(64);
    expect(readFileSync(join(CORE_DIR, ".chain"), "utf8").trim()).toBe("solana");
    expect(readFileSync(join(WALLET_DIR, "mnemonic"), "utf8").trim()).toBe(TEST_MNEMONIC);
  });

  it("env-var wallet restore does not write a chain file", async () => {
    process.env.BLOCKRUN_WALLET_KEY = TEST_KEY;

    const result = await resolveOrGenerateWalletKey();

    expect(result.source).toBe("env");
    expect(existsSync(CHAIN_FILE)).toBe(false);
    await expect(loadPaymentChain()).resolves.toBe("base");
  });

  it("reuses the canonical BlockRun Core wallets before a legacy saved wallet", async () => {
    mkdirSync(WALLET_DIR, { recursive: true });
    mkdirSync(CORE_DIR, { recursive: true });
    writeFileSync(join(WALLET_DIR, "wallet.key"), TEST_KEY + "\n", { mode: 0o600 });
    writeFileSync(join(CORE_DIR, ".session"), CORE_TEST_KEY + "\n", { mode: 0o600 });
    writeFileSync(join(CORE_DIR, ".solana-session"), JSON.stringify(solanaSecret(7)), {
      mode: 0o600,
    });
    writeFileSync(join(CORE_DIR, ".chain"), "solana\n", { mode: 0o600 });

    const result = await resolveOrGenerateWalletKey();

    expect(result.source).toBe("core");
    expect(result.key).toBe(CORE_TEST_KEY);
    expect(result.solanaPrivateKeyBytes).toEqual(new Uint8Array(32).fill(7));
    await expect(loadPaymentChain()).resolves.toBe("solana");
  });

  it("refuses to replace an invalid Core wallet with a legacy wallet", async () => {
    mkdirSync(WALLET_DIR, { recursive: true });
    mkdirSync(CORE_DIR, { recursive: true });
    writeFileSync(join(WALLET_DIR, "wallet.key"), TEST_KEY + "\n", { mode: 0o600 });
    writeFileSync(join(CORE_DIR, ".session"), "invalid\n", { mode: 0o600 });

    await expect(resolveOrGenerateWalletKey()).rejects.toThrow("invalid format");
    expect(readFileSync(join(CORE_DIR, ".session"), "utf8").trim()).toBe("invalid");
  });

  it("keeps BLOCKRUN_WALLET_KEY as an explicit override of BlockRun Core", async () => {
    mkdirSync(CORE_DIR, { recursive: true });
    writeFileSync(join(CORE_DIR, ".session"), CORE_TEST_KEY + "\n", { mode: 0o600 });
    process.env.BLOCKRUN_WALLET_KEY = TEST_KEY;

    const result = await resolveOrGenerateWalletKey();

    expect(result.source).toBe("env");
    expect(result.key).toBe(TEST_KEY);
  });

  it("adds a Solana wallet to an existing Base-only Core wallet", async () => {
    mkdirSync(CORE_DIR, { recursive: true });
    writeFileSync(join(CORE_DIR, ".session"), CORE_TEST_KEY + "\n", { mode: 0o600 });

    const result = await setupSolana();

    expect(result.solanaPrivateKeyBytes).toHaveLength(32);
    expect(JSON.parse(readFileSync(join(CORE_DIR, ".solana-session"), "utf8"))).toHaveLength(64);
    expect(existsSync(join(WALLET_DIR, "mnemonic"))).toBe(true);
  });

  it("an explicit base selection is preserved for existing wallets", async () => {
    mkdirSync(WALLET_DIR, { recursive: true });
    writeFileSync(join(WALLET_DIR, "wallet.key"), TEST_KEY + "\n", { mode: 0o600 });
    writeFileSync(CHAIN_FILE, "base\n", { mode: 0o600 });

    const result = await resolveOrGenerateWalletKey();

    expect(result.source).toBe("core");
    expect(readFileSync(CHAIN_FILE, "utf8").trim()).toBe("base");
    await expect(loadPaymentChain()).resolves.toBe("base");
  });

  it("CLAWROUTER_PAYMENT_CHAIN=base still overrides the persisted solana default", async () => {
    await resolveOrGenerateWalletKey();
    await expect(loadPaymentChain()).resolves.toBe("solana");

    process.env.CLAWROUTER_PAYMENT_CHAIN = "base";
    await expect(resolvePaymentChain()).resolves.toBe("base");
  });

  it("accepts whitespace around a valid Solana environment key", async () => {
    process.env.BLOCKRUN_WALLET_KEY = TEST_KEY;
    process.env.SOLANA_WALLET_KEY = `  ${JSON.stringify(solanaSecret(9))}\n`;

    const result = await resolveOrGenerateWalletKey();

    expect(result.solanaPrivateKeyBytes).toEqual(new Uint8Array(32).fill(9));
  });

  it("treats a blank Solana environment override as absent", async () => {
    mkdirSync(CORE_DIR, { recursive: true });
    writeFileSync(join(CORE_DIR, ".session"), CORE_TEST_KEY + "\n", { mode: 0o600 });
    writeFileSync(join(CORE_DIR, ".solana-session"), JSON.stringify(solanaSecret(10)), {
      mode: 0o600,
    });
    process.env.SOLANA_WALLET_KEY = "   \n";
    process.env.CLAWROUTER_PAYMENT_CHAIN = "solana";

    const result = await resolveOrGenerateWalletKey();

    expect(result.solanaPrivateKeyBytes).toEqual(new Uint8Array(32).fill(10));
  });

  it("ignores malformed optional Solana state while Base is selected", async () => {
    process.env.BLOCKRUN_WALLET_KEY = TEST_KEY;
    process.env.SOLANA_WALLET_KEY = "not-a-solana-key";
    process.env.CLAWROUTER_PAYMENT_CHAIN = "base";

    const result = await resolveOrGenerateWalletKey();

    expect(result.key).toBe(TEST_KEY);
    expect(result.solanaPrivateKeyBytes).toBeUndefined();
  });

  it("rejects malformed Solana state while Solana is selected", async () => {
    process.env.BLOCKRUN_WALLET_KEY = TEST_KEY;
    process.env.SOLANA_WALLET_KEY = "not-a-solana-key";
    process.env.CLAWROUTER_PAYMENT_CHAIN = "solana";

    await expect(resolveOrGenerateWalletKey()).rejects.toThrow("invalid format");
  });

  it("preserves a Solana-only Core wallet when generating the missing Base wallet", async () => {
    mkdirSync(CORE_DIR, { recursive: true });
    writeFileSync(join(CORE_DIR, ".solana-session"), JSON.stringify(solanaSecret(11)), {
      mode: 0o600,
    });

    const result = await resolveOrGenerateWalletKey();

    expect(result.source).toBe("generated");
    expect(result.solanaPrivateKeyBytes).toEqual(new Uint8Array(32).fill(11));
    expect(result.mnemonic).toBeUndefined();
    expect(existsSync(join(WALLET_DIR, "mnemonic"))).toBe(false);
    expect(JSON.parse(readFileSync(join(CORE_DIR, ".solana-session"), "utf8"))).toEqual(
      solanaSecret(11),
    );
  });
});
