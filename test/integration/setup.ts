/**
 * Integration test setup — programmatically starts ClawRouter proxy.
 *
 * Shared across all integration test files via beforeAll/afterAll.
 * Starts the proxy on port 8402, waits for /health to return 200,
 * and caches the handle so multiple test files share one instance.
 */

import { startProxy } from "../../src/proxy.js";
import { resolveOrGenerateWalletKey } from "../../src/auth.js";
import type { ProxyHandle } from "../../src/proxy.js";

const TEST_PORT = 8402;
const HEALTH_POLL_INTERVAL_MS = 200;
const HEALTH_TIMEOUT_MS = 5_000;

let proxyHandle: ProxyHandle | undefined;

/**
 * Start the test proxy on port 8402.
 * Polls /health until it returns 200 (up to 5s), then returns the handle.
 * Reuses an existing handle if already started.
 */
export async function startTestProxy(): Promise<ProxyHandle> {
  if (proxyHandle) return proxyHandle;

  const wallet = await resolveOrGenerateWalletKey();

  proxyHandle = await startProxy({
    walletKey: wallet.key,
    port: TEST_PORT,
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
 * Get the base URL of the running test proxy (e.g. http://127.0.0.1:8402).
 * Throws if the proxy has not been started.
 */
export function getTestProxyUrl(): string {
  if (!proxyHandle) throw new Error("Test proxy not started — call startTestProxy() first");
  return proxyHandle.baseUrl;
}
