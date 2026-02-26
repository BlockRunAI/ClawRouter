/**
 * Manual wallet migration smoke test on real disk.
 *
 * Tests all 3 scenarios using a temp HOME to avoid touching real wallet.
 * Uses real filesystem, real path resolution, real file permissions.
 *
 * Usage: npx tsx test/smoke-wallet-scenarios.ts
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Create temp HOME so we don't touch real wallet
const TEMP_HOME = join(tmpdir(), `clawrouter-smoke-${Date.now()}`);
mkdirSync(TEMP_HOME, { recursive: true });
process.env.HOME = TEMP_HOME;

// Now import auth (it reads homedir() at module load)
const { resolveOrGenerateWalletKey, setupSolana, WALLET_FILE, MNEMONIC_FILE } =
  await import("../src/auth.js");
const { isValidMnemonic } = await import("../src/wallet.js");

const WALLET_DIR = join(TEMP_HOME, ".openclaw", "blockrun");

let passed = 0;
let failed = 0;

function assert(ok: boolean, msg: string) {
  if (ok) { console.log(`  ✓ ${msg}`); passed++; }
  else { console.error(`  ✗ FAIL: ${msg}`); failed++; }
}

function clean() {
  if (existsSync(WALLET_DIR)) {
    rmSync(WALLET_DIR, { recursive: true });
  }
}

// ═══════════════════════════════════════════════════════════════
// Scenario 3: Fresh install (nothing exists)
// Expected: generate mnemonic + both keys
// ═══════════════════════════════════════════════════════════════

console.log("\n═══ Scenario 3: Fresh Install ═══\n");
clean();

{
  const result = await resolveOrGenerateWalletKey();

  assert(result.source === "generated", `Source: ${result.source}`);
  assert(result.key.startsWith("0x") && result.key.length === 66, `EVM key valid: ${result.key.slice(0, 12)}...`);
  assert(result.address.startsWith("0x"), `EVM address: ${result.address}`);
  assert(result.mnemonic !== undefined, `Mnemonic returned`);
  assert(result.solanaPrivateKeyBytes !== undefined, `Solana key bytes returned`);
  assert(result.solanaPrivateKeyBytes!.length === 32, `Solana key is 32 bytes`);

  // Verify files on disk
  assert(existsSync(WALLET_FILE), `wallet.key exists on disk`);
  assert(existsSync(MNEMONIC_FILE), `mnemonic exists on disk`);

  const diskKey = readFileSync(WALLET_FILE, "utf8").trim();
  assert(diskKey === result.key, `wallet.key content matches`);

  const diskMnemonic = readFileSync(MNEMONIC_FILE, "utf8").trim();
  assert(isValidMnemonic(diskMnemonic), `mnemonic on disk is valid BIP-39`);
  assert(diskMnemonic === result.mnemonic, `mnemonic content matches`);

  // Verify file permissions (0o600 = owner read/write only)
  const { statSync } = await import("node:fs");
  const keyPerms = statSync(WALLET_FILE).mode & 0o777;
  assert(keyPerms === 0o600, `wallet.key permissions: ${keyPerms.toString(8)} (expect 600)`);
  const mnemonicPerms = statSync(MNEMONIC_FILE).mode & 0o777;
  assert(mnemonicPerms === 0o600, `mnemonic permissions: ${mnemonicPerms.toString(8)} (expect 600)`);
}

// ═══════════════════════════════════════════════════════════════
// Scenario 1: Existing wallet.key only (no mnemonic)
// Expected: EVM-only, no Solana keys
// ═══════════════════════════════════════════════════════════════

console.log("\n═══ Scenario 1: Existing wallet.key Only ═══\n");
clean();

{
  // Set up: create wallet.key but no mnemonic
  mkdirSync(WALLET_DIR, { recursive: true });
  const testKey = "0x" + "ab".repeat(32);
  writeFileSync(join(WALLET_DIR, "wallet.key"), testKey + "\n", { mode: 0o600 });

  const result = await resolveOrGenerateWalletKey();

  assert(result.source === "saved", `Source: ${result.source}`);
  assert(result.key === testKey, `EVM key loaded from disk`);
  assert(result.address.startsWith("0x"), `EVM address: ${result.address}`);
  assert(result.mnemonic === undefined, `No mnemonic (EVM-only)`);
  assert(result.solanaPrivateKeyBytes === undefined, `No Solana key bytes (EVM-only)`);
}

// ═══════════════════════════════════════════════════════════════
// Scenario 2: Existing wallet.key + setup-solana
// Expected: creates mnemonic, derives Solana, EVM untouched
// ═══════════════════════════════════════════════════════════════

console.log("\n═══ Scenario 2: wallet.key + setup-solana ═══\n");
// Don't clean - reuse wallet.key from scenario 1

{
  const originalKey = readFileSync(join(WALLET_DIR, "wallet.key"), "utf8").trim();
  assert(!existsSync(MNEMONIC_FILE), `No mnemonic before setup-solana`);

  // Run setup-solana
  const solResult = await setupSolana();

  assert(typeof solResult.mnemonic === "string", `Mnemonic returned from setup-solana`);
  assert(isValidMnemonic(solResult.mnemonic), `Mnemonic is valid BIP-39`);
  assert(solResult.solanaPrivateKeyBytes.length === 32, `Solana key is 32 bytes`);
  assert(existsSync(MNEMONIC_FILE), `Mnemonic file created on disk`);

  // EVM wallet.key must be UNTOUCHED
  const afterKey = readFileSync(join(WALLET_DIR, "wallet.key"), "utf8").trim();
  assert(afterKey === originalKey, `EVM wallet.key unchanged after setup-solana`);

  // Now resolveOrGenerateWalletKey should return both
  const result = await resolveOrGenerateWalletKey();
  assert(result.source === "saved", `Source: ${result.source}`);
  assert(result.key === originalKey, `EVM key still matches`);
  assert(result.solanaPrivateKeyBytes !== undefined, `Solana key bytes now available`);
  assert(result.mnemonic !== undefined, `Mnemonic now available`);
}

// ═══════════════════════════════════════════════════════════════
// Edge case: Delete wallet.key when mnemonic exists
// Expected: refuse to generate new wallet (protect Solana funds)
// ═══════════════════════════════════════════════════════════════

console.log("\n═══ Edge Case: Delete wallet.key with mnemonic present ═══\n");

{
  // Remove wallet.key but keep mnemonic
  rmSync(join(WALLET_DIR, "wallet.key"));
  assert(!existsSync(join(WALLET_DIR, "wallet.key")), `wallet.key deleted`);
  assert(existsSync(MNEMONIC_FILE), `mnemonic still exists`);

  try {
    await resolveOrGenerateWalletKey();
    assert(false, `Should have thrown but didn't`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert(msg.includes("Refusing"), `Threw protective error: ${msg.slice(0, 80)}...`);
  }
}

// ═══════════════════════════════════════════════════════════════
// Edge case: setup-solana when mnemonic already exists
// Expected: refuse (don't overwrite)
// ═══════════════════════════════════════════════════════════════

console.log("\n═══ Edge Case: setup-solana when already set up ═══\n");

{
  // Restore wallet.key for this test
  writeFileSync(join(WALLET_DIR, "wallet.key"), "0x" + "ab".repeat(32) + "\n", { mode: 0o600 });

  try {
    await setupSolana();
    assert(false, `Should have thrown but didn't`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert(msg.includes("already set up"), `Threw: ${msg.slice(0, 60)}...`);
  }
}

// Cleanup
clean();
rmSync(TEMP_HOME, { recursive: true });

console.log("\n═══════════════════════════════════");
console.log(`  ${passed} passed, ${failed} failed`);
console.log("═══════════════════════════════════\n");

process.exit(failed > 0 ? 1 : 0);
