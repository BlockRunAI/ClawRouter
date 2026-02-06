/**
 * Unit tests for retry logic.
 *
 * Tests:
 *   1. Successful request on first try
 *   2. Retry on 502 and eventually succeed
 *   3. Retry on 429 with Retry-After header
 *   4. Max retries exhausted
 *   5. Network error retry
 *   6. isRetryable helper
 *
 * Usage:
 *   npx tsx test-retry.ts
 */

import { fetchWithRetry, isRetryable, DEFAULT_RETRY_CONFIG } from "./src/retry.js";

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

// Mock fetch that can be configured to fail N times before succeeding
function createMockFetch(options: {
  failCount?: number;
  failStatus?: number;
  failHeaders?: Record<string, string>;
  successBody?: string;
  throwError?: boolean;
}) {
  let callCount = 0;
  const failCount = options.failCount ?? 0;
  const failStatus = options.failStatus ?? 502;
  const failHeaders = options.failHeaders ?? {};
  const successBody = options.successBody ?? '{"status":"ok"}';

  return async (_url: string, _init?: RequestInit): Promise<Response> => {
    callCount++;

    if (options.throwError && callCount <= failCount) {
      throw new Error("Network error: ECONNRESET");
    }

    if (callCount <= failCount) {
      return new Response(`Error ${failStatus}`, {
        status: failStatus,
        headers: failHeaders,
      });
    }

    return new Response(successBody, { status: 200 });
  };
}

