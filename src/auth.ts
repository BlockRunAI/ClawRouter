/**
 * XClawRouter wallet resolution.
 *
 * Wallet identity is resolved in this order:
 *   1. OKX onchainos CLI (if installed AND user is logged in) — preferred.
 *      Private keys never enter this process; signing happens via
 *      `onchainos payment x402-pay`. See onchainos-adapter.ts.
 *   2. Saved wallet.key file (legacy BIP-39 path)
 *   3. BLOCKRUN_WALLET_KEY env var (legacy)
 *   4. Auto-generated BIP-39 wallet (legacy fallback when no OKX wallet)
 *
 * The legacy BIP-39 path remains so users without onchainos still work, but
 * fresh installs that have onchainos installed and signed in will use the
 * OKX wallet identity instead of generating a new local key.
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
import { OnchainOsAdapter } from "./onchainos-adapter.js";

// ---------------------------------------------------------------------------
// OKX onchainos detection
// ---------------------------------------------------------------------------

/**
 * Detect an OKX onchainos wallet. Returns the EVM address if onchainos is
 * installed AND the user is logged in. Returns undefined otherwise so callers
 * fall back to the legacy local-key path.
 */
export async function detectOnchainosWallet(): Promise<
  | {
      address: `0x${string}`;
      email?: string;
      adapter: OnchainOsAdapter;
    }
  | undefined
