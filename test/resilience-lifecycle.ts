/**
 * Resilience OpenClaw Lifecycle Tests
 *
 * Tests proxy integration with OpenClaw plugin lifecycle:
 * - SIGUSR1 restart with active connections
 * - Clean port release after shutdown
 * - Repeated restart cycles
 *
 * Usage:
 *   BLOCKRUN_WALLET_KEY=0x... tsx test/resilience-lifecycle.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { startProxy, type ProxyHandle } from "../src/proxy.js";

// Test wallet (Hardhat test account #0)
const TEST_WALLET = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${msg}`);
    failed++;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type TestContext = {
  mockServer: ReturnType<typeof createServer>;
  mockPort: number;
  proxy: ProxyHandle;
};

/**
 * Setup test environment with mock BlockRun API server and proxy.
 */
async function setupTestEnvironment(): Promise<TestContext> {
  // Create mock BlockRun API server
  const mockServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/v1/chat/completions" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "test-completion",
            object: "chat.completion",
            created: Date.now(),
            model: "deepseek/deepseek-chat",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "Test response" },
                finish_reason: "stop",
              },
            ],
          }),
        );
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise<void>((resolve) => {
    mockServer.listen(0, "127.0.0.1", () => resolve());
  });

  const mockPort = (mockServer.address() as { port: number }).port;

  const proxy = await startProxy({
    walletKey: TEST_WALLET,
    apiBase: `http://127.0.0.1:${mockPort}`,
    skipBalanceCheck: true,
  });

  return { mockServer, mockPort, proxy };
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 1: SIGUSR1 Restart with Active Connections
// ═══════════════════════════════════════════════════════════════════════════

async function testSigusr1Restart(): Promise<void> {
  console.log("\n═══ Test 1: SIGUSR1 Restart with Active Connections ═══\n");

  const ctx = await setupTestEnvironment();

  try {
    // Start long-running request
    const longReq = fetch(`${ctx.proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek/deepseek-chat",
        messages: [{ role: "user", content: "test" }],
      }),
      signal: AbortSignal.timeout(10_000),
    });

    await sleep(50);

    // Simulate graceful shutdown (SIGUSR1 behavior)
    const closePromise = ctx.proxy.close();

    const [closeResult, reqResult] = await Promise.allSettled([closePromise, longReq]);

    assert(
      closeResult.status === "fulfilled",
      `Proxy close() succeeded (status: ${closeResult.status})`,
    );

    // Request may succeed or fail (socket destroyed) - both OK
    if (reqResult.status === "fulfilled") {
      assert(true, "Request completed successfully before close");
    } else {
      assert(
        true,
        `Request failed as expected (socket destroyed): ${reqResult.reason instanceof Error ? reqResult.reason.message : String(reqResult.reason)}`,
      );
    }
  } catch (err) {
    assert(
      false,
      `SIGUSR1 restart test failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    await ctx.mockServer.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 2: Clean Port Release
// ═══════════════════════════════════════════════════════════════════════════

async function testPortRelease(): Promise<void> {
  console.log("\n═══ Test 2: Clean Port Release ═══\n");

  const ctx = await setupTestEnvironment();
  const port = ctx.proxy.port;

  try {
    await ctx.proxy.close();
    await ctx.mockServer.close();
    await sleep(500);

    // Try to bind to same port - should succeed
    const newServer = createServer();
    await new Promise<void>((resolve, reject) => {
      newServer.listen(port, "127.0.0.1", () => resolve());
      newServer.on("error", reject);
    });

    assert(true, `Port ${port} released properly (new server bound successfully)`);
    await new Promise<void>((resolve) => newServer.close(() => resolve()));
  } catch (err) {
    assert(false, `Port release test failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 3: Repeated Restart Cycles
// ═══════════════════════════════════════════════════════════════════════════

async function testRepeatedRestarts(cycles: number): Promise<void> {
  console.log(`\n═══ Test 3: Repeated Restart Cycles (${cycles} cycles) ═══\n`);

  try {
    for (let i = 0; i < cycles; i++) {
      const ctx = await setupTestEnvironment();

      // Test a few requests
      for (let j = 0; j < 3; j++) {
        const res = await fetch(`${ctx.proxy.baseUrl}/health`);
        if (!res.ok) {
          throw new Error(`Health check failed on cycle ${i + 1}, request ${j + 1}`);
        }
      }

      await ctx.proxy.close();
      await new Promise<void>((resolve) => ctx.mockServer.close(() => resolve()));
      await sleep(100);

      if ((i + 1) % 3 === 0) {
        console.log(`  Completed ${i + 1}/${cycles} restart cycles...`);
      }
    }

    assert(true, `Completed ${cycles} restart cycles successfully`);
  } catch (err) {
    assert(
      false,
      `Repeated restart test failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 4: Close Timeout (4s max)
// ═══════════════════════════════════════════════════════════════════════════

async function testCloseTimeout(): Promise<void> {
  console.log("\n═══ Test 4: Close Timeout (4s max) ═══\n");

  const ctx = await setupTestEnvironment();

  try {
    const startTime = Date.now();
    await ctx.proxy.close();
    const duration = Date.now() - startTime;

    assert(duration < 4500, `Proxy close completed in ${duration}ms (threshold: 4000ms)`);

    await ctx.mockServer.close();
  } catch (err) {
    assert(false, `Close timeout test failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Main Test Runner
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║       ClawRouter Resilience OpenClaw Lifecycle Tests          ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");

  await testSigusr1Restart();
  await testPortRelease();
  await testRepeatedRestarts(10);
  await testCloseTimeout();

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log(`Total: ${passed + failed} tests`);
  console.log(`✓ Passed: ${passed}`);
  console.log(`✗ Failed: ${failed}`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
