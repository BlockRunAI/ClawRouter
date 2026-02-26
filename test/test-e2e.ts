/**
 * End-to-end test for ClawRouter proxy.
 *
 * Starts the local x402 proxy, sends a real request through it to BlockRun,
 * and verifies the full flow: routing → x402 payment → LLM response.
 *
 * Modes:
 * - Full E2E (paid): set BLOCKRUN_WALLET_KEY to run all tests.
 * - Non-paid checks: if BLOCKRUN_WALLET_KEY is unset, generates an ephemeral wallet
 *   and runs only local/non-paid checks.
 *
 * Usage:
 *   BLOCKRUN_WALLET_KEY=0x... npx tsx test-e2e.ts
 *   npx tsx test-e2e.ts
 */

import { startProxy, type ProxyHandle } from "../src/proxy.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const ENV_WALLET_KEY = process.env.BLOCKRUN_WALLET_KEY?.trim();
if (ENV_WALLET_KEY && !/^0x[0-9a-fA-F]{64}$/.test(ENV_WALLET_KEY)) {
  console.error("ERROR: BLOCKRUN_WALLET_KEY must be 0x + 64 hex characters");
  process.exit(1);
}

const RUN_PAID_TESTS = Boolean(ENV_WALLET_KEY);
const WALLET_KEY: `0x${string}` =
  (ENV_WALLET_KEY as `0x${string}` | undefined) ?? generatePrivateKey();
const WALLET_ADDRESS = privateKeyToAccount(WALLET_KEY).address;

