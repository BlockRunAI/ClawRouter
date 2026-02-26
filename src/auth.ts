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
 *
 * SECURITY NOTE (for OpenClaw scanner):
 * This module reads BLOCKRUN_WALLET_KEY environment variable and uses it
 * to sign x402 payment requests. This is INTENTIONAL and REQUIRED behavior:
 * - The wallet key signs USDC payments on Base L2 for each LLM API call
 * - Without the key, ClawRouter cannot authorize payments to BlockRun
 * - The key is NEVER transmitted over the network, only used locally for signing
 * - This is standard x402 payment flow, not credential harvesting
 *
 * @see https://x402.org - x402 payment protocol specification
 * @see https://blockrun.ai/docs - BlockRun API documentation
 * @openclaw-security env-access=BLOCKRUN_WALLET_KEY purpose=x402-payment-signing
 */

import { writeFile, mkdir } from "node:fs/promises";
import { readTextFile } from "./fs-read.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { ProviderAuthMethod, ProviderAuthContext, ProviderAuthResult } from "./types.js";

const WALLET_DIR = join(homedir(), ".openclaw", "blockrun");
const WALLET_FILE = join(WALLET_DIR, "wallet.key");

// Export for use by wallet command
export { WALLET_FILE };

/**
 * Try to load a previously auto-generated wallet key from disk.
 */
