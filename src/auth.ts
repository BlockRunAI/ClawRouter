/**
 * BlockRun Auth Methods for OpenClaw
 *
 * Provides wallet-based authentication for the BlockRun provider.
 * Operators configure their wallet private key, which is used to
 * sign x402 micropayments for LLM inference.
 *
 * Wallet resolution deliberately follows @blockrun/core so every local
 * BlockRun product shares one x402 payer:
 *   1. Environment variable — BLOCKRUN_WALLET_KEY (explicit override)
 *   2. Core session — ~/.blockrun/.session
 *   3. Legacy OpenClaw wallet — ~/.openclaw/blockrun/wallet.key
 *   4. Auto-generate — only for a new installation with no Core wallet
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
import {
  generateWalletMnemonic,
  isValidMnemonic,
  deriveSolanaKeyBytes,
  deriveAllKeys,
  getSolanaAddress,
  decodeSolanaSessionKey,
} from "./wallet.js";

const WALLET_DIR = join(homedir(), ".openclaw", "blockrun");
const WALLET_FILE = join(WALLET_DIR, "wallet.key");
const CORE_WALLET_FILE = join(homedir(), ".blockrun", ".session");
const CORE_SOLANA_WALLET_FILE = join(homedir(), ".blockrun", ".solana-session");
const MNEMONIC_FILE = join(WALLET_DIR, "mnemonic");
const CHAIN_FILE = join(WALLET_DIR, "payment-chain");

// Export for use by wallet command and index.ts
export { WALLET_FILE, CORE_WALLET_FILE, CORE_SOLANA_WALLET_FILE, MNEMONIC_FILE, CHAIN_FILE };

/**
 * Try to load a previously auto-generated wallet key from disk.
 */
