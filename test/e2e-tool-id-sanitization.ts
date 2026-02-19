/**
 * End-to-End Test: Tool ID Sanitization (Issue #17)
 *
 * Tests that tool IDs with invalid characters are properly sanitized
 * before being forwarded to upstream APIs (especially Anthropic which
 * requires pattern ^[a-zA-Z0-9_-]+$).
 *
 * Run: tsx test/e2e-tool-id-sanitization.ts
 */

import { startProxy } from "../dist/index.js";

const TEST_WALLET_KEY = process.env.BLOCKRUN_WALLET_KEY || "0x" + "a".repeat(64); // Placeholder - set BLOCKRUN_WALLET_KEY for real tests

const TEST_PORT = 8498;

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];

async function runTest(name: string, testFn: () => Promise<void>): Promise<void> {
  try {
    await testFn();
    results.push({ name, passed: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, error });
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error}`);
  }
}

async function main() {
  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║     E2E Test: Tool ID Sanitization (Issue #17)                ║");
  console.log("╚════════════════════════════════════════════════════════════════╝\n");

  let proxy: Awaited<ReturnType<typeof startProxy>> | undefined;

  try {
    // Start proxy
    console.log("Starting proxy...");
    proxy = await startProxy({
      walletKey: TEST_WALLET_KEY,
      port: TEST_PORT,
      onReady: (port) => console.log(`Proxy ready on port ${port}`),
      onError: (err) => console.error("Proxy error:", err.message),
    });

    console.log(`Wallet: ${proxy.walletAddress}`);
    const balance = await proxy.balanceMonitor.checkBalance();
    console.log(`Balance: $${balance.balanceUSD}\n`);

    if (balance.isEmpty) {
      console.log("⚠ Wallet is empty, skipping paid tests");
      return;
    }

    // Invalid tool IDs that would fail Anthropic's pattern validation
    const INVALID_TOOL_IDS = [
      "call:with:colons",
      "call.with.dots",
      "call/with/slashes",
      "call@with@at",
      "call with spaces",
      "call#with#hash",
    ];

    console.log("═══ Test Suite: Invalid Tool ID Handling ═══\n");

    for (const invalidId of INVALID_TOOL_IDS) {
      await runTest(`Tool ID "${invalidId}" should be sanitized`, async () => {
        const messages = [
          { role: "user", content: "What is 2+2?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: invalidId,
                type: "function",
                function: {
                  name: "calculator",
                  arguments: JSON.stringify({ a: 2, b: 2 }),
                },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: invalidId,
            content: "4",
          },
          { role: "user", content: "Thanks, what was the result?" },
        ];

        const response = await fetch(`http://127.0.0.1:${TEST_PORT}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "auto",
            messages,
            max_tokens: 20,
            stream: false,
          }),
        });

        const text = await response.text();

        // Check for the specific Anthropic pattern error
        if (
          text.includes("tool_use.id") &&
          text.includes("pattern") &&
          text.includes("should match")
        ) {
          throw new Error(`Tool ID pattern error not fixed! Response: ${text.slice(0, 200)}`);
        }

        if (response.status !== 200) {
          // Check if it's a different error (not the pattern error)
          if (response.status === 400) {
            const parsed = JSON.parse(text);
            const errorMsg = parsed.error?.message || parsed.error || text;
            // If it's a pattern error, fail
            if (errorMsg.includes("pattern") && errorMsg.includes("tool_use")) {
              throw new Error(`Pattern validation failed: ${errorMsg}`);
            }
            // Other 400 errors might be OK (e.g., model-specific issues)
            console.log(`    ⚠ Got 400 but not pattern error: ${errorMsg.slice(0, 100)}`);
          } else if (response.status !== 200) {
            throw new Error(`Unexpected status ${response.status}: ${text.slice(0, 200)}`);
          }
        }
      });
    }

    // Test with content block format (Anthropic-style)
    console.log("\n═══ Test: Content Block Format ═══\n");

    await runTest("Anthropic-style content blocks with invalid IDs", async () => {
      const messages = [
        { role: "user", content: "Hello" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu:01:invalid/id",
              name: "test_tool",
              input: { query: "test" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu:01:invalid/id",
              content: "result",
            },
          ],
        },
        { role: "user", content: "What happened?" },
      ];

      const response = await fetch(`http://127.0.0.1:${TEST_PORT}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "auto",
          messages,
          max_tokens: 20,
          stream: false,
        }),
      });

      const text = await response.text();

      if (
        text.includes("tool_use.id") &&
        text.includes("pattern") &&
        text.includes("should match")
      ) {
        throw new Error(`Content block tool ID not sanitized: ${text.slice(0, 200)}`);
      }

      // 200 or non-pattern 400 is acceptable
      if (response.status !== 200 && response.status !== 400) {
        throw new Error(`Unexpected status ${response.status}`);
      }
    });

    // Test with valid IDs (should pass through unchanged)
    console.log("\n═══ Test: Valid Tool IDs (Passthrough) ═══\n");

    await runTest("Valid tool IDs should work unchanged", async () => {
      const validId = "call_valid_id_123-abc";
      const messages = [
        { role: "user", content: "Add 1+1" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: validId,
              type: "function",
              function: {
                name: "add",
                arguments: JSON.stringify({ a: 1, b: 1 }),
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: validId,
          content: "2",
        },
        { role: "user", content: "Result?" },
      ];

      const response = await fetch(`http://127.0.0.1:${TEST_PORT}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "auto",
          messages,
          max_tokens: 20,
          stream: false,
        }),
      });

      if (response.status !== 200) {
        const text = await response.text();
        throw new Error(`Expected 200, got ${response.status}: ${text.slice(0, 200)}`);
      }
    });
  } finally {
    if (proxy) {
      console.log("\nClosing proxy...");
      await proxy.close();
    }
  }

  // Summary
  console.log("\n═══════════════════════════════════════════════════════════════");
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(`Total: ${results.length} tests`);
  console.log(`✓ Passed: ${passed}`);
  console.log(`✗ Failed: ${failed}`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  if (failed > 0) {
    console.log("Failed tests:");
    results.filter((r) => !r.passed).forEach((r) => console.log(`  - ${r.name}: ${r.error}`));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
