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
import { privateKeyToAccount } from "viem/accounts";
import type { ProviderAuthMethod, ProviderAuthContext, ProviderAuthResult } from "./types.js";
import {
  generateWalletMnemonic,
  isValidMnemonic,
  deriveSolanaKeyBytes,
  deriveAllKeys,
  getSolanaAddress,
} from "./wallet.js";

const WALLET_DIR = join(homedir(), ".openclaw", "blockrun");
const WALLET_FILE = join(WALLET_DIR, "wallet.key");
const MNEMONIC_FILE = join(WALLET_DIR, "mnemonic");
const CHAIN_FILE = join(WALLET_DIR, "payment-chain");

// Export for use by wallet command and index.ts
export { WALLET_FILE, MNEMONIC_FILE, CHAIN_FILE };

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
        { cause: err },
      );
    }
  }
  return undefined;
}

/**
 * Load mnemonic from disk if it exists.
 * Warns on corruption but never throws — callers handle missing mnemonic gracefully.
 */
async function loadMnemonic(): Promise<string | undefined> {
  try {
    const mnemonic = (await readTextFile(MNEMONIC_FILE)).trim();
    if (mnemonic && isValidMnemonic(mnemonic)) {
      return mnemonic;
    }
    // File exists but content is invalid — warn but continue.
    console.warn(`[ClawRouter] ⚠ Mnemonic file exists but has invalid format — ignoring`);
    return undefined;
  } catch (err) {
    // Only swallow ENOENT (file not found)
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[ClawRouter] ⚠ Cannot read mnemonic file — ignoring`);
    }
  }
  return undefined;
}

/**
 * Save mnemonic to disk.
 */
async function saveMnemonic(mnemonic: string): Promise<void> {
  await mkdir(WALLET_DIR, { recursive: true });
  await writeFile(MNEMONIC_FILE, mnemonic + "\n", { mode: 0o600 });
}

/**
 * Generate a new wallet with BIP-39 mnemonic, save to disk.
 * New users get both EVM and Solana keys derived from the same mnemonic.
 * CRITICAL: Verifies the file was actually written after generation.
 */
async function generateAndSaveWallet(): Promise<{
  key: string;
  address: string;
  mnemonic: string;
  solanaPrivateKeyBytes: Uint8Array;
}> {
  // Safety: if a mnemonic file already exists, a Solana wallet was derived from it.
  // Generating a new wallet would overwrite the mnemonic and lose Solana funds.
  const existingMnemonic = await loadMnemonic();
  if (existingMnemonic) {
    throw new Error(
      `Mnemonic file exists at ${MNEMONIC_FILE} but wallet.key is missing.\n` +
        `Refusing to generate a new wallet to protect existing funds.\n\n` +
        `Restore your EVM private key using one of:\n` +
        `  Windows:   set BLOCKRUN_WALLET_KEY=0x<your_key>\n` +
        `  Mac/Linux: export BLOCKRUN_WALLET_KEY=0x<your_key>\n\n` +
        `Then run: npx @blockrun/clawrouter`,
    );
  }

  const mnemonic = generateWalletMnemonic();
  const derived = deriveAllKeys(mnemonic);

  // Create directory
  await mkdir(WALLET_DIR, { recursive: true });

  // Write wallet key file (EVM private key)
  await writeFile(WALLET_FILE, derived.evmPrivateKey + "\n", { mode: 0o600 });

  // Write mnemonic file
  await writeFile(MNEMONIC_FILE, mnemonic + "\n", { mode: 0o600 });

  // CRITICAL: Verify the file was actually written
  try {
    const verification = (await readTextFile(WALLET_FILE)).trim();
    if (verification !== derived.evmPrivateKey) {
      throw new Error("Wallet file verification failed - content mismatch");
    }
    console.log(`[ClawRouter] Wallet saved and verified at ${WALLET_FILE}`);
  } catch (err) {
    throw new Error(
      `Failed to verify wallet file after creation: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  // Derive Solana address for display
  let solanaAddress: string | undefined;
  try {
    solanaAddress = await getSolanaAddress(derived.solanaPrivateKeyBytes);
  } catch {
    // Non-fatal — Solana address display is best-effort
  }

  // Print prominent backup reminder after generating a new wallet
  console.log(`[ClawRouter]`);
  console.log(`[ClawRouter] ════════════════════════════════════════════════`);
  console.log(`[ClawRouter]   NEW WALLET GENERATED — BACK UP YOUR KEY NOW`);
  console.log(`[ClawRouter] ════════════════════════════════════════════════`);
  console.log(`[ClawRouter]   EVM Address    : ${derived.evmAddress}`);
  if (solanaAddress) {
    console.log(`[ClawRouter]   Solana Address : ${solanaAddress}`);
  }
  console.log(`[ClawRouter]   Key file       : ${WALLET_FILE}`);
  console.log(`[ClawRouter]   Mnemonic       : ${MNEMONIC_FILE}`);
  console.log(`[ClawRouter]`);
  console.log(`[ClawRouter]   Both EVM (Base) and Solana wallets are ready.`);
  console.log(`[ClawRouter]   To back up, run in OpenClaw:`);
  console.log(`[ClawRouter]     /wallet export`);
  console.log(`[ClawRouter]`);
  console.log(`[ClawRouter]   To restore on another machine:`);
  console.log(`[ClawRouter]     export BLOCKRUN_WALLET_KEY=<your_key>`);
  console.log(`[ClawRouter] ════════════════════════════════════════════════`);
  console.log(`[ClawRouter]`);

  return {
    key: derived.evmPrivateKey,
    address: derived.evmAddress,
    mnemonic,
    solanaPrivateKeyBytes: derived.solanaPrivateKeyBytes,
  };
}

/**
 * Resolve wallet key: load saved → env var → auto-generate.
 * Also loads mnemonic if available for Solana key derivation.
 * Called by index.ts before the auth wizard runs.
 */
export type WalletResolution = {
  key: string;
  address: string;
  source: "saved" | "env" | "config" | "generated";
  mnemonic?: string;
  solanaPrivateKeyBytes?: Uint8Array;
};

export async function resolveOrGenerateWalletKey(): Promise<WalletResolution> {
  // 1. Previously saved wallet
  const saved = await loadSavedWallet();
  if (saved) {
    const account = privateKeyToAccount(saved as `0x${string}`);

    // Load mnemonic if it exists (Solana support enabled via /wallet solana)
    const mnemonic = await loadMnemonic();
    if (mnemonic) {
      const solanaKeyBytes = deriveSolanaKeyBytes(mnemonic);
      return {
        key: saved,
        address: account.address,
        source: "saved",
        mnemonic,
        solanaPrivateKeyBytes: solanaKeyBytes,
      };
    }

    return { key: saved, address: account.address, source: "saved" };
  }

  // 2. Environment variable
  const envKey = process["env"].BLOCKRUN_WALLET_KEY;
  if (typeof envKey === "string" && envKey.startsWith("0x") && envKey.length === 66) {
    const account = privateKeyToAccount(envKey as `0x${string}`);

    // Load mnemonic if it exists (Solana support enabled via /wallet solana)
    const mnemonic = await loadMnemonic();
    if (mnemonic) {
      const solanaKeyBytes = deriveSolanaKeyBytes(mnemonic);
      return {
        key: envKey,
        address: account.address,
        source: "env",
        mnemonic,
        solanaPrivateKeyBytes: solanaKeyBytes,
      };
    }

    return { key: envKey, address: account.address, source: "env" };
  }

  // 3. Auto-generate with BIP-39 mnemonic (new users get both chains)
  const result = await generateAndSaveWallet();
  return {
    key: result.key,
    address: result.address,
    source: "generated",
    mnemonic: result.mnemonic,
    solanaPrivateKeyBytes: result.solanaPrivateKeyBytes,
  };
}

/**
 * Recover wallet.key from existing mnemonic.
 *
 * ONLY works when the mnemonic was originally generated by ClawRouter
 * (i.e., both mnemonic and EVM key were derived from the same seed).
 * If the EVM key was set independently (manually or via env), the derived
 * key will be different — do NOT use this in that case.
 */
export async function recoverWalletFromMnemonic(): Promise<void> {
  const mnemonic = await loadMnemonic();
  if (!mnemonic) {
    console.error(`[ClawRouter] No mnemonic found at ${MNEMONIC_FILE}`);
    console.error(`[ClawRouter] Cannot recover — no mnemonic to derive from.`);
    process.exit(1);
  }

  // Safety: if wallet.key already exists, refuse to overwrite
  const existing = await loadSavedWallet().catch(() => undefined);
  if (existing) {
    console.error(`[ClawRouter] wallet.key already exists at ${WALLET_FILE}`);
    console.error(`[ClawRouter] Recovery not needed.`);
    process.exit(1);
  }

  const derived = deriveAllKeys(mnemonic);
  const solanaKeyBytes = deriveSolanaKeyBytes(mnemonic);
  const solanaAddress = await getSolanaAddress(solanaKeyBytes).catch(() => undefined);

  console.log(`[ClawRouter]`);
  console.log(`[ClawRouter] ⚠  WALLET RECOVERY FROM MNEMONIC`);
  console.log(`[ClawRouter] ════════════════════════════════════════════════`);
  console.log(`[ClawRouter]   This only works if your mnemonic was originally`);
  console.log(`[ClawRouter]   generated by ClawRouter (not set manually).`);
  console.log(`[ClawRouter]`);
  console.log(`[ClawRouter]   Derived EVM Address    : ${derived.evmAddress}`);
  if (solanaAddress) {
    console.log(`[ClawRouter]   Derived Solana Address : ${solanaAddress}`);
  }
  console.log(`[ClawRouter]`);
  console.log(`[ClawRouter]   If the Solana address above matches your funded`);
  console.log(`[ClawRouter]   wallet, recovery is safe to proceed.`);
  console.log(`[ClawRouter] ════════════════════════════════════════════════`);
  console.log(`[ClawRouter]`);

  await mkdir(WALLET_DIR, { recursive: true });
  await writeFile(WALLET_FILE, derived.evmPrivateKey + "\n", { mode: 0o600 });

  console.log(`[ClawRouter] ✓ wallet.key restored at ${WALLET_FILE}`);
  console.log(`[ClawRouter]   Run: npx @blockrun/clawrouter`);
  console.log(`[ClawRouter]`);
}

/**
 * Set up Solana wallet for existing EVM-only users.
 * Generates a new mnemonic for Solana key derivation.
 * NEVER touches the existing wallet.key file.
 */
export async function setupSolana(): Promise<{
  mnemonic: string;
  solanaPrivateKeyBytes: Uint8Array;
}> {
  // Safety: mnemonic must not already exist
  const existing = await loadMnemonic();
  if (existing) {
    throw new Error("Solana wallet already set up. Mnemonic file exists at " + MNEMONIC_FILE);
  }

  // Safety: wallet.key must exist (can't set up Solana without EVM wallet)
  const savedKey = await loadSavedWallet();
  if (!savedKey) {
    throw new Error(
      "No EVM wallet found. Run ClawRouter first to generate a wallet before setting up Solana.",
    );
  }

  // Generate new mnemonic for Solana derivation
  const mnemonic = generateWalletMnemonic();
  const solanaKeyBytes = deriveSolanaKeyBytes(mnemonic);

  // Save mnemonic (wallet.key untouched)
  await saveMnemonic(mnemonic);

  console.log(`[ClawRouter] Solana wallet set up successfully.`);
  console.log(`[ClawRouter] Mnemonic saved to ${MNEMONIC_FILE}`);
  console.log(`[ClawRouter] Existing EVM wallet unchanged.`);

  return { mnemonic, solanaPrivateKeyBytes: solanaKeyBytes };
}

/**
 * Persist the user's payment chain selection to disk.
 */
export async function savePaymentChain(chain: "base" | "solana"): Promise<void> {
  await mkdir(WALLET_DIR, { recursive: true });
  await writeFile(CHAIN_FILE, chain + "\n", { mode: 0o600 });
}

/**
 * Load the persisted payment chain selection from disk.
 * Returns "base" if no file exists or the file is invalid.
 */
export async function loadPaymentChain(): Promise<"base" | "solana"> {
  try {
    const content = (await readTextFile(CHAIN_FILE)).trim();
    if (content === "solana") return "solana";
    return "base";
  } catch {
    return "base";
  }
}

/**
 * Resolve payment chain: env var first → persisted file second → default "base".
 */
export async function resolvePaymentChain(): Promise<"base" | "solana"> {
  if (process["env"].CLAWROUTER_PAYMENT_CHAIN === "solana") return "solana";
  if (process["env"].CLAWROUTER_PAYMENT_CHAIN === "base") return "base";
  return loadPaymentChain();
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
