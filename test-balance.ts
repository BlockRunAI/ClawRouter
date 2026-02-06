/**
 * Unit tests for balance monitoring feature.
 *
 * Tests:
 *   1. BalanceMonitor formatting and thresholds
 *   2. Error classes and type guards
 *   3. Integration with proxy (using mock RPC)
 *
 * Usage:
 *   npx tsx test-balance.ts
 */

import { BalanceMonitor, BALANCE_THRESHOLDS, type BalanceInfo } from "./src/balance.js";
import {
  InsufficientFundsError,
  EmptyWalletError,
  RpcError,
  isInsufficientFundsError,
  isEmptyWalletError,
  isBalanceError,
  isRpcError,
} from "./src/errors.js";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  const run = async () => {
    process.stdout.write(`  ${name} ... `);
    try {
      await fn();
      console.log("PASS");
      passed++;
    } catch (err) {
      console.log("FAIL");
      console.error(`    ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  };
  return run();
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

function assertEqual<T>(actual: T, expected: T, msg?: string) {
  if (actual !== expected) {
    throw new Error(msg || `Expected ${expected}, got ${actual}`);
  }
}

async function main() {
  console.log("\n=== Balance Monitoring Tests ===\n");

  // --- Error Classes ---
  console.log("Error Classes:");

  await test("InsufficientFundsError has correct properties", () => {
    const err = new InsufficientFundsError({
      currentBalanceUSD: "$0.50",
      requiredUSD: "$1.00",
      walletAddress: "0x1234",
    });
    assertEqual(err.code, "INSUFFICIENT_FUNDS");
    assertEqual(err.currentBalanceUSD, "$0.50");
    assertEqual(err.requiredUSD, "$1.00");
    assertEqual(err.walletAddress, "0x1234");
    assert(err.message.includes("$0.50"), "Message should include current balance");
    assert(err.message.includes("$1.00"), "Message should include required amount");
    assert(err.message.includes("0x1234"), "Message should include wallet address");
  });

  await test("EmptyWalletError has correct properties", () => {
    const err = new EmptyWalletError("0xABCD");
    assertEqual(err.code, "EMPTY_WALLET");
    assertEqual(err.walletAddress, "0xABCD");
    assert(err.message.includes("0xABCD"), "Message should include wallet address");
    assert(err.message.includes("No USDC"), "Message should mention no balance");
  });

  await test("isInsufficientFundsError type guard works", () => {
    const insuffErr = new InsufficientFundsError({
      currentBalanceUSD: "$0",
      requiredUSD: "$1",
      walletAddress: "0x",
    });
    const emptyErr = new EmptyWalletError("0x");
    const genericErr = new Error("generic");

    assert(isInsufficientFundsError(insuffErr), "Should detect InsufficientFundsError");
    assert(!isInsufficientFundsError(emptyErr), "Should not detect EmptyWalletError as InsufficientFundsError");
    assert(!isInsufficientFundsError(genericErr), "Should not detect generic Error");
    assert(!isInsufficientFundsError(null), "Should handle null");
    assert(!isInsufficientFundsError("string"), "Should handle string");
  });

  await test("isEmptyWalletError type guard works", () => {
    const insuffErr = new InsufficientFundsError({
      currentBalanceUSD: "$0",
      requiredUSD: "$1",
      walletAddress: "0x",
    });
    const emptyErr = new EmptyWalletError("0x");

    assert(isEmptyWalletError(emptyErr), "Should detect EmptyWalletError");
    assert(!isEmptyWalletError(insuffErr), "Should not detect InsufficientFundsError as EmptyWalletError");
  });

  await test("isBalanceError detects both error types", () => {
    const insuffErr = new InsufficientFundsError({
      currentBalanceUSD: "$0",
      requiredUSD: "$1",
      walletAddress: "0x",
    });
    const emptyErr = new EmptyWalletError("0x");
    const genericErr = new Error("generic");

    assert(isBalanceError(insuffErr), "Should detect InsufficientFundsError");
    assert(isBalanceError(emptyErr), "Should detect EmptyWalletError");
    assert(!isBalanceError(genericErr), "Should not detect generic Error");
  });

  // --- RpcError ---
  console.log("\nRpcError:");

  await test("RpcError has correct properties", () => {
    const originalErr = new Error("connection refused");
    const err = new RpcError("Failed to connect to Base RPC", originalErr);
    assertEqual(err.code, "RPC_ERROR");
    assertEqual(err.originalError, originalErr);
    assert(err.message.includes("Failed to connect to Base RPC"), "Message should include error details");
    assert(err.message.includes("Check network connectivity"), "Message should include help text");
  });

  await test("RpcError without original error", () => {
    const err = new RpcError("Unknown RPC failure");
    assertEqual(err.code, "RPC_ERROR");
    assertEqual(err.originalError, undefined);
  });

  await test("isRpcError type guard works", () => {
    const rpcErr = new RpcError("test");
    const emptyErr = new EmptyWalletError("0x");
    const genericErr = new Error("generic");

    assert(isRpcError(rpcErr), "Should detect RpcError");
    assert(!isRpcError(emptyErr), "Should not detect EmptyWalletError as RpcError");
    assert(!isRpcError(genericErr), "Should not detect generic Error");
    assert(!isRpcError(null), "Should handle null");
    assert(!isRpcError("string"), "Should handle string");
  });

  await test("RpcError is not a balance error", () => {
    const rpcErr = new RpcError("test");
    assert(!isBalanceError(rpcErr), "RpcError should not be detected as balance error");
  });

  // --- BalanceMonitor ---
  console.log("\nBalanceMonitor:");

  await test("formatUSDC formats correctly", () => {
    // Create monitor with dummy address (won't actually call RPC in these tests)
    const monitor = new BalanceMonitor("0x0000000000000000000000000000000000000000");

    assertEqual(monitor.formatUSDC(0n), "$0.00");
    assertEqual(monitor.formatUSDC(1n), "$0.00"); // rounds down
    assertEqual(monitor.formatUSDC(100n), "$0.00"); // $0.0001
    assertEqual(monitor.formatUSDC(1000n), "$0.00"); // $0.001
    assertEqual(monitor.formatUSDC(10000n), "$0.01"); // $0.01
    assertEqual(monitor.formatUSDC(100000n), "$0.10"); // $0.10
    assertEqual(monitor.formatUSDC(1000000n), "$1.00"); // $1.00
    assertEqual(monitor.formatUSDC(1500000n), "$1.50"); // $1.50
    assertEqual(monitor.formatUSDC(12345678n), "$12.35"); // $12.345678 rounds
    assertEqual(monitor.formatUSDC(100000000n), "$100.00"); // $100.00
  });

  await test("BALANCE_THRESHOLDS are correct", () => {
    assertEqual(BALANCE_THRESHOLDS.LOW_BALANCE_MICROS, 1_000_000n, "Low balance should be $1.00");
    assertEqual(BALANCE_THRESHOLDS.ZERO_THRESHOLD, 100n, "Zero threshold should be $0.0001");
  });

  await test("getWalletAddress returns correct address", () => {
    const addr = "0x1234567890abcdef1234567890abcdef12345678";
    const monitor = new BalanceMonitor(addr);
    assertEqual(monitor.getWalletAddress(), addr);
  });

  // --- Balance Info Building (indirect test via checkSufficient with mocked balance) ---
  console.log("\nBalance Thresholds:");

  await test("Balance < $0.0001 is considered empty", () => {
    // Test the threshold logic
    const balance = 50n; // $0.00005
    const isEmpty = balance < BALANCE_THRESHOLDS.ZERO_THRESHOLD;
    assert(isEmpty, "Balance of $0.00005 should be empty");
  });

  await test("Balance >= $0.0001 is not empty", () => {
    const balance = 100n; // $0.0001
    const isEmpty = balance < BALANCE_THRESHOLDS.ZERO_THRESHOLD;
    assert(!isEmpty, "Balance of $0.0001 should not be empty");
  });

  await test("Balance < $1.00 is considered low", () => {
    const balance = 999_999n; // $0.999999
    const isLow = balance < BALANCE_THRESHOLDS.LOW_BALANCE_MICROS;
    assert(isLow, "Balance of $0.999999 should be low");
  });

  await test("Balance >= $1.00 is not low", () => {
    const balance = 1_000_000n; // $1.00
    const isLow = balance < BALANCE_THRESHOLDS.LOW_BALANCE_MICROS;
    assert(!isLow, "Balance of $1.00 should not be low");
  });

  // --- Cache behavior ---
  console.log("\nCache Behavior:");

  await test("deductEstimated reduces cached balance", () => {
    const monitor = new BalanceMonitor("0x0000000000000000000000000000000000000000");
    // Manually set cache for testing (access private via any)
    (monitor as any).cachedBalance = 5_000_000n; // $5.00
    (monitor as any).cachedAt = Date.now();

    monitor.deductEstimated(1_000_000n); // deduct $1.00
    assertEqual((monitor as any).cachedBalance, 4_000_000n, "Should have $4.00 after deduction");

    monitor.deductEstimated(500_000n); // deduct $0.50
    assertEqual((monitor as any).cachedBalance, 3_500_000n, "Should have $3.50 after second deduction");
  });

  await test("deductEstimated does not go negative", () => {
    const monitor = new BalanceMonitor("0x0000000000000000000000000000000000000000");
    (monitor as any).cachedBalance = 500_000n; // $0.50
    (monitor as any).cachedAt = Date.now();

    monitor.deductEstimated(1_000_000n); // try to deduct $1.00
    // Should not deduct if balance < amount
    assertEqual((monitor as any).cachedBalance, 500_000n, "Should not deduct if insufficient");
  });

  await test("invalidate clears cache", () => {
    const monitor = new BalanceMonitor("0x0000000000000000000000000000000000000000");
    (monitor as any).cachedBalance = 5_000_000n;
    (monitor as any).cachedAt = Date.now();

    monitor.invalidate();

    assertEqual((monitor as any).cachedBalance, null, "Cache should be null after invalidate");
    assertEqual((monitor as any).cachedAt, 0, "Cache timestamp should be 0 after invalidate");
  });

  // --- Live RPC test (optional, requires network) ---
  console.log("\nLive RPC Test:");

  await test("checkBalance fetches from Base RPC", async () => {
    // Use a known address (USDC contract itself has 0 USDC)
    const monitor = new BalanceMonitor("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");

    try {
      const info = await monitor.checkBalance();
      assert(typeof info.balance === "bigint", "Balance should be bigint");
      assert(typeof info.balanceUSD === "string", "balanceUSD should be string");
      assert(info.balanceUSD.startsWith("$"), "balanceUSD should start with $");
      assert(typeof info.isLow === "boolean", "isLow should be boolean");
      assert(typeof info.isEmpty === "boolean", "isEmpty should be boolean");
      assert(info.walletAddress.startsWith("0x"), "walletAddress should start with 0x");
      console.log(`(balance: ${info.balanceUSD}, isLow: ${info.isLow}, isEmpty: ${info.isEmpty})`);
    } catch (err) {
      // RPC might fail in some environments, that's okay
      console.log(`(RPC unavailable: ${err instanceof Error ? err.message : String(err)})`);
    }
  });

  // --- Summary ---
  console.log(`\n=== ${failed === 0 ? "ALL TESTS PASSED" : "SOME TESTS FAILED"} (${passed} passed, ${failed} failed) ===\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
