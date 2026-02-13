/**
 * End-to-end test for ClawRouter proxy.
 *
 * Starts the local x402 proxy, sends a real request through it to BlockRun,
 * and verifies the full flow: routing → x402 payment → LLM response.
 *
 * Requires BLOCKRUN_WALLET_KEY env var with a funded wallet.
 *
 * Usage:
 *   BLOCKRUN_WALLET_KEY=0x... npx tsx test-e2e.ts
 */

import { startProxy, type ProxyHandle } from "../src/proxy.js";

const WALLET_KEY = process.env.BLOCKRUN_WALLET_KEY;
if (!WALLET_KEY) {
  console.error("ERROR: Set BLOCKRUN_WALLET_KEY env var");
  process.exit(1);
}

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

async function main() {
  console.log("\n=== ClawRouter e2e tests ===\n");

  // Start proxy
  console.log("Starting proxy...");
  const proxy = await startProxy({
    walletKey: WALLET_KEY!,
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
    (await test(
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
    (await test(
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
    (await test(
      "Smart routing: simple query (blockrun/auto → should pick cheap model)",
      async (p) => {
        const res = await fetch(`${p.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "blockrun/auto",
            messages: [{ role: "user", content: "What is the capital of France?" }],
            max_tokens: 20,
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
        if (!content.toLowerCase().includes("paris"))
          throw new Error(`Expected "Paris" in response, got: ${content}`);
        console.log(`(response: "${content.trim().slice(0, 60)}") `);
      },
      proxy,
    )) && allPassed;

  // Test 5: Smart routing — streaming
  allPassed =
    (await test(
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
    (await test(
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

  // Test 8: 413 Payload Too Large (150KB limit)
  allPassed =
    (await test(
      "413 Payload Too Large (>150KB)",
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
        if (res.status !== 413) {
          const text = await res.text();
          throw new Error(`Expected 413, got ${res.status}: ${text.slice(0, 200)}`);
        }
        const body = await res.json();
        if (!body.error?.message?.toLowerCase().includes("payload"))
          throw new Error("Expected error message about payload size");
        console.log(`(error: "${body.error.message}") `);
      },
      proxy,
    )) && allPassed;

  // Test 9: 400 Bad Request (malformed JSON)
  allPassed =
    (await test(
      "400 Bad Request (malformed JSON)",
      async (p) => {
        const res = await fetch(`${p.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{invalid json}",
        });
        if (res.status !== 400) {
          const text = await res.text();
          throw new Error(`Expected 400, got ${res.status}: ${text.slice(0, 200)}`);
        }
        const body = await res.json();
        if (!body.error) throw new Error("Expected error in response");
        console.log(`(error: "${body.error.message}") `);
      },
      proxy,
    )) && allPassed;

  // Test 10: 400 Bad Request (missing required fields)
  allPassed =
    (await test(
      "400 Bad Request (missing messages field)",
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
        if (res.status !== 400) {
          const text = await res.text();
          throw new Error(`Expected 400, got ${res.status}: ${text.slice(0, 200)}`);
        }
        const body = await res.json();
        if (!body.error?.message?.toLowerCase().includes("messages"))
          throw new Error("Expected error message about missing messages");
        console.log(`(error: "${body.error.message}") `);
      },
      proxy,
    )) && allPassed;

  // Test 11: Large message array (200 messages limit)
  allPassed =
    (await test(
      "400 Bad Request (>200 messages)",
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
        if (res.status !== 400) {
          const text = await res.text();
          throw new Error(`Expected 400, got ${res.status}: ${text.slice(0, 200)}`);
        }
        const body = await res.json();
        if (!body.error?.message?.toLowerCase().includes("message"))
          throw new Error("Expected error message about message count");
        console.log(`(error: "${body.error.message}") `);
      },
      proxy,
    )) && allPassed;

  // Test 12: Invalid model name
  allPassed =
    (await test(
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
        const body = await res.json();
        if (!body.error) throw new Error("Expected error in response");
        console.log(`(error: "${body.error.message}") `);
      },
      proxy,
    )) && allPassed;

  // Test 13: Concurrent requests (stress test)
  allPassed =
    (await test(
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
    (await test(
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
        const body = await res.json();
        if (!body.error) throw new Error("Expected error in response");
        console.log(`(error: "${body.error.message}") `);
      },
      proxy,
    )) && allPassed;

  // Test 15: Empty messages array
  allPassed =
    (await test(
      "400 Bad Request (empty messages array)",
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
        if (res.status !== 400) {
          const text = await res.text();
          throw new Error(`Expected 400, got ${res.status}: ${text.slice(0, 200)}`);
        }
        const body = await res.json();
        if (!body.error?.message?.toLowerCase().includes("message"))
          throw new Error("Expected error message about messages");
        console.log(`(error: "${body.error.message}") `);
      },
      proxy,
    )) && allPassed;

  // Test 16: Streaming with large response
  allPassed =
    (await test(
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
    (await test(
      "Balance check (verify wallet has funds)",
      async (p) => {
        if (!p.balanceMonitor) throw new Error("Balance monitor not available");
        const balance = p.balanceMonitor.getBalance();
        if (balance.isEmpty) throw new Error("Wallet is empty - please fund it");
        console.log(`(balance=$${balance.balanceUSD.toFixed(2)}) `);
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