> {
  const adapter = new OnchainOsAdapter();
  if (!adapter.isInstalled()) return undefined;
  try {
    const status = await adapter.status();
    if (!status.loggedIn || !status.evmAddress) return undefined;
    return { address: status.evmAddress, email: status.email, adapter };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Payment chain persistence (used by both paths)
// ---------------------------------------------------------------------------

const WALLET_DIR = join(homedir(), ".openclaw", "blockrun");
const WALLET_FILE = join(WALLET_DIR, "wallet.key");
const MNEMONIC_FILE = join(WALLET_DIR, "mnemonic");
const CHAIN_FILE = join(WALLET_DIR, "payment-chain");

export { WALLET_DIR, WALLET_FILE, MNEMONIC_FILE, CHAIN_FILE };

export async function savePaymentChain(chain: "base" | "solana"): Promise<void> {
  await mkdir(WALLET_DIR, { recursive: true });
  await writeFile(CHAIN_FILE, chain + "\n", { mode: 0o600 });
}

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
 * Resolve payment chain: env var → persisted file → default "base".
 * Accepts both XCLAWROUTER_PAYMENT_CHAIN (preferred) and CLAWROUTER_PAYMENT_CHAIN
 * (legacy, deprecated — will be removed after one release).
 */
export async function resolvePaymentChain(): Promise<"base" | "solana"> {
  const env = process.env.XCLAWROUTER_PAYMENT_CHAIN ?? process.env.CLAWROUTER_PAYMENT_CHAIN;
  if (env === "solana") return "solana";
  if (env === "base") return "base";
  return loadPaymentChain();
}

// ---------------------------------------------------------------------------
// Local-key path (used when onchainos is unavailable)
// ---------------------------------------------------------------------------

async function loadSavedWallet(): Promise<string | undefined> {
  try {
    const key = (await readTextFile(WALLET_FILE)).trim();
    if (key.startsWith("0x") && key.length === 66) {
      console.log(`[XClawRouter] ✓ Loaded existing wallet from ${WALLET_FILE}`);
      return key;
    }
    console.error(`[XClawRouter] ✗ CRITICAL: Wallet file exists but has invalid format!`);
    console.error(`[XClawRouter]   File: ${WALLET_FILE}`);
    console.error(`[XClawRouter]   Expected: 0x followed by 64 hex characters (66 chars total)`);
    throw new Error(
      `Wallet file at ${WALLET_FILE} is corrupted or has wrong format. ` +
        `Refusing to auto-generate new wallet to protect existing funds. ` +
        `Restore your backup key or set BLOCKRUN_WALLET_KEY environment variable.`,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      if (err instanceof Error && err.message.includes("Refusing to auto-generate")) {
        throw err;
      }
      throw new Error(
        `Cannot read wallet file at ${WALLET_FILE}: ${err instanceof Error ? err.message : String(err)}.`,
        { cause: err },
      );
    }
  }
  return undefined;
}

async function loadMnemonic(): Promise<string | undefined> {
  try {
    const mnemonic = (await readTextFile(MNEMONIC_FILE)).trim();
    if (mnemonic && isValidMnemonic(mnemonic)) return mnemonic;
    console.warn(`[XClawRouter] ⚠ Mnemonic file exists but has invalid format — ignoring`);
    return undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[XClawRouter] ⚠ Cannot read mnemonic file — ignoring`);
    }
  }
  return undefined;
}

async function saveMnemonic(mnemonic: string): Promise<void> {
  await mkdir(WALLET_DIR, { recursive: true });
  await writeFile(MNEMONIC_FILE, mnemonic + "\n", { mode: 0o600 });
}

async function generateAndSaveWallet(): Promise<{
  key: string;
  address: string;
  mnemonic: string;
  solanaPrivateKeyBytes: Uint8Array;
}> {
  const existingMnemonic = await loadMnemonic();
  if (existingMnemonic) {
    throw new Error(
      `Mnemonic file exists at ${MNEMONIC_FILE} but wallet.key is missing.\n` +
        `Refusing to generate a new wallet to protect existing funds.`,
    );
  }

  const mnemonic = generateWalletMnemonic();
  const derived = deriveAllKeys(mnemonic);

  await mkdir(WALLET_DIR, { recursive: true });
  await writeFile(WALLET_FILE, derived.evmPrivateKey + "\n", { mode: 0o600 });
  await writeFile(MNEMONIC_FILE, mnemonic + "\n", { mode: 0o600 });

  const verification = (await readTextFile(WALLET_FILE)).trim();
  if (verification !== derived.evmPrivateKey) {
    throw new Error("Wallet file verification failed - content mismatch");
  }

  return {
    key: derived.evmPrivateKey,
    address: derived.evmAddress,
    mnemonic,
    solanaPrivateKeyBytes: derived.solanaPrivateKeyBytes,
  };
}

/**
 * Result of wallet resolution.
 *
 * - `source: "okx"` — OKX onchainos wallet is connected. `key` is undefined
 *   because signing is delegated to onchainos (no private key in this process).
 *   `onchainos` is the adapter the proxy uses to sign x402 payments.
 * - `source: "saved" | "env" | "config" | "generated"` — local key path.
 */
export type WalletResolution = {
  key?: string;
  address: string;
  source: "saved" | "env" | "config" | "generated" | "okx";
  mnemonic?: string;
  solanaPrivateKeyBytes?: Uint8Array;
  onchainos?: OnchainOsAdapter;
  email?: string;
};

/**
 * Resolve the wallet identity, preferring OKX onchainos when available.
 *
 * If onchainos is installed and logged in, returns its EVM address as the
 * wallet identity (no local key). Otherwise falls back to the legacy
 * local-key flow: saved file → env var → auto-generate.
 */
export async function resolveOrGenerateWalletKey(): Promise<WalletResolution> {
  // 1. Prefer OKX onchainos when installed + logged in.
  const onchainos = await detectOnchainosWallet();
  if (onchainos) {
    return {
      address: onchainos.address,
      source: "okx",
      onchainos: onchainos.adapter,
      email: onchainos.email,
    };
  }

  // 2. Legacy local-key path.
  const saved = await loadSavedWallet();
  if (saved) {
    const account = privateKeyToAccount(saved as `0x${string}`);
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

  const envKey = process.env.BLOCKRUN_WALLET_KEY;
  if (typeof envKey === "string" && envKey.startsWith("0x") && envKey.length === 66) {
    const account = privateKeyToAccount(envKey as `0x${string}`);
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

  const result = await generateAndSaveWallet();
  return {
    key: result.key,
    address: result.address,
    source: "generated",
    mnemonic: result.mnemonic,
    solanaPrivateKeyBytes: result.solanaPrivateKeyBytes,
  };
}

/** Restore wallet.key from an existing mnemonic file. */
export async function recoverWalletFromMnemonic(): Promise<void> {
  const mnemonic = await loadMnemonic();
  if (!mnemonic) {
    console.error(`[XClawRouter] No mnemonic found at ${MNEMONIC_FILE}`);
    process.exit(1);
  }

  const existing = await loadSavedWallet().catch(() => undefined);
  if (existing) {
    console.error(`[XClawRouter] wallet.key already exists at ${WALLET_FILE}`);
    process.exit(1);
  }

  const derived = deriveAllKeys(mnemonic);
  const solanaKeyBytes = deriveSolanaKeyBytes(mnemonic);
  const solanaAddress = await getSolanaAddress(solanaKeyBytes).catch(() => undefined);

  console.log(`[XClawRouter] Derived EVM Address   : ${derived.evmAddress}`);
  if (solanaAddress) console.log(`[XClawRouter] Derived Solana Address: ${solanaAddress}`);

  await mkdir(WALLET_DIR, { recursive: true });
  await writeFile(WALLET_FILE, derived.evmPrivateKey + "\n", { mode: 0o600 });
  console.log(`[XClawRouter] ✓ wallet.key restored at ${WALLET_FILE}`);
}

/** Set up Solana for an existing local-key wallet. Not used in OKX mode. */
export async function setupSolana(): Promise<{
  mnemonic: string;
  solanaPrivateKeyBytes: Uint8Array;
}> {
  const existing = await loadMnemonic();
  if (existing) throw new Error("Solana wallet already set up at " + MNEMONIC_FILE);

  const savedKey = await loadSavedWallet();
  if (!savedKey) {
    throw new Error(
      "No EVM wallet found. Run XClawRouter first to generate a wallet before setting up Solana.",
    );
  }

  const mnemonic = generateWalletMnemonic();
  const solanaKeyBytes = deriveSolanaKeyBytes(mnemonic);
  await saveMnemonic(mnemonic);

  return { mnemonic, solanaPrivateKeyBytes: solanaKeyBytes };
}

/** @deprecated Legacy manual-entry auth. */
export const walletKeyAuth: ProviderAuthMethod = {
  id: "wallet-key",
  label: "Wallet Private Key",
  hint: "Enter your EVM wallet private key (0x...) for x402 payments",
  kind: "api_key",
  run: async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
    const key = await ctx.prompter.text({
      message: "Enter your wallet private key (0x...)",
      validate: (value: string) => {
        const trimmed = value.trim();
        if (!trimmed.startsWith("0x")) return "Key must start with 0x";
        if (trimmed.length !== 66) return "Key must be 66 characters";
        if (!/^0x[0-9a-fA-F]{64}$/.test(trimmed)) return "Key must be valid hex";
        return undefined;
      },
    });

    if (!key || typeof key !== "string") throw new Error("Wallet key is required");

    return {
      profiles: [{ profileId: "default", credential: { apiKey: key.trim() } }],
      notes: ["Wallet key stored securely in OpenClaw credentials."],
    };
  },
};

/** @deprecated Legacy env-var auth. */
export const envKeyAuth: ProviderAuthMethod = {
  id: "env-key",
  label: "Environment Variable",
  hint: "Use BLOCKRUN_WALLET_KEY environment variable",
  kind: "api_key",
  run: async (): Promise<ProviderAuthResult> => {
    const key = process.env.BLOCKRUN_WALLET_KEY;
    if (!key) throw new Error("BLOCKRUN_WALLET_KEY environment variable is not set.");
    return {
      profiles: [{ profileId: "default", credential: { apiKey: key.trim() } }],
      notes: ["Using wallet key from BLOCKRUN_WALLET_KEY environment variable."],
    };
  },
};
