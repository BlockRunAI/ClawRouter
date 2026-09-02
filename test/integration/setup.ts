/**
 * Integration test setup — programmatically starts ClawRouter proxy.
 *
 * Shared across all integration test files via beforeAll/afterAll.
 * Starts the proxy on a worker-scoped port, waits for /health to return 200,
 * and caches the handle so test files in the same worker share one instance.
 */

import { startProxy } from "../../src/proxy.js";
import { resolveOrGenerateWalletKey } from "../../src/auth.js";
import type { ProxyHandle } from "../../src/proxy.js";

const HEALTH_POLL_INTERVAL_MS = 200;
const HEALTH_TIMEOUT_MS = 5_000;

let proxyHandle: ProxyHandle | undefined;

function getTestPort(): number {
  const explicit = Number.parseInt(process.env.CLAWROUTER_TEST_PORT ?? "", 10);
  if (Number.isInteger(explicit) && explicit >= 1024 && explicit <= 65535) return explicit;

  // Never use the production default (8402): a developer may have the real
  // desktop proxy running while tests execute. PID + worker keeps Vitest fork
  // pools isolated without a shared fixed-port collision.
  const workerRaw = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? "1";
  const workerId = Number.parseInt(workerRaw, 10);
  return 20_000 + ((process.pid * 37 + (Number.isInteger(workerId) ? workerId : 1)) % 30_000);
}

/**
 * Start the test proxy on a worker-scoped port.
 * Polls /health until it returns 200 (up to 5s), then returns the handle.
 * Reuses an existing handle if already started.
 */
export async function startTestProxy(): Promise<ProxyHandle> {
  if (proxyHandle) return proxyHandle;

  const wallet = await resolveOrGenerateWalletKey();
  const testPort = getTestPort();

  proxyHandle = await startProxy({
    wallet,
    port: testPort,
    skipBalanceCheck: true,
  });

  // Wait for /health to return 200
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${proxyHandle.baseUrl}/health`);
      if (res.ok) return proxyHandle;
    } catch {
      // proxy not ready yet
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
  }

  throw new Error(`Test proxy did not become healthy within ${HEALTH_TIMEOUT_MS}ms`);
}

/**
 * Stop the test proxy and clear the cached handle.
 */
export async function stopTestProxy(): Promise<void> {
  if (!proxyHandle) return;
  await proxyHandle.close();
  proxyHandle = undefined;
}

/**
 * Get the base URL of the running test proxy.
 * Throws if the proxy has not been started.
 */
export function getTestProxyUrl(): string {
  if (!proxyHandle) throw new Error("Test proxy not started — call startTestProxy() first");
  return proxyHandle.baseUrl;
}
