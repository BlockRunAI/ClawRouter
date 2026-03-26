/**
 * E2E test for exclude-models feature.
 *
 * Starts its own proxy instance with excludeModels set, sends real chat
 * requests through it, and verifies excluded models are never attempted.
 *
 * Does NOT require a funded wallet — we only check which models the proxy
 * tries (via console.log capture), not whether the request succeeds.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { startProxy } from "../../src/proxy.js";
import { resolveOrGenerateWalletKey } from "../../src/auth.js";
import type { ProxyHandle } from "../../src/proxy.js";
import { DEFAULT_ROUTING_CONFIG } from "../../src/router/config.js";
import { getFallbackChain } from "../../src/router/selector.js";

const HEALTH_POLL_INTERVAL_MS = 200;
const HEALTH_TIMEOUT_MS = 5_000;

// Use a unique port to avoid collision with other integration tests
const TEST_PORT = 8490;

describe("exclude-models e2e", () => {
  let proxy: ProxyHandle;
  let baseUrl: string;
  const consoleLogs: string[] = [];
  let originalLog: typeof console.log;

  // Models to exclude for this test
  const EXCLUDED_MODELS = new Set(["free/gpt-oss-120b", "google/gemini-2.5-flash-lite"]);

  beforeAll(async () => {
    // Capture console.log to inspect which models the proxy tries
    originalLog = console.log;
    console.log = (...args: unknown[]) => {
      const msg = args.map(String).join(" ");
      consoleLogs.push(msg);
      originalLog(...args);
    };

    const wallet = await resolveOrGenerateWalletKey();
    proxy = await startProxy({
      wallet,
      port: TEST_PORT,
      skipBalanceCheck: true,
      excludeModels: EXCLUDED_MODELS,
    });
    baseUrl = proxy.baseUrl;

    // Wait for /health
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${baseUrl}/health`);
        if (res.ok) break;
      } catch {
        // not ready
      }
      await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
    }
  });

  afterAll(async () => {
    console.log = originalLog;
    if (proxy) await proxy.close();
  });

  it("exclude filter log appears for excluded models in eco SIMPLE tier", async () => {
    // Verify excluded models ARE in the unfiltered eco SIMPLE chain
    const ecoSimpleChain = getFallbackChain("SIMPLE", DEFAULT_ROUTING_CONFIG.ecoTiers!);
    expect(ecoSimpleChain).toContain("free/gpt-oss-120b");

    consoleLogs.length = 0;

    // Send a simple request via eco profile (SIMPLE tier)
    // This will fail (no funds) but we can check the logs
    await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "blockrun/eco",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 10,
      }),
    }).catch(() => {});

    // Wait a bit for logs to flush
    await new Promise((r) => setTimeout(r, 500));

    // Check that the exclude filter log appeared
    const excludeFilterLogs = consoleLogs.filter((l) => l.includes("[ClawRouter] Exclude filter:"));
    expect(excludeFilterLogs.length).toBeGreaterThan(0);

    // Check that excluded models appear in the filter log
    const filterLog = excludeFilterLogs[0];
    for (const excluded of EXCLUDED_MODELS) {
      if (ecoSimpleChain.includes(excluded)) {
        expect(filterLog).toContain(excluded);
      }
    }

    // Check that excluded models were NEVER tried
    const tryingLogs = consoleLogs.filter((l) => l.includes("[ClawRouter] Trying model"));
    for (const tryLog of tryingLogs) {
      for (const excluded of EXCLUDED_MODELS) {
        expect(tryLog).not.toContain(excluded);
      }
    }
  }, 30_000);

  it("excluded model is not appended as free fallback", async () => {
    consoleLogs.length = 0;

    // Send a simple (non-tool) request — normally FREE_MODEL would be appended
    await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "blockrun/auto",
        messages: [{ role: "user", content: "what is 1+1" }],
        max_tokens: 10,
      }),
    }).catch(() => {});

    await new Promise((r) => setTimeout(r, 500));

    // nvidia/gpt-oss-120b (FREE_MODEL) should never be tried
    const tryingLogs = consoleLogs.filter((l) => l.includes("[ClawRouter] Trying model"));
    for (const tryLog of tryingLogs) {
      expect(tryLog).not.toContain("free/gpt-oss-120b");
    }
  }, 30_000);

  it("non-excluded models are still tried", async () => {
    consoleLogs.length = 0;

    await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "blockrun/eco",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 10,
      }),
    }).catch(() => {});

    await new Promise((r) => setTimeout(r, 500));

    // At least one model should have been tried
    const tryingLogs = consoleLogs.filter((l) => l.includes("[ClawRouter] Trying model"));
    expect(tryingLogs.length).toBeGreaterThan(0);
  }, 30_000);
});
