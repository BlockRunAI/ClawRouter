/**
 * Resilience Long-Running Stability Tests
 *
 * Tests proxy stability over extended periods:
 * - Production load simulation (configurable duration)
 * - Memory leak detection
 *
 * Usage:
 *   # Quick 5-minute test
 *   BLOCKRUN_WALLET_KEY=0x... DURATION_MINUTES=5 tsx test/resilience-stability.ts
 *
 *   # Full 4-hour production test
 *   BLOCKRUN_WALLET_KEY=0x... DURATION_MINUTES=240 tsx test/resilience-stability.ts
 *
 *   # Memory leak test with GC
 *   BLOCKRUN_WALLET_KEY=0x... node --expose-gc -r tsx/cjs test/resilience-stability.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { startProxy, type ProxyHandle } from "../src/proxy.js";

// Test wallet (Hardhat test account #0)
const TEST_WALLET = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

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
        const parsed = JSON.parse(body) as { stream?: boolean };
        if (parsed.stream) {
          // SSE streaming response
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write(
            'data: {"id":"test","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant"},"index":0,"finish_reason":null}]}\n\n',
          );
          res.write(
            'data: {"id":"test","object":"chat.completion.chunk","choices":[{"delta":{"content":"Test"},"index":0,"finish_reason":null}]}\n\n',
          );
          res.write(
            'data: {"id":"test","object":"chat.completion.chunk","choices":[{"delta":{},"index":0,"finish_reason":"stop"}]}\n\n',
          );
          res.write("data: [DONE]\n\n");
          res.end();
        } else {
          // Regular JSON response
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
        }
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
// Test 1: Long-Running Stability (Production Load Simulation)
// ═══════════════════════════════════════════════════════════════════════════

async function testLongRunningStability(ctx: TestContext, durationMinutes: number): Promise<void> {
  console.log(`\n═══ Production Load Simulation (${durationMinutes} minutes) ═══\n`);

  const startTime = Date.now();
  const endTime = startTime + durationMinutes * 60 * 1000;
  let requestCount = 0;
  let errorCount = 0;
  let lastLogTime = startTime;

  // Heartbeat every 30s (like OpenClaw)
  const heartbeat = setInterval(async () => {
    try {
      const res = await fetch(`${ctx.proxy.baseUrl}/health`);
      if (!res.ok) {
        errorCount++;
        console.error(`[${new Date().toISOString()}] Health check failed`);
      }
    } catch (err) {
      errorCount++;
      console.error(`[${new Date().toISOString()}] Health check error:`, err);
    }
  }, 30_000);

  console.log(`Test will run until ${new Date(endTime).toISOString()}`);
  console.log("Sending ~1 request/sec with mix of streaming and non-streaming...\n");

  // Main load: ~1 request/sec, mix of streaming and non-streaming
  while (Date.now() < endTime) {
    try {
      const response = await fetch(`${ctx.proxy.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: ["deepseek/deepseek-chat", "google/gemini-2.5-flash"][requestCount % 2],
          messages: [{ role: "user", content: `Test request ${requestCount}` }],
          stream: Math.random() > 0.5,
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        errorCount++;
      } else {
        // Consume response body
        await response.text();
      }
    } catch (err) {
      errorCount++;
      // Don't log individual errors during long test - they clutter output
    }

    requestCount++;
    await sleep(1000);

    // Log progress every 60 seconds
    const now = Date.now();
    if (now - lastLogTime >= 60_000) {
      const elapsedMin = Math.round((now - startTime) / 60000);
      const remainingMin = Math.round((endTime - now) / 60000);
      const errorRate = ((errorCount / requestCount) * 100).toFixed(2);
      const heapMB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);

      console.log(
        `[${elapsedMin}m elapsed, ${remainingMin}m remaining] ${requestCount} requests, ${errorCount} errors (${errorRate}%), heap: ${heapMB} MB`,
      );
      lastLogTime = now;
    }
  }

  clearInterval(heartbeat);

  // Final stats
  const totalMinutes = Math.round((Date.now() - startTime) / 60000);
  const errorRate = ((errorCount / requestCount) * 100).toFixed(2);
  const avgReqPerMin = (requestCount / totalMinutes).toFixed(1);

  console.log("\n─────────────────────────────────────────────────────");
  console.log(`Duration: ${totalMinutes} minutes`);
  console.log(`Total requests: ${requestCount} (${avgReqPerMin}/min)`);
  console.log(`Errors: ${errorCount} (${errorRate}%)`);
  console.log(`Final heap: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB`);
  console.log("─────────────────────────────────────────────────────\n");

  // Verify error rate is acceptable (< 5%)
  if (parseFloat(errorRate) >= 5) {
    throw new Error(`Error rate too high: ${errorRate}% (threshold: 5%)`);
  }

  console.log(`✓ Proxy survived ${totalMinutes}-minute load test with ${errorRate}% error rate`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 2: Memory Leak Detection
// ═══════════════════════════════════════════════════════════════════════════

async function testMemoryLeaks(ctx: TestContext): Promise<void> {
  console.log("\n═══ Memory Leak Detection ═══\n");

  const snapshots: number[] = [];
  const iterations = 1000;

  console.log(`Running ${iterations} requests and monitoring heap growth...`);

  for (let i = 0; i < iterations; i++) {
    await fetch(`${ctx.proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek/deepseek-chat",
        messages: [{ role: "user", content: `test ${i}` }],
      }),
    })
      .then((r) => r.text())
      .catch(() => {});

    // Take heap snapshot every 100 requests
    if (i % 100 === 0) {
      if (global.gc) global.gc();
      await sleep(100); // Let GC settle
      snapshots.push(process.memoryUsage().heapUsed);
      console.log(
        `[${i}/${iterations}] Heap: ${(snapshots[snapshots.length - 1] / 1024 / 1024).toFixed(2)} MB`,
      );
    }
  }

  const initialHeap = snapshots[0];
  const finalHeap = snapshots[snapshots.length - 1];
  const growthMB = (finalHeap - initialHeap) / 1024 / 1024;

  console.log("\n─────────────────────────────────────────────────────");
  console.log(`Initial heap: ${(initialHeap / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Final heap:   ${(finalHeap / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Growth:       ${growthMB.toFixed(2)} MB`);
  console.log("─────────────────────────────────────────────────────\n");

  // Verify memory growth is acceptable (< 500MB)
  if (growthMB >= 500) {
    throw new Error(`Excessive memory growth: ${growthMB.toFixed(2)} MB (threshold: 500 MB)`);
  }

  console.log(`✓ Memory leak test passed (growth: ${growthMB.toFixed(2)} MB)`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Main Test Runner
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║       ClawRouter Resilience Long-Running Stability Tests       ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");

  const durationMinutes = parseInt(process.env.DURATION_MINUTES || "5", 10);
  const runMemoryTest = process.env.MEMORY_TEST === "true" || global.gc !== undefined;

  console.log(`\nConfiguration:`);
  console.log(`- Duration: ${durationMinutes} minutes`);
  console.log(`- Memory test: ${runMemoryTest ? "enabled" : "disabled"}`);

  const ctx = await setupTestEnvironment();

  try {
    await testLongRunningStability(ctx, durationMinutes);

    if (runMemoryTest) {
      await testMemoryLeaks(ctx);
    } else {
      console.log("\nSkipping memory leak test (run with node --expose-gc to enable)\n");
    }
  } finally {
    await ctx.proxy.close();
    await new Promise<void>((resolve) => ctx.mockServer.close(() => resolve()));
  }

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("✓ All stability tests passed!");
  console.log("═══════════════════════════════════════════════════════════════\n");
}

main().catch((err) => {
  console.error("\n✗ Stability test failed:", err);
  process.exit(1);
});
