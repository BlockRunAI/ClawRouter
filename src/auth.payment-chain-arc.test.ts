/**
 * Arc (Circle, eip155:5042) is a third selectable payment chain. It must be
 * selectable everywhere Base and Solana are — env var, persisted chain files —
 * without moving the fresh-install default off Solana.
 *
 * Temp HOME set BEFORE importing auth.js (paths are computed at module load).
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEMP_HOME = mkdtempSync(join(tmpdir(), "clawrouter-chain-arc-"));
process.env.HOME = TEMP_HOME;
process.env.USERPROFILE = TEMP_HOME;
delete process.env.BLOCKRUN_WALLET_KEY;
delete process.env.SOLANA_WALLET_KEY;
delete process.env.CLAWROUTER_PAYMENT_CHAIN;

const { loadPaymentChain, resolvePaymentChain, savePaymentChain, CHAIN_FILE, CORE_CHAIN_FILE } =
  await import("./auth.js");
const { isPaymentChain, isEvmPaymentChain, PAYMENT_CHAINS, PAYMENT_CHAIN_GATEWAYS } =
  await import("./payment-chain.js");

const WALLET_DIR = join(TEMP_HOME, ".openclaw", "blockrun");
const CORE_DIR = join(TEMP_HOME, ".blockrun");

beforeEach(() => {
  if (existsSync(WALLET_DIR)) rmSync(WALLET_DIR, { recursive: true });
  if (existsSync(CORE_DIR)) rmSync(CORE_DIR, { recursive: true });
});

afterEach(() => {
  delete process.env.CLAWROUTER_PAYMENT_CHAIN;
});

afterAll(() => {
  rmSync(TEMP_HOME, { recursive: true, force: true });
});

describe("payment-chain table", () => {
  it("lists all three chains and recognises only them", () => {
    expect([...PAYMENT_CHAINS].sort()).toEqual(["arc", "base", "solana"]);
    expect(isPaymentChain("arc")).toBe(true);
    expect(isPaymentChain("ARC")).toBe(false);
    expect(isPaymentChain("eip155:5042")).toBe(false);
    expect(isPaymentChain(undefined)).toBe(false);
  });

  it("treats Arc as an EVM chain paid from the Base key", () => {
    expect(isEvmPaymentChain("arc")).toBe(true);
    expect(isEvmPaymentChain("base")).toBe(true);
    expect(isEvmPaymentChain("solana")).toBe(false);
  });

  it("points Arc at arc.blockrun.ai", () => {
    expect(PAYMENT_CHAIN_GATEWAYS.arc).toBe("https://arc.blockrun.ai/api");
  });
});

describe("Arc selection persists and resolves", () => {
  it("fresh install still defaults to Solana", async () => {
    await expect(resolvePaymentChain()).resolves.toBe("solana");
  });

  it("savePaymentChain('arc') writes both chain files and loads back as arc", async () => {
    await savePaymentChain("arc");
    expect(readFileSync(CORE_CHAIN_FILE, "utf8").trim()).toBe("arc");
    expect(readFileSync(CHAIN_FILE, "utf8").trim()).toBe("arc");
    await expect(loadPaymentChain()).resolves.toBe("arc");
    await expect(resolvePaymentChain()).resolves.toBe("arc");
  });

  it("reads arc from the legacy ClawRouter chain file alone", async () => {
    mkdirSync(WALLET_DIR, { recursive: true });
    writeFileSync(join(WALLET_DIR, "payment-chain"), "arc\n");
    await expect(loadPaymentChain()).resolves.toBe("arc");
  });

  it("a Core chain file of arc wins over a legacy base", async () => {
    mkdirSync(WALLET_DIR, { recursive: true });
    mkdirSync(CORE_DIR, { recursive: true });
    writeFileSync(join(WALLET_DIR, "payment-chain"), "base\n");
    writeFileSync(join(CORE_DIR, ".chain"), "arc\n");
    await expect(loadPaymentChain()).resolves.toBe("arc");
  });

  it("CLAWROUTER_PAYMENT_CHAIN=arc overrides a persisted chain", async () => {
    await savePaymentChain("solana");
    process.env.CLAWROUTER_PAYMENT_CHAIN = "arc";
    await expect(resolvePaymentChain()).resolves.toBe("arc");
  });

  it("an unknown env value is ignored, not trusted", async () => {
    await savePaymentChain("base");
    process.env.CLAWROUTER_PAYMENT_CHAIN = "arbitrum";
    await expect(resolvePaymentChain()).resolves.toBe("base");
  });
});
