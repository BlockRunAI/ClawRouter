/**
 * Test for model fallback logic.
 *
 * Tests that when a primary model fails with a provider error,
 * ClawRouter correctly falls back to the next model in the chain.
 *
 * Usage:
 *   npx tsx test/fallback.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// Track which models were called
const modelCalls: string[] = [];
let failModels: string[] = [];

// Mock BlockRun API server
async function startMockServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks).toString();

    try {
      const parsed = JSON.parse(body) as { model?: string; messages?: Array<{ content: string }> };
      const model = parsed.model || "unknown";
      modelCalls.push(model);

      console.log(`  [MockAPI] Request for model: ${model}`);

      // Simulate provider error for models in failModels list
      if (failModels.includes(model)) {
        console.log(`  [MockAPI] Simulating billing error for ${model}`);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: "API provider returned a billing error: your API key has run out of credits",
              type: "provider_error",
            },
          }),
        );
        return;
      }

      // Success response
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          created: Date.now(),
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: `Response from ${model}` },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }),
      );
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid request" }));
    }
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        port: addr.port,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

// Import after mock server is ready (to avoid wallet key requirement during import)
async function runTests() {
  const { startProxy } = await import("../src/proxy.js");

  console.log("\n═══ Fallback Logic Tests ═══\n");

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

  // Start mock BlockRun API
  const mockApi = await startMockServer();
  console.log(`Mock API started on port ${mockApi.port}`);

  // Generate a test wallet key (not real, just for testing)
  const testWalletKey = "0x" + "1".repeat(64);

  // Start ClawRouter proxy pointing to mock API
  const proxy = await startProxy({
    walletKey: testWalletKey,
    apiBase: `http://127.0.0.1:${mockApi.port}`,
    port: 0,
    skipBalanceCheck: true, // Skip balance check for testing
    onReady: (port) => console.log(`ClawRouter proxy started on port ${port}`),
    onRouted: (d) => console.log(`  [Routed] ${d.model} (${d.tier}) - ${d.reasoning}`),
  });

  // Helper to generate unique message content (prevents dedup cache hits)
  let testCounter = 0;
  const uniqueMessage = (base: string) => `${base} [test-${++testCounter}-${Date.now()}]`;

  // Test 1: Primary model succeeds - no fallback needed
  {
    console.log("\n--- Test 1: Primary model succeeds ---");
    modelCalls.length = 0;
    failModels = [];

    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: uniqueMessage("Hello") }],
        max_tokens: 50,
      }),
    });

    assert(res.ok, `Response OK: ${res.status}`);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content || "";
    // uniqueMessage adds "[test-N]" which triggers agentic detection -> MEDIUM tier
    // MEDIUM tier uses grok-code-fast-1, or SIMPLE uses gemini/deepseek
    assert(
      content.includes("grok-code") || content.includes("deepseek") || content.includes("gemini"),
      `Response from routed model: ${content}`,
    );
    assert(modelCalls.length === 1, `Only 1 model called: ${modelCalls.join(", ")}`);
  }

  // Test 2: Primary fails with billing error - should fallback
  // Note: Agentic mode is auto-detected (test keywords), so uses agentic tier fallbacks:
  // REASONING agentic: [grok-4-fast-reasoning, kimi-k2.5, claude-sonnet-4, deepseek-reasoner]
  {
    console.log("\n--- Test 2: Primary fails, fallback succeeds ---");
    modelCalls.length = 0;
    failModels = ["xai/grok-4-fast-reasoning"];

    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        messages: [
          { role: "user", content: uniqueMessage("Prove step by step that sqrt(2) is irrational") },
        ],
        max_tokens: 50,
      }),
    });

    assert(res.ok, `Response OK after fallback: ${res.status}`);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content || "";
    // Agentic tier fallback order: kimi-k2.5 is first fallback
    assert(content.includes("kimi-k2.5"), `Response from fallback model: ${content}`);
    assert(
      modelCalls.length === 2,
      `2 models called (primary + fallback): ${modelCalls.join(", ")}`,
    );
    assert(modelCalls[0] === "xai/grok-4-fast-reasoning", `First tried primary: ${modelCalls[0]}`);
    assert(modelCalls[1] === "moonshot/kimi-k2.5", `Then tried fallback: ${modelCalls[1]}`);
  }

  // Test 3: Primary and first fallback fail - should try second fallback
  // Agentic REASONING tier: [grok-4-fast-reasoning, kimi-k2.5, claude-sonnet-4, deepseek-reasoner]
  {
    console.log("\n--- Test 3: Primary + first fallback fail, second fallback succeeds ---");
    modelCalls.length = 0;
    failModels = ["xai/grok-4-fast-reasoning", "moonshot/kimi-k2.5"];

    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        messages: [
          { role: "user", content: uniqueMessage("Prove step by step that sqrt(2) is irrational") },
        ],
        max_tokens: 50,
      }),
    });

    assert(res.ok, `Response OK after 2nd fallback: ${res.status}`);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content || "";
    assert(content.includes("claude-sonnet-4"), `Response from 2nd fallback: ${content}`);
    assert(modelCalls.length === 3, `3 models called: ${modelCalls.join(", ")}`);
  }

  // Test 4: All models fail - should return error
  // Agentic REASONING tier first 3: [grok-4-fast-reasoning, kimi-k2.5, claude-sonnet-4]
  {
    console.log("\n--- Test 4: All models fail - returns error ---");
    modelCalls.length = 0;
    failModels = ["xai/grok-4-fast-reasoning", "moonshot/kimi-k2.5", "anthropic/claude-sonnet-4"];

    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        messages: [
          { role: "user", content: uniqueMessage("Prove step by step that sqrt(2) is irrational") },
        ],
        max_tokens: 50,
      }),
    });

    assert(!res.ok, `Response is error: ${res.status}`);
    const data = (await res.json()) as { error?: { message?: string; type?: string } };
    assert(
      data.error?.type === "provider_error",
      `Error type is provider_error: ${data.error?.type}`,
    );
    assert(
      modelCalls.length === 3,
      `Tried 3 models (primary + 2 fallbacks): ${modelCalls.join(", ")}`,
    );
  }

  // Test 5: Explicit model (not auto) - no fallback
  {
    console.log("\n--- Test 5: Explicit model - no fallback ---");
    modelCalls.length = 0;
    failModels = ["openai/gpt-4o"];

    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-4o",
        messages: [{ role: "user", content: uniqueMessage("Hello") }],
        max_tokens: 50,
      }),
    });

    // Should fail without fallback since explicit model was requested
    assert(!res.ok, `Explicit model failure not retried: ${res.status}`);
    assert(modelCalls.length === 1, `Only 1 model called (no fallback): ${modelCalls.join(", ")}`);
  }

  // Cleanup
  await proxy.close();
  await mockApi.close();
  console.log("\nServers closed.");

  // Summary
  console.log("\n═══════════════════════════════════");
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log("═══════════════════════════════════\n");

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
