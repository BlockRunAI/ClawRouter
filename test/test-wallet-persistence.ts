/**
 * Test wallet persistence across gateway restarts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { readFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const execAsync = promisify(exec);

const WALLET_FILE = join(homedir(), ".openclaw", "blockrun", "wallet.key");

async function waitForGatewayStart(timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch("http://127.0.0.1:8402/health");
      if (res.ok) return;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Gateway failed to start within timeout");
}

describe("Wallet Persistence", () => {
  let gatewayProcess: { pid?: number } | null = null;

  after(async () => {
    // Cleanup: stop gateway if running
    if (gatewayProcess?.pid) {
      try {
        process.kill(gatewayProcess.pid);
      } catch {
        // Already stopped
      }
    }
  });

  it("should persist wallet across gateway restarts", async () => {
    // Clean slate: remove any existing wallet
    try {
      await unlink(WALLET_FILE);
    } catch {
      // File doesn't exist, that's fine
    }

    // Test 1: First gateway start should generate wallet
    console.log("\n=== Test 1: First gateway start ===");
    const proc1 = exec("npx openclaw gateway start");
    gatewayProcess = proc1;

    await waitForGatewayStart();

    // Wallet file should exist
    let wallet1: string;
    try {
      wallet1 = (await readFile(WALLET_FILE, "utf-8")).trim();
      assert.ok(wallet1.startsWith("0x"), "Wallet should start with 0x");
      assert.strictEqual(wallet1.length, 66, "Wallet should be 66 characters");
      console.log(`✓ Wallet created: ${wallet1.slice(0, 20)}...`);
    } catch (err) {
      throw new Error(`Wallet file not created: ${err}`);
    }

    // Stop gateway
    proc1.kill();
    await new Promise((r) => setTimeout(r, 2000));

    // Test 2: Wallet should still exist after stop
    console.log("\n=== Test 2: After gateway stop ===");
    try {
      const walletAfterStop = (await readFile(WALLET_FILE, "utf-8")).trim();
      assert.strictEqual(walletAfterStop, wallet1, "Wallet should persist after stop");
      console.log(`✓ Wallet still exists after stop`);
    } catch {
      throw new Error("Wallet was deleted after gateway stop");
    }

    // Test 3: Second gateway start should reuse wallet
    console.log("\n=== Test 3: Second gateway start ===");
    const proc2 = exec("npx openclaw gateway start");
    gatewayProcess = proc2;

    await waitForGatewayStart();

    try {
      const wallet2 = (await readFile(WALLET_FILE, "utf-8")).trim();
      assert.strictEqual(wallet2, wallet1, "Wallet should NOT regenerate on restart");
      console.log(`✓✓✓ SUCCESS: Wallet persisted across restarts!`);
    } catch (err) {
      throw new Error(`Wallet verification failed: ${err}`);
    }

    // Cleanup
    proc2.kill();
  });

  it("should use env var wallet when BLOCKRUN_WALLET_KEY is set", async () => {
    const testKey = "0x" + "a".repeat(64);
    process.env.BLOCKRUN_WALLET_KEY = testKey;

    // Remove saved wallet file
    try {
      await unlink(WALLET_FILE);
    } catch {
      // File doesn't exist
    }

    const proc = exec("npx openclaw gateway start");
    gatewayProcess = proc;

    await waitForGatewayStart();

    // Should NOT create wallet file (using env var)
    try {
      await readFile(WALLET_FILE, "utf-8");
      throw new Error("Wallet file should NOT be created when env var is set");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        console.log(`✓ Correctly using env var instead of file`);
      } else {
        throw err;
      }
    }

    proc.kill();
    delete process.env.BLOCKRUN_WALLET_KEY;
  });
});
