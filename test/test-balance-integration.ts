/**
 * Integration test for balance monitoring with empty wallet.
 *
 * Tests that the proxy correctly:
 *   1. Warns about empty wallet on startup
 *   2. Throws EmptyWalletError when trying to make a request
 *   3. Includes wallet address in error message
 *
 * Uses a randomly generated wallet (guaranteed to have $0 USDC).
 *
 * Usage:
 *   npx tsx test-balance-integration.ts
 */

import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { startProxy } from "../src/proxy.js";
import { isEmptyWalletError, isInsufficientFundsError, isBalanceError } from "../src/errors.js";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
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
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

async function main() {
  console.log("\n=== Balance Integration Tests (Empty Wallet) ===\n");

  // Generate a fresh wallet with no funds
  const emptyWalletKey = generatePrivateKey();
  const emptyAccount = privateKeyToAccount(emptyWalletKey);
  console.log(`Using empty wallet: ${emptyAccount.address}\n`);

  // Track callbacks
  let lowBalanceCalled = false;
  let insufficientFundsCalled = false;
  let insufficientFundsInfo: {
    balanceUSD: string;
    requiredUSD: string;
    walletAddress: string;
  } | null = null;

  // Start proxy with empty wallet
  console.log("Starting proxy with empty wallet...");
  const proxy = await startProxy({
    wallet: emptyWalletKey,
    onReady: (port) => console.log(`Proxy ready on port ${port}`),
    onError: (err) => console.log(`[onError] ${err.message}`),
    onLowBalance: (info) => {
      console.log(`[onLowBalance] Balance: ${info.balanceUSD}, Wallet: ${info.walletAddress}`);
      lowBalanceCalled = true;
    },
    onInsufficientFunds: (info) => {
      console.log(
        `[onInsufficientFunds] Balance: ${info.balanceUSD}, Required: ${info.requiredUSD}, Wallet: ${info.walletAddress}`,
      );
      insufficientFundsCalled = true;
      insufficientFundsInfo = info;
    },
  });

  console.log();

  // Test 1: Health check still works (doesn't require balance)
  await test("Health check works with empty wallet", async () => {
    const res = await fetch(`${proxy.baseUrl}/health`);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const body = await res.json();
    assert(body.status === "ok", "Expected status ok");
    assert(body.wallet === emptyAccount.address, "Wallet address mismatch");
  });

  // Test 2: Request fails with balance error
  await test("Request fails with EmptyWalletError", async () => {
    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "blockrun/auto",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 10,
      }),
    });

    // Should get 502 proxy error
    assert(res.status === 502, `Expected 502, got ${res.status}`);

    const body = await res.json();
    assert(body.error?.type === "proxy_error", "Expected proxy_error type");
    assert(
      body.error?.message?.includes("No USDC balance"),
      `Expected "No USDC balance" in message, got: ${body.error?.message}`,
    );
    assert(
      body.error?.message?.includes(emptyAccount.address),
      "Expected wallet address in error message",
    );
  });

  // Test 3: onInsufficientFunds callback was called
  await test("onInsufficientFunds callback was called", async () => {
    assert(insufficientFundsCalled, "onInsufficientFunds should have been called");
    assert(insufficientFundsInfo !== null, "Should have callback info");
    assert(
      insufficientFundsInfo!.walletAddress === emptyAccount.address,
      "Wallet address should match",
    );
    assert(
      insufficientFundsInfo!.balanceUSD === "$0.00",
      `Expected $0.00 balance, got ${insufficientFundsInfo!.balanceUSD}`,
    );
  });

  // Test 4: Streaming request also fails correctly
  await test("Streaming request fails with balance error", async () => {
    insufficientFundsCalled = false; // Reset

    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "blockrun/auto",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 10,
        stream: true,
      }),
    });

    // For streaming, we might get 200 with SSE error, or 502
    // Either way, the callback should be called
    const text = await res.text();

    assert(
      insufficientFundsCalled,
      "onInsufficientFunds should have been called for streaming request",
    );

    // Check error is in response
    if (res.status === 200) {
      // SSE format - error sent as data event
      assert(
        text.includes("proxy_error") || text.includes("No USDC"),
        "Expected error in SSE stream",
      );
    } else {
      assert(res.status === 502, `Expected 200 or 502, got ${res.status}`);
    }
  });

  // Test 5: Direct model request also fails
  await test("Direct model request fails with balance error", async () => {
    insufficientFundsCalled = false; // Reset

    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek/deepseek-chat",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 10,
      }),
    });

    assert(res.status === 502, `Expected 502, got ${res.status}`);
    assert(insufficientFundsCalled, "onInsufficientFunds should have been called");
  });

  // Cleanup
  await proxy.close();

  console.log(
    `\n=== ${failed === 0 ? "ALL TESTS PASSED" : "SOME TESTS FAILED"} (${passed} passed, ${failed} failed) ===\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
