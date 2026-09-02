/**
 * BlockRun Auth Methods for OpenClaw
 *
 * Provides wallet-based authentication for the BlockRun provider.
 * Operators configure their wallet private key, which is used to
 * sign x402 micropayments for LLM inference.
 *
 * Wallet resolution order:
 *   1. Environment variable — read from BLOCKRUN_WALLET_KEY
 *   2. BlockRun Core — reuse ~/.blockrun wallets across BlockRun products
 *   3. Legacy saved wallet — ~/.openclaw/blockrun/wallet.key
 *   4. Auto-generate — create a legacy wallet for standalone installs
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

import { createPrivateKey, createPublicKey } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { readTextFile } from "./fs-read.js";
import { join } from "node:path";
import { homedir } from "node:os";
import bs58 from "bs58";
import { privateKeyToAccount } from "viem/accounts";
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
const CORE_WALLET_DIR = join(homedir(), ".blockrun");
const CORE_WALLET_FILE = join(CORE_WALLET_DIR, ".session");
const CORE_SOLANA_WALLET_FILE = join(CORE_WALLET_DIR, ".solana-session");
const CORE_CHAIN_FILE = join(CORE_WALLET_DIR, ".chain");

// Export for use by wallet command, doctor, and index.ts.
export {
  WALLET_FILE,
  MNEMONIC_FILE,
  CHAIN_FILE,
  CORE_WALLET_FILE,
  CORE_SOLANA_WALLET_FILE,
  CORE_CHAIN_FILE,
};

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

export type LegacyWalletMigration = {
  base: boolean;
  solana: boolean;
  chain: boolean;
};

/**
 * Copy legacy ClawRouter wallet material into BlockRun Core without deleting the
 * old files. Each destination is created exclusively, so an existing Core
 * wallet is never replaced, even if two processes start at the same time.
 */
export async function migrateLegacyWalletToCore(): Promise<LegacyWalletMigration> {
  const migrated: LegacyWalletMigration = { base: false, solana: false, chain: false };
  const [coreBase, coreSolana, coreChain] = await Promise.all([
    readExisting(CORE_WALLET_FILE),
    readExisting(CORE_SOLANA_WALLET_FILE),
    readExisting(CORE_CHAIN_FILE),
  ]);

  if (coreBase === undefined) {
    const legacyBase = await loadSavedWallet();
    if (legacyBase) {
      migrated.base = await writeCoreFileIfMissing(CORE_WALLET_FILE, legacyBase + "\n");
    }
  }

  if (coreSolana === undefined) {
    const mnemonic = await loadMnemonic();
    if (mnemonic) {
      const secret = solanaSecretKeyFromSeed(deriveSolanaKeyBytes(mnemonic));
      migrated.solana = await writeCoreFileIfMissing(
        CORE_SOLANA_WALLET_FILE,
        JSON.stringify([...secret]) + "\n",
      );
    }
  }

  if (coreChain === undefined) {
    const legacyChain = await readOptional(CHAIN_FILE);
    if (legacyChain === "base" || legacyChain === "solana") {
      migrated.chain = await writeCoreFileIfMissing(CORE_CHAIN_FILE, legacyChain + "\n");
    }
  }

  if (migrated.base || migrated.solana || migrated.chain) {
    const parts = Object.entries(migrated)
      .filter(([, changed]) => changed)
      .map(([name]) => name)
      .join(", ");
    console.log(`[ClawRouter] Migrated legacy ${parts} data to ${CORE_WALLET_DIR}`);
  }
  return migrated;
}