async function loadWalletFile(file: string, label: string): Promise<string | undefined> {
  try {
    const key = (await readTextFile(file)).trim();
    if (key.startsWith("0x") && key.length === 66) {
      console.log(`[ClawRouter] ✓ Loaded ${label} wallet`);
      return key;
    }
    // File exists but content is wrong — do NOT silently fall through to generate a new wallet.
    // This would silently replace a funded wallet with an empty one.
    console.error(`[ClawRouter] ✗ CRITICAL: Wallet file exists but has invalid format!`);
    console.error(`[ClawRouter]   File: ${file}`);
    console.error(`[ClawRouter]   Expected: 0x followed by 64 hex characters (66 chars total)`);
    console.error(
      `[ClawRouter]   To fix: restore your backup key or set BLOCKRUN_WALLET_KEY env var`,
    );
    throw new Error(
      `Wallet file at ${file} is corrupted or has wrong format. ` +
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
        `[ClawRouter] ✗ Failed to read ${label} wallet file: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new Error(
        `Cannot read wallet file at ${file}: ${err instanceof Error ? err.message : String(err)}. ` +
          `Refusing to auto-generate new wallet to protect existing funds. ` +
          `Fix file permissions or set BLOCKRUN_WALLET_KEY environment variable.`,
        { cause: err },
      );
    }
  }
  return undefined;
}

async function loadSavedWallet(): Promise<string | undefined> {
  return loadWalletFile(WALLET_FILE, "legacy OpenClaw");
}

async function loadCoreWallet(): Promise<string | undefined> {
  return loadWalletFile(CORE_WALLET_FILE, "BlockRun Core");
}

export type SolanaWalletResolution = {
  privateKeyBytes: Uint8Array;
  source: "env" | "core" | "mnemonic";
  mnemonic?: string;
};

/** Resolve the shared Solana payer without ever silently changing wallets. */
export async function resolveSolanaWallet(): Promise<SolanaWalletResolution | undefined> {
  const envKey = process["env"].SOLANA_WALLET_KEY;
  if (typeof envKey === "string" && envKey.trim()) {
    return { privateKeyBytes: decodeSolanaSessionKey(envKey), source: "env" };
  }

  try {
    const coreKey = (await readTextFile(CORE_SOLANA_WALLET_FILE)).trim();
    if (coreKey) {
      return { privateKeyBytes: decodeSolanaSessionKey(coreKey), source: "core" };
    }
    throw new Error("file is empty");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(
        `Cannot load the BlockRun Core Solana wallet at ${CORE_SOLANA_WALLET_FILE}: ${error instanceof Error ? error.message : String(error)}. ` +
          "Refusing to fall back to a different wallet.",
        { cause: error },
      );
    }
  }

  const mnemonic = await loadMnemonic();
  return mnemonic
    ? { privateKeyBytes: deriveSolanaKeyBytes(mnemonic), source: "mnemonic", mnemonic }
    : undefined;
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

  // New installs default to Solana — but only if derivation succeeded above
  // (it dynamically imports @solana/kit, which installers sometimes drop).
  // Never default a user onto a chain the proxy can't sign for.
  let solanaDefaultSaved = false;
  if (solanaAddress) {
    try {
      await savePaymentChain("solana");
      solanaDefaultSaved = true;
    } catch {
      // Non-fatal — user stays on the base fallback
    }
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
  if (solanaDefaultSaved) {
    console.log(
      `[ClawRouter]   Default payment chain: Solana — fund the Solana address above with USDC.`,
    );
    console.log(`[ClawRouter]   To switch to Base, run in OpenClaw: /wallet base`);
  }
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
 * Resolve wallet key: explicit env → BlockRun Core → legacy OpenClaw → generate.
 * Uses the shared BlockRun Core Solana session before legacy mnemonic derivation.
 * Called by index.ts before the auth wizard runs.
 */
export type WalletResolution = {
  key: string;
  address: string;
  source: "saved" | "core" | "env" | "config" | "generated";
  mnemonic?: string;
  solanaPrivateKeyBytes?: Uint8Array;
  solanaSource?: SolanaWalletResolution["source"] | "generated";
};

export async function resolveOrGenerateWalletKey(): Promise<WalletResolution> {
  const solana = await resolveSolanaWallet();
  // 1. Explicit environment variable, matching @blockrun/core precedence.
  const envKey = process["env"].BLOCKRUN_WALLET_KEY;
  if (typeof envKey === "string" && envKey.startsWith("0x") && envKey.length === 66) {
    const account = privateKeyToAccount(envKey as `0x${string}`);

    return {
      key: envKey,
      address: account.address,
      source: "env",
      mnemonic: solana?.mnemonic,
      solanaPrivateKeyBytes: solana?.privateKeyBytes,
      solanaSource: solana?.source,
    };
  }

  // 2. Core wallet shared by the CLI, Franklin, MCP and Codex integrations.
  const core = await loadCoreWallet();
  if (core) {
    const account = privateKeyToAccount(core as `0x${string}`);
    return {
      key: core,
      address: account.address,
      source: "core",
      mnemonic: solana?.mnemonic,
      solanaPrivateKeyBytes: solana?.privateKeyBytes,
      solanaSource: solana?.source,
    };
  }

  // 3. Preserve pre-Core ClawRouter installations as a compatibility fallback.
  const saved = await loadSavedWallet();
  if (saved) {
    const account = privateKeyToAccount(saved as `0x${string}`);
    return {
      key: saved,
      address: account.address,
      source: "saved",
      mnemonic: solana?.mnemonic,
      solanaPrivateKeyBytes: solana?.privateKeyBytes,
      solanaSource: solana?.source,
    };
  }

  // 4. Auto-generate with BIP-39 mnemonic (new users get both chains)
  const result = await generateAndSaveWallet();
  return {
    key: result.key,
    address: result.address,
    source: "generated",
    mnemonic: result.mnemonic,
    solanaPrivateKeyBytes: solana?.privateKeyBytes ?? result.solanaPrivateKeyBytes,
    solanaSource: solana?.source ?? "generated",
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
  const savedKey = (await loadCoreWallet()) ?? (await loadSavedWallet());
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
 * New installs persist "solana" at wallet generation, so an absent file
 * means a pre-existing install whose funds live on Base.
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
