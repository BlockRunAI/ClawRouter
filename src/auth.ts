/**
 * BlockRun Auth Methods for OpenClaw
 *
 * Provides wallet-based authentication for the BlockRun provider.
 * Operators configure their wallet private key, which is used to
 * sign x402 micropayments for LLM inference.
 *
 * Three methods:
 *   1. Auto-generate — create a new wallet on first run, save to ~/.openclaw/blockrun/wallet.key
 *   2. Environment variable — read from BLOCKRUN_WALLET_KEY
 *   3. Manual input — operator enters private key via wizard
 */

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { ProviderAuthMethod, ProviderAuthContext, ProviderAuthResult } from "./types.js";

const WALLET_DIR = join(homedir(), ".openclaw", "blockrun");
const WALLET_FILE = join(WALLET_DIR, "wallet.key");

/**
 * Try to load a previously auto-generated wallet key from disk.
 */
async function loadSavedWallet(): Promise<string | undefined> {
  try {
    const key = (await readFile(WALLET_FILE, "utf-8")).trim();
    if (key.startsWith("0x") && key.length === 66) return key;
  } catch {
    // File doesn't exist yet
  }
  return undefined;
}

/**
 * Generate a new wallet, save to disk, return the private key.
 */
async function generateAndSaveWallet(): Promise<{ key: string; address: string }> {
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  await mkdir(WALLET_DIR, { recursive: true });
  await writeFile(WALLET_FILE, key + "\n", { mode: 0o600 });
  return { key, address: account.address };
}

/**
 * Resolve wallet key: load saved → env var → auto-generate.
 * Called by index.ts before the auth wizard runs.
 */
export async function resolveOrGenerateWalletKey(): Promise<{
  key: string;
  address: string;
  source: "saved" | "env" | "generated";
}> {
  // 1. Previously saved wallet
  const saved = await loadSavedWallet();
  if (saved) {
    const account = privateKeyToAccount(saved as `0x${string}`);
    return { key: saved, address: account.address, source: "saved" };
  }

  // 2. Environment variable
  const envKey = process.env.BLOCKRUN_WALLET_KEY;
  if (typeof envKey === "string" && envKey.startsWith("0x") && envKey.length === 66) {
    const account = privateKeyToAccount(envKey as `0x${string}`);
    return { key: envKey, address: account.address, source: "env" };
  }

  // 3. Auto-generate
  const { key, address } = await generateAndSaveWallet();
  return { key, address, source: "generated" };
}

/**
 * Auth method: operator enters their wallet private key directly.
 */
export const walletKeyAuth: ProviderAuthMethod = {
  id: "wallet-key",
  label: "Wallet Private Key",
  hint: "Enter your EVM wallet private key (0x...) for x402 payments to BlockRun",
  kind: "api_key",
  run: async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
    const key = await ctx.prompter.text({
      message: "Enter your wallet private key (0x...)",
      validate: (value: string) => {
        const trimmed = value.trim();
        if (!trimmed.startsWith("0x")) return "Key must start with 0x";
        if (trimmed.length !== 66) return "Key must be 66 characters (0x + 64 hex)";
        if (!/^0x[0-9a-fA-F]{64}$/.test(trimmed)) return "Key must be valid hex";
        return undefined;
      },
    });

    if (!key || typeof key !== "string") {
      throw new Error("Wallet key is required");
    }

    return {
      profiles: [
        {
          profileId: "default",
          credential: { apiKey: key.trim() },
        },
      ],
      notes: [
        "Wallet key stored securely in OpenClaw credentials.",
        "Your wallet signs x402 USDC payments on Base for each LLM call.",
        "Fund your wallet with USDC on Base to start using BlockRun models.",
      ],
    };
  },
};

/**
 * Auth method: read wallet key from BLOCKRUN_WALLET_KEY environment variable.
 */
export const envKeyAuth: ProviderAuthMethod = {
  id: "env-key",
  label: "Environment Variable",
  hint: "Use BLOCKRUN_WALLET_KEY environment variable",
  kind: "api_key",
  run: async (): Promise<ProviderAuthResult> => {
    const key = process.env.BLOCKRUN_WALLET_KEY;

    if (!key) {
      throw new Error(
        "BLOCKRUN_WALLET_KEY environment variable is not set. " +
          "Set it to your EVM wallet private key (0x...).",
      );
    }

    return {
      profiles: [
        {
          profileId: "default",
          credential: { apiKey: key.trim() },
        },
      ],
      notes: ["Using wallet key from BLOCKRUN_WALLET_KEY environment variable."],
    };
  },
};
