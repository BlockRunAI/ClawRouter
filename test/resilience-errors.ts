/**
 * Resilience Error Simulation Tests
 *
 * Tests that the proxy survives error scenarios that previously caused crashes:
 * - EPIPE (client disconnect during write)
 * - ECONNRESET (socket reset during request)
 * - Client timeout (request exceeds window)
 * - Malformed HTTP (clientError handler)
 * - Memory pressure (concurrent large requests)
 *
 * Usage:
 *   BLOCKRUN_WALLET_KEY=0x... tsx test/resilience-errors.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Socket } from "node:net";
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
    // Simple mock response for /v1/chat/completions
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

  // Start proxy pointing to mock server
  const proxy = await startProxy({
    walletKey: TEST_WALLET,
    apiBase: `http://127.0.0.1:${mockPort}`,
    skipBalanceCheck: true,
  });

  return { mockServer, mockPort, proxy };
}

async function teardownTestEnvironment(ctx: TestContext): Promise<void> {
  await ctx.proxy.close();
  await new Promise<void>((resolve) => ctx.mockServer.close(() => resolve()));
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 1: EPIPE Error (Client Disconnect During Write)
// ═══════════════════════════════════════════════════════════════════════════

async function testEpipeError(ctx: TestContext): Promise<void> {
  console.log("\n═══ Test 1: EPIPE Error (Client Disconnect) ═══\n");

  try {
    // Start streaming request
    const controller = new AbortController();
    const req = fetch(`${ctx.proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek/deepseek-chat",
        messages: [{ role: "user", content: "test" }],
        stream: true,
      }),
      signal: controller.signal,
    });

    // Kill client after 50ms (mid-stream)
    await sleep(50);
    controller.abort();
    await req.catch(() => {}); // Expected to fail

    // Wait for cleanup
    await sleep(100);

    // Verify proxy still operational
    const health = await fetch(`${ctx.proxy.baseUrl}/health`);
    assert(health.ok, "Proxy survived client disconnect (EPIPE)");
  } catch (err) {
    assert(false, `EPIPE test failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 2: ECONNRESET Error (Socket Reset)
// ═══════════════════════════════════════════════════════════════════════════

async function testEconnreset(ctx: TestContext): Promise<void> {
  console.log("\n═══ Test 2: ECONNRESET Error (Socket Reset) ═══\n");

  // Create a mock server that resets connection mid-response
  const resetServer = createServer((req, res) => {
    // Start sending response then reset socket
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"test":');
    setTimeout(() => {
      (res as any).socket.destroy(); // Force socket reset
    }, 20);
  });

  await new Promise<void>((resolve) => {
    resetServer.listen(0, "127.0.0.1", () => resolve());
  });

  const resetPort = (resetServer.address() as { port: number }).port;

  // Create proxy pointing to reset server
  const resetProxy = await startProxy({
    walletKey: TEST_WALLET,
    apiBase: `http://127.0.0.1:${resetPort}`,
    skipBalanceCheck: true,
  });

  try {
    // Make request that will be reset
    await fetch(`${resetProxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek/deepseek-chat",
        messages: [{ role: "user", content: "test" }],
      }),
    }).catch(() => {}); // Expected to fail

    // Wait for cleanup
    await sleep(100);

    // Verify proxy recovered
    const health = await fetch(`${resetProxy.baseUrl}/health`);
    assert(health.ok, "Proxy recovered after ECONNRESET");
  } catch (err) {
    assert(false, `ECONNRESET test failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await resetProxy.close();
    await new Promise<void>((resolve) => resetServer.close(() => resolve()));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 3: Client Timeout
// ═══════════════════════════════════════════════════════════════════════════

async function testClientTimeout(ctx: TestContext): Promise<void> {
  console.log("\n═══ Test 3: Client Timeout ═══\n");

  // Create a slow mock server
  const slowServer = createServer((req, res) => {
    // Never respond - let client timeout
    req.on("data", () => {});
    req.on("end", () => {
      // Don't send response - let it hang
    });
  });

  await new Promise<void>((resolve) => {
    slowServer.listen(0, "127.0.0.1", () => resolve());
  });

  const slowPort = (slowServer.address() as { port: number }).port;

  const slowProxy = await startProxy({
    walletKey: TEST_WALLET,
    apiBase: `http://127.0.0.1:${slowPort}`,
    skipBalanceCheck: true,
    requestTimeoutMs: 1000, // 1s timeout
  });

  try {
    // Client with 500ms timeout (will timeout before proxy's 1s)
    await fetch(`${slowProxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek/deepseek-chat",
        messages: [{ role: "user", content: "test" }],
      }),
      signal: AbortSignal.timeout(500),
    }).catch(() => {}); // Expected timeout

    // Wait for cleanup
    await sleep(100);

    // Verify proxy recovered
    const health = await fetch(`${slowProxy.baseUrl}/health`);
    assert(health.ok, "Proxy survived client timeout");
  } catch (err) {
    assert(false, `Timeout test failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await slowProxy.close();
    await new Promise<void>((resolve) => slowServer.close(() => resolve()));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 4: Malformed HTTP (clientError Handler)
// ═══════════════════════════════════════════════════════════════════════════

async function testMalformedHttp(ctx: TestContext): Promise<void> {
  console.log("\n═══ Test 4: Malformed HTTP ═══\n");

  try {
    const socket = new Socket();
    await new Promise<void>((resolve, reject) => {
      socket.connect(ctx.proxy.port, "127.0.0.1", () => {
        socket.write("GET ??? HTTP/1.1\r\n");
        socket.write("Content-Length: abc\r\n\r\n"); // Invalid header
        socket.destroy();
        resolve();
      });
      socket.on("error", reject);
    });

    await sleep(200);

    const health = await fetch(`${ctx.proxy.baseUrl}/health`);
    assert(health.ok, "Proxy survived malformed HTTP request");
  } catch (err) {
    assert(
      false,
      `Malformed HTTP test failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 5: Memory Pressure (Concurrent Large Requests)
// ═══════════════════════════════════════════════════════════════════════════

async function testMemoryPressure(ctx: TestContext): Promise<void> {
  console.log("\n═══ Test 5: Memory Pressure (Concurrent Large Requests) ═══\n");

  try {
    // Send 20 concurrent requests with 100KB payloads
    const promises = Array.from({ length: 20 }).map(() =>
      fetch(`${ctx.proxy.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "deepseek/deepseek-chat",
          messages: [{ role: "user", content: "x".repeat(100_000) }], // 100KB
        }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => null),
    );

    await Promise.all(promises);
    await sleep(100);

    const health = await fetch(`${ctx.proxy.baseUrl}/health`);
    assert(health.ok, "Proxy survived memory pressure (20x 100KB concurrent requests)");
  } catch (err) {
    assert(
      false,
      `Memory pressure test failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Main Test Runner
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║         ClawRouter Resilience Error Simulation Tests          ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");

  const ctx = await setupTestEnvironment();

  try {
    await testEpipeError(ctx);
    await testEconnreset(ctx);
    await testClientTimeout(ctx);
    await testMalformedHttp(ctx);
    await testMemoryPressure(ctx);
  } finally {
    await teardownTestEnvironment(ctx);
  }

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