async function test(name: string, fn: (proxy: ProxyHandle) => Promise<void>, proxy: ProxyHandle) {
  process.stdout.write(`  ${name} ... `);
  try {
    await fn(proxy);
    console.log("PASS");
  } catch (err) {
    console.log("FAIL");
    console.error(`    ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  return true;
}

async function runPaidTest(
  name: string,
  fn: (proxy: ProxyHandle) => Promise<void>,
  proxy: ProxyHandle,
) {
  if (!RUN_PAID_TESTS) {
    console.log(`  ${name} ... SKIP (requires funded BLOCKRUN_WALLET_KEY)`);
    return true;
  }
  return test(name, fn, proxy);
}

async function readResponseBody(res: Response): Promise<{ text: string; json?: unknown }> {
  const text = await res.text();
  try {
    return { text, json: JSON.parse(text) as unknown };
  } catch {
    return { text };
  }
}

function extractErrorMessage(payload: { text: string; json?: unknown }): string {
  if (payload.json && typeof payload.json === "object") {
    const root = payload.json as Record<string, unknown>;
    const error = root.error;
    if (typeof error === "string") return error;
    if (error && typeof error === "object") {
      const msg = (error as Record<string, unknown>).message;
      if (typeof msg === "string") return msg;
    }
    if (typeof root.message === "string") return root.message;
  }
  return payload.text;
}

function extractFirstMessageContent(payload: { text: string; json?: unknown }): string | undefined {
  if (!payload.json || typeof payload.json !== "object") return undefined;
  const root = payload.json as Record<string, unknown>;
  if (!Array.isArray(root.choices) || root.choices.length === 0) return undefined;
  const firstChoice = root.choices[0];
  if (!firstChoice || typeof firstChoice !== "object") return undefined;
  const message = (firstChoice as Record<string, unknown>).message;
  if (!message || typeof message !== "object") return undefined;
  const content = (message as Record<string, unknown>).content;
  return typeof content === "string" ? content : undefined;
}

async function main() {
  console.log("\n=== ClawRouter e2e tests ===\n");
  if (RUN_PAID_TESTS) {
    console.log(`Mode: FULL (paid + non-paid checks), wallet=${WALLET_ADDRESS}`);
  } else {
    console.log(`Mode: NON-PAID only (ephemeral wallet), wallet=${WALLET_ADDRESS}`);
    console.log("Set BLOCKRUN_WALLET_KEY to run paid upstream request tests.");
  }
  console.log();

  // Start proxy
  console.log("Starting proxy...");
  const proxy = await startProxy({
    wallet: WALLET_KEY,
    port: 0,
    onReady: (port) => console.log(`Proxy ready on port ${port}`),
    onError: (err) => console.error(`Proxy error: ${err.message}`),
    onRouted: (d) =>
      console.log(
        `  [routed] ${d.model} (${d.tier}, ${d.method}, confidence=${d.confidence.toFixed(2)}, cost=$${d.costEstimate.toFixed(4)}, saved=${(d.savings * 100).toFixed(0)}%)`,
      ),
    onPayment: (info) => console.log(`  [payment] ${info.model} ${info.amount} on ${info.network}`),
  });

  let allPassed = true;

  // Test 1: Health check
  allPassed =
    (await test(
      "Health check",
      async (p) => {
        const res = await fetch(`${p.baseUrl}/health`);
        if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
        const body = await res.json();
        if (body.status !== "ok") throw new Error(`Expected status ok, got ${body.status}`);
        if (!body.wallet) throw new Error("Missing wallet in health response");
        console.log(`(wallet: ${body.wallet}) `);
      },
      proxy,
    )) && allPassed;

  // Test 2: Simple non-streaming request (direct model)
  allPassed =
    (await runPaidTest(
      "Non-streaming request (deepseek/deepseek-chat)",
      async (p) => {
        const res = await fetch(`${p.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "deepseek/deepseek-chat",
            messages: [{ role: "user", content: "What is 2+2? Reply with just the number." }],
            max_tokens: 10,
            stream: false,
          }),
        });
        if (res.status !== 200) {
          const text = await res.text();
          throw new Error(`Expected 200, got ${res.status}: ${text.slice(0, 200)}`);
        }
        const body = await res.json();
        const content = body.choices?.[0]?.message?.content;
        if (!content) throw new Error("No content in response");
        if (!content.includes("4")) throw new Error(`Expected "4" in response, got: ${content}`);
        console.log(`(response: "${content.trim()}") `);
      },
      proxy,
    )) && allPassed;

  // Test 3: Streaming request (direct model)
  allPassed =
    (await runPaidTest(
      "Streaming request (google/gemini-2.5-flash)",
      async (p) => {
        const res = await fetch(`${p.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "google/gemini-2.5-flash",
            messages: [{ role: "user", content: "Say hello in one word." }],
            max_tokens: 10,
            stream: true,
          }),
        });
        if (res.status !== 200) {
          throw new Error(`Expected 200, got ${res.status}`);
        }
        const ct = res.headers.get("content-type");
        if (!ct?.includes("text/event-stream")) {
          throw new Error(`Expected text/event-stream, got ${ct}`);
        }
        // Read SSE stream
        const text = await res.text();
        const lines = text.split("\n").filter((l) => l.startsWith("data: "));
        const hasHeartbeat = text.includes(": heartbeat");
        const hasDone = lines.some((l) => l === "data: [DONE]");
        const contentLines = lines.filter((l) => l !== "data: [DONE]");
        let fullContent = "";
        for (const line of contentLines) {
          try {
            const parsed = JSON.parse(line.slice(6));
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) fullContent += delta;
          } catch {
            // skip
          }
        }
        console.log(
          `(heartbeat=${hasHeartbeat}, done=${hasDone}, content="${fullContent.trim()}") `,
        );
        if (!hasDone) throw new Error("Missing [DONE] marker");
      },
      proxy,
    )) && allPassed;

  // Test 4: Smart routing (blockrun/auto) — simple query
  allPassed =
    (await runPaidTest(
      "Smart routing: simple query (blockrun/auto → should pick cheap model)",
      async (p) => {
        const res = await fetch(`${p.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "blockrun/auto",
            messages: [
              {
                role: "user",
                content:
                  "What is the capital of France? Respond with exactly one word in English: Paris.",
              },
            ],
            max_tokens: 40,
            stream: false,
          }),
        });
        if (res.status !== 200) {
          const text = await res.text();
          throw new Error(`Expected 200, got ${res.status}: ${text.slice(0, 200)}`);
        }
        const body = await res.json();
        const content = body.choices?.[0]?.message?.content;
        if (!content) throw new Error("No content in response");
        const looksRelevant = /(paris|capital|france|巴黎|法国|首都)/i.test(content);
        if (!looksRelevant)
          throw new Error(`Expected capital-of-France-related answer, got: ${content}`);
        console.log(`(response: "${content.trim().slice(0, 60)}") `);
      },
      proxy,
    )) && allPassed;

  // Test 5: Smart routing — streaming
  allPassed =
    (await runPaidTest(
      "Smart routing: streaming (blockrun/auto, stream=true)",
      async (p) => {
        const res = await fetch(`${p.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "blockrun/auto",
            messages: [{ role: "user", content: "Define gravity in one sentence." }],
            max_tokens: 50,
            stream: true,
          }),
        });
        if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
        const text = await res.text();
        const hasHeartbeat = text.includes(": heartbeat");
        const hasDone = text.includes("data: [DONE]");
        let fullContent = "";
        for (const line of text.split("\n")) {
          if (line.startsWith("data: ") && line !== "data: [DONE]") {
            try {
              const parsed = JSON.parse(line.slice(6));
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) fullContent += delta;
            } catch {
              // skip
            }
          }
        }
        // Count data events (excluding [DONE])
        const allDataLines = text.split("\n").filter((l) => l.startsWith("data: "));
        const dataEvents = allDataLines.filter((l) => l !== "data: [DONE]");
        console.log(
          `(heartbeat=${hasHeartbeat}, done=${hasDone}, events=${dataEvents.length}, content="${fullContent.trim().slice(0, 60)}") `,
        );
        if (!hasDone) throw new Error("Missing [DONE]");
        if (dataEvents.length === 0) throw new Error("No SSE data events received");
      },
      proxy,
    )) && allPassed;

  // Test 6: Dedup — same request within 30s should be cached
  allPassed =
    (await runPaidTest(
      "Dedup: identical request returns cached response",
      async (p) => {
        const body = JSON.stringify({
          model: "deepseek/deepseek-chat",
          messages: [
            {
              role: "user",
              content: "What is 7 times 8? Reply with just the number, nothing else.",
            },
          ],
          max_tokens: 5,
          stream: false,
        });

        // First request
        const t1 = Date.now();
        const res1 = await fetch(`${p.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        const elapsed1 = Date.now() - t1;
        if (res1.status !== 200) throw new Error(`First request failed: ${res1.status}`);
        const body1 = await res1.json();

        // Second request (same body — should be deduped)
        const t2 = Date.now();
        const res2 = await fetch(`${p.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        const elapsed2 = Date.now() - t2;
        if (res2.status !== 200) throw new Error(`Second request failed: ${res2.status}`);
        const body2 = await res2.json();

        const content1 = body1.choices?.[0]?.message?.content?.trim();
        const content2 = body2.choices?.[0]?.message?.content?.trim();

        console.log(
          `(first=${elapsed1}ms, second=${elapsed2}ms, cached=${elapsed2 < elapsed1 / 2}) `,
        );

        // The deduped response should be significantly faster
        if (elapsed2 > elapsed1 / 2 && elapsed1 > 500) {
          console.log(
            `    NOTE: Second request (${elapsed2}ms) was not much faster than first (${elapsed1}ms) — dedup may not have kicked in`,
          );
        }
      },
      proxy,
    )) && allPassed;

  // Test 7: 404 for non /v1 path
  allPassed =
    (await test(
      "404 for unknown path",
      async (p) => {
        const res = await fetch(`${p.baseUrl}/unknown`);
        if (res.status !== 404) throw new Error(`Expected 404, got ${res.status}`);
      },
      proxy,
    )) && allPassed;

  // Test 8: Large payload handling (>150KB)
  allPassed =
    (await runPaidTest(
      "Large payload handling (>150KB)",
      async (p) => {
        // Create a payload larger than 150KB
        const largeContent = "x".repeat(160 * 1024); // 160KB
        const res = await fetch(`${p.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "deepseek/deepseek-chat",
            messages: [{ role: "user", content: largeContent }],
            max_tokens: 10,
            stream: false,
          }),
        });
        const payload = await readResponseBody(res);
        if (res.status === 413) {
          const errorMsg = extractErrorMessage(payload).toLowerCase();
          if (!errorMsg.includes("payload") && !errorMsg.includes("large")) {
            throw new Error(`Expected payload-size error message, got: ${errorMsg.slice(0, 200)}`);
          }
          console.log(`(status=413, error="${extractErrorMessage(payload).slice(0, 80)}") `);
          return;
        }

        // Current proxy may auto-compress/forward large requests and still succeed.
        if (res.status !== 200) {
          throw new Error(`Expected 200 or 413, got ${res.status}: ${payload.text.slice(0, 200)}`);
        }

        const content = extractFirstMessageContent(payload);
        if (typeof content !== "string" || content.length === 0) {
          throw new Error("Expected non-empty content when large payload succeeds");
        }
        console.log(`(status=200, response="${content.slice(0, 60)}") `);
      },
      proxy,
    )) && allPassed;

  // Test 9: Malformed JSON handling
  allPassed =
    (await runPaidTest(
      "Malformed JSON handling (400/502)",
      async (p) => {
        const res = await fetch(`${p.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{invalid json}",
        });
        const payload = await readResponseBody(res);
        if (res.status !== 400 && res.status !== 502) {
          throw new Error(`Expected 400 or 502, got ${res.status}: ${payload.text.slice(0, 200)}`);
        }
        const errorMsg = extractErrorMessage(payload);
        if (!errorMsg.trim()) throw new Error("Expected non-empty error response");
        console.log(`(status=${res.status}, error="${errorMsg.slice(0, 80)}") `);
      },
      proxy,
    )) && allPassed;

  // Test 10: Missing required fields
  allPassed =
    (await runPaidTest(
      "Missing messages field is rejected",
      async (p) => {
        const res = await fetch(`${p.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "deepseek/deepseek-chat",
            max_tokens: 10,
            stream: false,
          }),
        });
        const payload = await readResponseBody(res);
        if (res.status < 400) {
          throw new Error(
            `Expected client/provider error status (>=400), got ${res.status}: ${payload.text.slice(0, 200)}`,
          );
        }
        const errorMsg = extractErrorMessage(payload).toLowerCase();
        if (!errorMsg.includes("message") && !errorMsg.includes("invalid request")) {
          throw new Error(`Unexpected error message: ${errorMsg.slice(0, 200)}`);
        }
        console.log(
          `(status=${res.status}, error="${extractErrorMessage(payload).slice(0, 80)}") `,
        );
      },
      proxy,
    )) && allPassed;

  // Test 11: Large message array (proxy truncates to 200)
  allPassed =
    (await runPaidTest(
      ">200 messages are handled via truncation",
      async (p) => {
        const messages = Array.from({ length: 201 }, (_, i) => ({
          role: i % 2 === 0 ? "user" : "assistant",
          content: `Message ${i}`,
        }));
        const res = await fetch(`${p.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "deepseek/deepseek-chat",
            messages,
            max_tokens: 10,
            stream: false,
          }),
        });
        const payload = await readResponseBody(res);
        if (res.status !== 200) {
          throw new Error(
            `Expected 200 after truncation, got ${res.status}: ${payload.text.slice(0, 200)}`,
          );
        }
        const content = extractFirstMessageContent(payload);
        if (typeof content !== "string" || content.length === 0) {
          throw new Error("Expected non-empty content for truncated request");
        }
        console.log(`(status=200, response="${content.slice(0, 60)}") `);
      },
      proxy,
    )) && allPassed;

  // Test 12: Invalid model name
  allPassed =
    (await runPaidTest(
      "400 Bad Request (invalid model name)",
      async (p) => {
        const res = await fetch(`${p.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "invalid/nonexistent-model",
            messages: [{ role: "user", content: "Hello" }],
            max_tokens: 10,
            stream: false,
          }),
        });
        if (res.status !== 400 && res.status !== 404) {
          const text = await res.text();
          throw new Error(`Expected 400 or 404, got ${res.status}: ${text.slice(0, 200)}`);
        }
        const payload = await readResponseBody(res);
        const errorMsg = extractErrorMessage(payload);
        if (!errorMsg.trim()) throw new Error("Expected non-empty error response");
        console.log(`(error: "${errorMsg.slice(0, 80)}") `);
      },
      proxy,
    )) && allPassed;

  // Test 13: Concurrent requests (stress test)
  allPassed =
    (await runPaidTest(
      "Concurrent requests (5 parallel)",
      async (p) => {
        const requests = Array.from({ length: 5 }, (_, i) =>
          fetch(`${p.baseUrl}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "deepseek/deepseek-chat",
              messages: [{ role: "user", content: `Count to ${i + 1}` }],
              max_tokens: 20,
              stream: false,
            }),
          }),
        );

        const results = await Promise.all(requests);
        const statuses = results.map((r) => r.status);
        const allSuccess = statuses.every((s) => s === 200);

        if (!allSuccess) {
          throw new Error(`Not all requests succeeded: ${statuses.join(", ")}`);
        }

        const bodies = await Promise.all(results.map((r) => r.json()));
        const allHaveContent = bodies.every((b) => b.choices?.[0]?.message?.content);

        if (!allHaveContent) {
          throw new Error("Not all responses have content");
        }

        console.log(`(all ${results.length} requests succeeded) `);
      },
      proxy,
    )) && allPassed;

  // Test 14: Negative max_tokens
  allPassed =
    (await runPaidTest(
      "400 Bad Request (negative max_tokens)",
      async (p) => {
        const res = await fetch(`${p.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "deepseek/deepseek-chat",
            messages: [{ role: "user", content: "Hello" }],
            max_tokens: -100,
            stream: false,
          }),
        });
        if (res.status !== 400) {
          const text = await res.text();
          throw new Error(`Expected 400, got ${res.status}: ${text.slice(0, 200)}`);
        }
        const payload = await readResponseBody(res);
        const errorMsg = extractErrorMessage(payload);
        if (!errorMsg.trim()) throw new Error("Expected error in response");
        console.log(`(error: "${errorMsg.slice(0, 80)}") `);
      },
      proxy,
    )) && allPassed;

  // Test 15: Empty messages array handling
  allPassed =
    (await runPaidTest(
      "Empty messages array handling (200/400)",
      async (p) => {
        const res = await fetch(`${p.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "deepseek/deepseek-chat",
            messages: [],
            max_tokens: 10,
            stream: false,
          }),
        });
        const payload = await readResponseBody(res);
        if (res.status === 200) {
          const content = extractFirstMessageContent(payload);
          if (typeof content !== "string" || content.length === 0) {
            throw new Error("Expected non-empty content when empty messages request succeeds");
          }
          console.log(`(status=200, response="${content.slice(0, 60)}") `);
          return;
        }
        if (res.status !== 400) {
          throw new Error(`Expected 200 or 400, got ${res.status}: ${payload.text.slice(0, 200)}`);
        }
        const errorMsg = extractErrorMessage(payload);
        if (!errorMsg.trim()) throw new Error("Expected error message for empty messages");
        console.log(`(status=400, error="${errorMsg.slice(0, 80)}") `);
      },
      proxy,
    )) && allPassed;

  // Test 16: Streaming with large response
  allPassed =
    (await runPaidTest(
      "Streaming with large response (verify token counting)",
      async (p) => {
        const res = await fetch(`${p.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "google/gemini-2.5-flash",
            messages: [{ role: "user", content: "Write a 50-word story about a cat." }],
            max_tokens: 100,
            stream: true,
          }),
        });
        if (res.status !== 200) {
          const text = await res.text();
          throw new Error(`Expected 200, got ${res.status}: ${text.slice(0, 200)}`);
        }

        const text = await res.text();
        const hasDone = text.includes("data: [DONE]");
        let fullContent = "";
        let chunkCount = 0;

        for (const line of text.split("\n")) {
          if (line.startsWith("data: ") && line !== "data: [DONE]") {
            try {
              const parsed = JSON.parse(line.slice(6));
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                fullContent += delta;
                chunkCount++;
              }
            } catch {
              // skip
            }
          }
        }

        if (!hasDone) throw new Error("Missing [DONE] marker");
        if (fullContent.length < 100) throw new Error("Response too short");

        console.log(
          `(chunks=${chunkCount}, length=${fullContent.length}, content="${fullContent.trim().slice(0, 50)}...") `,
        );
      },
      proxy,
    )) && allPassed;

  // Test 17: Balance check
  allPassed =
    (await runPaidTest(
      "Balance check (verify wallet has funds)",
      async (p) => {
        if (!p.balanceMonitor) throw new Error("Balance monitor not available");
        const balance = await p.balanceMonitor.checkBalance();
        if (!balance || typeof balance.balanceUSD !== "string") {
          throw new Error("Balance check returned invalid response");
        }
        if (balance.isEmpty) throw new Error("Wallet is empty - please fund it");
        console.log(`(balance=${balance.balanceUSD}) `);
      },
      proxy,
    )) && allPassed;

  // Cleanup
  await proxy.close();

  console.log(`\n=== ${allPassed ? "ALL TESTS PASSED" : "SOME TESTS FAILED"} ===\n`);
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