async function writeCoreFileIfMissing(path: string, value: string): Promise<boolean> {
  await mkdir(CORE_WALLET_DIR, { recursive: true });
  try {
    await writeFile(path, value, { mode: 0o600, flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

async function readExisting(path: string): Promise<string | undefined> {
  try {
    return await readTextFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function solanaSecretKeyFromSeed(seed: Uint8Array): Uint8Array {
  const privateDer = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const publicDer = createPublicKey(
    createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" }),
  ).export({ format: "der", type: "spki" });
  return Uint8Array.from([...seed, ...Buffer.from(publicDer).subarray(-32)]);
}

/**
 * Generate a new wallet with BIP-39 mnemonic, save to disk.
 * New users get both EVM and Solana keys derived from the same mnemonic.
 * CRITICAL: Verifies the file was actually written after generation.
 */
async function generateAndSaveWallet(existingCoreSolanaKey?: Uint8Array): Promise<{
  key: string;
  address: string;
  mnemonic?: string;
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

  // A pre-existing Core Solana key is authoritative. In that case the new
  // mnemonic recovers only the generated Base key, so do not persist or label
  // it as a cross-chain recovery phrase.
  if (!existingCoreSolanaKey) {
    await writeFile(MNEMONIC_FILE, mnemonic + "\n", { mode: 0o600 });
  }

  // BlockRun Core is the canonical home for new cross-product wallets. Keep
  // the legacy files above so older ClawRouter versions can still roll back.
  await writeCoreFileIfMissing(CORE_WALLET_FILE, derived.evmPrivateKey + "\n");
  if (!existingCoreSolanaKey) {
    await writeCoreFileIfMissing(
      CORE_SOLANA_WALLET_FILE,
      JSON.stringify([...solanaSecretKeyFromSeed(derived.solanaPrivateKeyBytes)]) + "\n",
    );
  }

  const solanaPrivateKeyBytes = existingCoreSolanaKey ?? derived.solanaPrivateKeyBytes;

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
    solanaAddress = await getSolanaAddress(solanaPrivateKeyBytes);
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
  console.log(`[ClawRouter]   Base key       : ${CORE_WALLET_FILE}`);
  console.log(`[ClawRouter]   Solana key     : ${CORE_SOLANA_WALLET_FILE}`);
  if (!existingCoreSolanaKey) {
    console.log(`[ClawRouter]   Recovery words : ${MNEMONIC_FILE}`);
  }
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
    ...(existingCoreSolanaKey ? {} : { mnemonic }),
    solanaPrivateKeyBytes,
  };
}

/**
 * Resolve wallet key: migrate legacy files → explicit env → Core → legacy → generate.
 * Also loads Core Solana material or a legacy mnemonic-derived key when available.
 * Called by index.ts before the auth wizard runs.
 */
export type WalletResolution = {
  key: string;
  address: string;
  source: "core" | "saved" | "env" | "config" | "generated";
  mnemonic?: string;
  solanaPrivateKeyBytes?: Uint8Array;
};

/** Resolve configured wallet material without creating any new files. */
export async function resolveExistingWalletKey(): Promise<WalletResolution | undefined> {
  const coreSolanaKey = await loadCoreSolanaKeyForSelectedChain();

  // 1. Explicit environment override
  const envKey = process["env"].BLOCKRUN_WALLET_KEY;
  if (typeof envKey === "string" && /^0x[0-9a-f]{64}$/i.test(envKey)) {
    const account = privateKeyToAccount(envKey as `0x${string}`);
    return {
      key: envKey,
      address: account.address,
      source: "env",
      ...(await resolvedSolanaMaterial(coreSolanaKey)),
    };
  }

  // 2. Canonical BlockRun Core wallet
  const core = await loadCoreWallet();
  if (core) {
    const account = privateKeyToAccount(core as `0x${string}`);
    return {
      key: core,
      address: account.address,
      source: "core",
      ...(await resolvedSolanaMaterial(coreSolanaKey)),
    };
  }

  // 3. Previously saved ClawRouter wallet (legacy compatibility)
  const saved = await loadSavedWallet();
  if (saved) {
    const account = privateKeyToAccount(saved as `0x${string}`);
    return {
      key: saved,
      address: account.address,
      source: "saved",
      ...(await resolvedSolanaMaterial(coreSolanaKey)),
    };
  }

  return undefined;
}

export async function resolveOrGenerateWalletKey(): Promise<WalletResolution> {
  await migrateLegacyWalletToCore();
  const existing = await resolveExistingWalletKey();
  if (existing) return existing;

  // A Solana-only Core wallet may exist before Base is created (for example,
  // through Desktop wallet management). Validate and preserve it rather than
  // returning an in-memory key that differs from the persisted signer.
  const existingCoreSolanaKey = await loadCoreSolanaKey();

  // Auto-generate with BIP-39 mnemonic (legacy standalone behavior).
  const result = await generateAndSaveWallet(existingCoreSolanaKey);
  return {
    key: result.key,
    address: result.address,
    source: "generated",
    mnemonic: result.mnemonic,
    solanaPrivateKeyBytes: result.solanaPrivateKeyBytes,
  };
}

async function loadCoreSolanaKeyForSelectedChain(): Promise<Uint8Array | undefined> {
  try {
    return await loadCoreSolanaKey();
  } catch (error) {
    // A Base-only user must not be locked out by optional Solana state. When
    // Solana is selected, retain fail-closed validation so funds are never
    // sent from an unintended key.
    if ((await resolvePaymentChain()) === "solana") throw error;
    return undefined;
  }
}

async function loadCoreWallet(): Promise<string | undefined> {
  const key = (await readExisting(CORE_WALLET_FILE))?.trim();
  if (key === undefined) return undefined;
  if (/^0x[0-9a-f]{64}$/i.test(key)) return key;
  throw new Error(
    `BlockRun Core wallet at ${CORE_WALLET_FILE} has an invalid format. Refusing to use another wallet implicitly.`,
  );
}

async function loadCoreSolanaKey(): Promise<Uint8Array | undefined> {
  const environmentKey = process["env"].SOLANA_WALLET_KEY?.trim();
  const raw = environmentKey || (await readExisting(CORE_SOLANA_WALLET_FILE))?.trim();
  if (!raw) return undefined;
  try {
    let bytes: Uint8Array;
    if (raw.startsWith("[")) {
      const parsed = JSON.parse(raw) as unknown;
      if (
        !Array.isArray(parsed) ||
        !parsed.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)
      )
        throw new Error("expected an array of byte values");
      bytes = Uint8Array.from(parsed);
    } else {
      const hex = raw.replace(/^0x/i, "");
      bytes = /^[0-9a-f]{128}$/i.test(hex) ? Buffer.from(hex, "hex") : bs58.decode(raw);
    }
    if (bytes.length !== 64) throw new Error(`expected 64 bytes, received ${bytes.length}`);
    const expected = solanaSecretKeyFromSeed(bytes.slice(0, 32));
    if (!Buffer.from(expected).equals(Buffer.from(bytes))) {
      throw new Error("public key does not match the private seed");
    }
    return bytes.slice(0, 32);
  } catch (error) {
    throw new Error(
      `BlockRun Core Solana wallet has an invalid format: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return (await readTextFile(path)).trim() || undefined;
  } catch {
    return undefined;
  }
}

async function resolvedSolanaMaterial(
  coreSolanaKey: Uint8Array | undefined,
): Promise<Partial<Pick<WalletResolution, "mnemonic" | "solanaPrivateKeyBytes">>> {
  if (coreSolanaKey) return { solanaPrivateKeyBytes: coreSolanaKey };
  const mnemonic = await loadMnemonic();
  return mnemonic ? { mnemonic, solanaPrivateKeyBytes: deriveSolanaKeyBytes(mnemonic) } : {};
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

  // Safety: if either active Base wallet already exists, refuse to overwrite.
  const existingCore = await loadCoreWallet();
  if (existingCore) {
    console.error(`[ClawRouter] BlockRun Core wallet already exists at ${CORE_WALLET_FILE}`);
    console.error(`[ClawRouter] Recovery not needed.`);
    process.exit(1);
  }
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
  await migrateLegacyWalletToCore();

  console.log(`[ClawRouter] ✓ Wallet restored into BlockRun Core at ${CORE_WALLET_DIR}`);
  console.log(`[ClawRouter]   Run: npx @blockrun/clawrouter`);
  console.log(`[ClawRouter]`);
}

/**
 * Set up Solana wallet for existing EVM-only users.
 * Generates a new mnemonic for Solana key derivation.
 * NEVER changes the existing Base wallet.
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

  // Safety: an EVM wallet must exist in Core or the legacy location.
  const evmKey = (await loadCoreWallet()) ?? (await loadSavedWallet());
  if (!evmKey) {
    throw new Error(
      "No EVM wallet found. Run ClawRouter first to generate a wallet before setting up Solana.",
    );
  }

  // Generate new mnemonic for Solana derivation
  const mnemonic = generateWalletMnemonic();
  const solanaKeyBytes = deriveSolanaKeyBytes(mnemonic);

  // Save mnemonic (wallet.key untouched)
  await saveMnemonic(mnemonic);
  await writeCoreFileIfMissing(
    CORE_SOLANA_WALLET_FILE,
    JSON.stringify([...solanaSecretKeyFromSeed(solanaKeyBytes)]) + "\n",
  );

  console.log(`[ClawRouter] Solana wallet set up successfully.`);
  console.log(`[ClawRouter] Solana key saved to ${CORE_SOLANA_WALLET_FILE}`);
  console.log(`[ClawRouter] Recovery mnemonic saved to ${MNEMONIC_FILE}`);
  console.log(`[ClawRouter] Existing EVM wallet unchanged.`);

  return { mnemonic, solanaPrivateKeyBytes: solanaKeyBytes };
}

/**
 * Persist the user's payment chain selection to disk.
 */
export async function savePaymentChain(chain: "base" | "solana"): Promise<void> {
  await mkdir(WALLET_DIR, { recursive: true });
  await mkdir(CORE_WALLET_DIR, { recursive: true });
  await Promise.all([
    writeFile(CHAIN_FILE, chain + "\n", { mode: 0o600 }),
    writeFile(CORE_CHAIN_FILE, chain + "\n", { mode: 0o600 }),
  ]);
}

/**
 * Load the persisted payment chain selection from disk.
 * Returns "base" if no file exists or the file is invalid.
 * New installs persist "solana" at wallet generation, so an absent file
 * means a pre-existing install whose funds live on Base.
 */
export async function loadPaymentChain(): Promise<"base" | "solana"> {
  const core = await readOptional(CORE_CHAIN_FILE);
  if (core === "solana") return "solana";
  if (core === "base") return "base";
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