async function main() {
  console.log("\n=== Retry Logic Tests ===\n");

  // --- Basic behavior ---
  console.log("Basic Behavior:");

  await test("Successful request on first try (no retries needed)", async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      return new Response('{"ok":true}', { status: 200 });
    };

    const response = await fetchWithRetry(mockFetch, "https://example.com/api");

    assertEqual(response.status, 200, "Should return 200");
    assertEqual(callCount, 1, "Should only call fetch once");
  });

  await test("Non-retryable error (404) returns immediately", async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      return new Response("Not found", { status: 404 });
    };

    const response = await fetchWithRetry(mockFetch, "https://example.com/api");

    assertEqual(response.status, 404, "Should return 404");
    assertEqual(callCount, 1, "Should only call fetch once");
  });

  // --- Retry behavior ---
  console.log("\nRetry Behavior:");

  await test("Retries on 502 and succeeds on second attempt", async () => {
    const mockFetch = createMockFetch({ failCount: 1, failStatus: 502 });

    const start = Date.now();
    const response = await fetchWithRetry(mockFetch, "https://example.com/api", undefined, {
      baseDelayMs: 50, // Fast for testing
    });
    const elapsed = Date.now() - start;

    assertEqual(response.status, 200, "Should eventually succeed");
    assert(elapsed >= 50, "Should have waited at least baseDelayMs");
  });

  await test("Retries on 503 and succeeds on third attempt", async () => {
    const mockFetch = createMockFetch({ failCount: 2, failStatus: 503 });

    const response = await fetchWithRetry(mockFetch, "https://example.com/api", undefined, {
      baseDelayMs: 10,
      maxRetries: 2,
    });

    assertEqual(response.status, 200, "Should eventually succeed");
  });

  await test("Retries on 504 (gateway timeout)", async () => {
    const mockFetch = createMockFetch({ failCount: 1, failStatus: 504 });

    const response = await fetchWithRetry(mockFetch, "https://example.com/api", undefined, {
      baseDelayMs: 10,
    });

    assertEqual(response.status, 200, "Should succeed after retry");
  });

  await test("Retries on 429 (rate limit)", async () => {
    const mockFetch = createMockFetch({ failCount: 1, failStatus: 429 });

    const response = await fetchWithRetry(mockFetch, "https://example.com/api", undefined, {
      baseDelayMs: 10,
    });

    assertEqual(response.status, 200, "Should succeed after retry");
  });

  await test("Respects Retry-After header", async () => {
    const mockFetch = createMockFetch({
      failCount: 1,
      failStatus: 429,
      failHeaders: { "retry-after": "1" }, // 1 second
    });

    const start = Date.now();
    const response = await fetchWithRetry(mockFetch, "https://example.com/api", undefined, {
      baseDelayMs: 10, // Would be 10ms without Retry-After
    });
    const elapsed = Date.now() - start;

    assertEqual(response.status, 200, "Should succeed");
    assert(elapsed >= 900, `Should have waited ~1s (Retry-After), got ${elapsed}ms`);
  });

  // --- Max retries ---
  console.log("\nMax Retries:");

  await test("Returns last response when max retries exhausted", async () => {
    const mockFetch = createMockFetch({ failCount: 10, failStatus: 502 }); // Always fails

    const response = await fetchWithRetry(mockFetch, "https://example.com/api", undefined, {
      baseDelayMs: 10,
      maxRetries: 2,
    });

    assertEqual(response.status, 502, "Should return last failed response");
  });

  await test("Throws error when max retries exhausted on network error", async () => {
    const mockFetch = createMockFetch({ failCount: 10, throwError: true });

    let errorThrown = false;
    try {
      await fetchWithRetry(mockFetch, "https://example.com/api", undefined, {
        baseDelayMs: 10,
        maxRetries: 2,
      });
    } catch (err) {
      errorThrown = true;
      assert(err instanceof Error, "Should throw Error");
      assert(err.message.includes("ECONNRESET"), "Should include original error message");
    }

    assert(errorThrown, "Should have thrown an error");
  });

  // --- Network errors ---
  console.log("\nNetwork Errors:");

  await test("Retries on network error and succeeds", async () => {
    const mockFetch = createMockFetch({ failCount: 1, throwError: true });

    const response = await fetchWithRetry(mockFetch, "https://example.com/api", undefined, {
      baseDelayMs: 10,
    });

    assertEqual(response.status, 200, "Should succeed after retry");
  });

  // --- isRetryable helper ---
  console.log("\nisRetryable Helper:");

  await test("isRetryable returns true for 502 response", () => {
    const response = new Response("Bad Gateway", { status: 502 });
    assert(isRetryable(response), "502 should be retryable");
  });

  await test("isRetryable returns true for 429 response", () => {
    const response = new Response("Rate Limited", { status: 429 });
    assert(isRetryable(response), "429 should be retryable");
  });

  await test("isRetryable returns false for 200 response", () => {
    const response = new Response("OK", { status: 200 });
    assert(!isRetryable(response), "200 should not be retryable");
  });

  await test("isRetryable returns false for 404 response", () => {
    const response = new Response("Not Found", { status: 404 });
    assert(!isRetryable(response), "404 should not be retryable");
  });

  await test("isRetryable returns true for network error", () => {
    const error = new Error("Network error: ECONNRESET");
    assert(isRetryable(error), "Network error should be retryable");
  });

  await test("isRetryable returns true for timeout error", () => {
    const error = new Error("Request timeout");
    assert(isRetryable(error), "Timeout error should be retryable");
  });

  await test("isRetryable returns false for generic error", () => {
    const error = new Error("JSON parse error");
    assert(!isRetryable(error), "Generic error should not be retryable");
  });

  // --- Config ---
  console.log("\nConfiguration:");

  await test("DEFAULT_RETRY_CONFIG has expected values", () => {
    assertEqual(DEFAULT_RETRY_CONFIG.maxRetries, 2, "maxRetries should be 2");
    assertEqual(DEFAULT_RETRY_CONFIG.baseDelayMs, 500, "baseDelayMs should be 500");
    assert(DEFAULT_RETRY_CONFIG.retryableCodes.includes(429), "Should include 429");
    assert(DEFAULT_RETRY_CONFIG.retryableCodes.includes(502), "Should include 502");
    assert(DEFAULT_RETRY_CONFIG.retryableCodes.includes(503), "Should include 503");
    assert(DEFAULT_RETRY_CONFIG.retryableCodes.includes(504), "Should include 504");
  });

  await test("Custom retryable codes work", async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      return new Response("I'm a teapot", { status: 418 });
    };

    const response = await fetchWithRetry(mockFetch, "https://example.com/api", undefined, {
      baseDelayMs: 10,
      maxRetries: 2,
      retryableCodes: [418], // Custom: treat 418 as retryable
    });

    assertEqual(response.status, 418, "Should return 418");
    assertEqual(callCount, 3, "Should have retried twice (3 total calls)");
  });

  // --- Summary ---
  console.log(`\n=== ${failed === 0 ? "ALL TESTS PASSED" : "SOME TESTS FAILED"} (${passed} passed, ${failed} failed) ===\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