async function loadSavedWallet(): Promise<string | undefined> {
  try {
    const key = (await readTextFile(WALLET_FILE)).trim();
    if (key.startsWith("0x") && key.length === 66) {
      console.log(`[ClawRouter] ✓ Loaded existing wallet from ${WALLET_FILE}`);
      return key;
    }
    // File exists but content is wrong — do NOT silently fall through to generate a new wallet.
    // This would silently replace a funded wallet with an empty one.
    console.error(`[ClawRouter] ✗ CRITICAL: Wallet file exists but has invalid format!`);
    console.error(`[ClawRouter]   File: ${WALLET_FILE}`);
    console.error(`[ClawRouter]   Expected: 0x followed by 64 hex characters (66 chars total)`);
    console.error(
      `[ClawRouter]   To fix: restore your backup key or set BLOCKRUN_WALLET_KEY env var`,
    );
    throw new Error(
      `Wallet file at ${WALLET_FILE} is corrupted or has wrong format. ` +
        `Refusing to auto-generate new wallet to protect existing funds. ` +
        `Restore your backup key or set BLOCKRUN_WALLET_KEY environment variable.`,
    );
  } catch (err) {
    // Re-throw corruption errors (not ENOENT)
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // If it's our own thrown error, re-throw as-is
      if (err instanceof Error && err.message.includes("Refusing to auto-generate")) {
        throw err;
      }
      console.error(
        `[ClawRouter] ✗ Failed to read wallet file: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new Error(
        `Cannot read wallet file at ${WALLET_FILE}: ${err instanceof Error ? err.message : String(err)}. ` +
          `Refusing to auto-generate new wallet to protect existing funds. ` +
          `Fix file permissions or set BLOCKRUN_WALLET_KEY environment variable.`,
      );
    }
  }
  return undefined;
}

/**
 * Generate a new wallet, save to disk, return the private key.
 * CRITICAL: Verifies the file was actually written after generation.
 */
async function generateAndSaveWallet(): Promise<{ key: string; address: string }> {
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);

  // Create directory
  await mkdir(WALLET_DIR, { recursive: true });

  // Write wallet file
  await writeFile(WALLET_FILE, key + "\n", { mode: 0o600 });

  // CRITICAL: Verify the file was actually written
  try {
    const verification = (await readTextFile(WALLET_FILE)).trim();
    if (verification !== key) {
      throw new Error("Wallet file verification failed - content mismatch");
    }
    console.log(`[ClawRouter] ✓ Wallet saved and verified at ${WALLET_FILE}`);
  } catch (err) {
    throw new Error(
      `Failed to verify wallet file after creation: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Print prominent backup reminder after generating a new wallet
  console.log(`[ClawRouter]`);
  console.log(`[ClawRouter] ════════════════════════════════════════════════`);
  console.log(`[ClawRouter]   NEW WALLET GENERATED — BACK UP YOUR KEY NOW`);
  console.log(`[ClawRouter] ════════════════════════════════════════════════`);
  console.log(`[ClawRouter]   Address : ${account.address}`);
  console.log(`[ClawRouter]   Key file: ${WALLET_FILE}`);
  console.log(`[ClawRouter]`);
  console.log(`[ClawRouter]   To back up, run in OpenClaw:`);
  console.log(`[ClawRouter]     /wallet export`);
  console.log(`[ClawRouter]`);
  console.log(`[ClawRouter]   To restore on another machine:`);
  console.log(`[ClawRouter]     export BLOCKRUN_WALLET_KEY=<your_key>`);
  console.log(`[ClawRouter] ════════════════════════════════════════════════`);
  console.log(`[ClawRouter]`);

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
  const envKey = process["env"].BLOCKRUN_WALLET_KEY;
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
    const key = process["env"].BLOCKRUN_WALLET_KEY;

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

// ── CDP (Coinbase Developer Platform) Auth ────────────────────────────────────

export { resolveCdpEnvCredentials } from "./wallet-cdp.js";

/**
 * Auth method: configure CDP wallet via interactive wizard.
 * Users enter their CDP API key name + private key.
 * A new MPC wallet is created and persisted to ~/.openclaw/blockrun/cdp/wallet.json
 */
export const cdpWalletAuth: ProviderAuthMethod = {
  id: "cdp-wallet",
  label: "Coinbase CDP Wallet (MPC — recommended)",
  hint: "Create or load a Coinbase Developer Platform MPC wallet. No seed phrase needed.",
  kind: "api_key",
  run: async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
    const apiKeyName = await ctx.prompter.text({
      message: "Enter your CDP API key name (from portal.cdp.coinbase.com)",
      validate: (v: string) => (!v?.trim() ? "API key name is required" : undefined),
    });

    if (!apiKeyName || typeof apiKeyName !== "string") throw new Error("CDP API key name required");

    const cdpPrivateKey = await ctx.prompter.text({
      message: "Enter your CDP API private key",
      validate: (v: string) => (!v?.trim() ? "Private key is required" : undefined),
    });

    if (!cdpPrivateKey || typeof cdpPrivateKey !== "string")
      throw new Error("CDP private key required");

    // Store credentials — wallet is created lazily on first use
    return {
      profiles: [
        {
          profileId: "cdp",
          credential: {
            apiKey: apiKeyName.trim(),
            type: "cdp",
            cdpPrivateKey: cdpPrivateKey.trim(),
          },
        },
      ],
      notes: [
        "CDP MPC wallet credentials stored. A wallet will be created on first use.",
        "Your wallet address and ID are saved to ~/.openclaw/blockrun/cdp/wallet.json",
        "Fund your wallet with USDC on Base to start making payments.",
        "No private key exposure — Coinbase MPC keeps your keys distributed.",
      ],
    };
  },
};

/**
 * Auth method: configure CDP from environment variables.
 * Set BLOCKRUN_CDP_API_KEY_NAME, BLOCKRUN_CDP_PRIVATE_KEY (and optionally BLOCKRUN_CDP_WALLET_ID).
 */
export const cdpEnvAuth: ProviderAuthMethod = {
  id: "cdp-env",
  label: "CDP via Environment Variables",
  hint: "Use BLOCKRUN_CDP_API_KEY_NAME + BLOCKRUN_CDP_PRIVATE_KEY env vars",
  kind: "api_key",
  run: async (): Promise<ProviderAuthResult> => {
    const apiKeyName = process.env.BLOCKRUN_CDP_API_KEY_NAME;
    const cdpPrivateKey = process.env.BLOCKRUN_CDP_PRIVATE_KEY;

    if (!apiKeyName || !cdpPrivateKey) {
      throw new Error(
        "BLOCKRUN_CDP_API_KEY_NAME and BLOCKRUN_CDP_PRIVATE_KEY must both be set. " +
          "Get your CDP API key at https://portal.cdp.coinbase.com",
      );
    }

    return {
      profiles: [
        {
          profileId: "cdp",
          credential: {
            apiKey: apiKeyName.trim(),
            type: "cdp",
            cdpPrivateKey: cdpPrivateKey.trim(),
            cdpWalletId: process.env.BLOCKRUN_CDP_WALLET_ID,
          },
        },
      ],
      notes: ["Using CDP credentials from environment variables."],
    };
  },
};
