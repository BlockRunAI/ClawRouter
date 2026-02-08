/**
 * Test for Google model message normalization.
 *
 * Tests that when a conversation starts with an assistant/model message,
 * ClawRouter prepends a placeholder user message for Google models.
 *
 * Usage:
 *   npx tsx test/google-messages.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// Track received messages
let lastReceivedMessages: Array<{ role: string; content: string }> = [];
let lastReceivedModel = "";

// Mock BlockRun API server
async function startMockServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks).toString();

    try {
      const parsed = JSON.parse(body) as {
        model?: string;
        messages?: Array<{ role: string; content: string }>;
      };
      lastReceivedModel = parsed.model || "unknown";
      lastReceivedMessages = parsed.messages || [];

      console.log(`  [MockAPI] Model: ${lastReceivedModel}`);
      console.log(`  [MockAPI] Messages: ${JSON.stringify(lastReceivedMessages)}`);

      // Success response
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          created: Date.now(),
          model: lastReceivedModel,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: `Response from ${lastReceivedModel}` },
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

// Import after mock server is ready
async function runTests() {
  const { startProxy } = await import("../src/proxy.js");

  console.log("\n═══ Google Message Normalization Tests ═══\n");

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
    skipBalanceCheck: true,
    onReady: (port) => console.log(`ClawRouter proxy started on port ${port}`),
  });

  // Helper to make requests
  async function makeRequest(model: string, messages: Array<{ role: string; content: string }>) {
    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: 50,
      }),
    });
    return res;
  }

  // Test 1: Normal user-first message - no normalization needed
  {
    console.log("\n--- Test 1: User-first message (no normalization needed) ---");
    lastReceivedMessages = [];

    await makeRequest("google/gemini-2.5-flash", [{ role: "user", content: "Hello" }]);

    assert(
      lastReceivedMessages.length === 1,
      `Message count unchanged: ${lastReceivedMessages.length}`,
    );
    assert(
      lastReceivedMessages[0]?.role === "user",
      `First message is user: ${lastReceivedMessages[0]?.role}`,
    );
  }

  // Test 2: Assistant-first message - should prepend user message
  {
    console.log("\n--- Test 2: Assistant-first message (needs normalization) ---");
    lastReceivedMessages = [];

    await makeRequest("google/gemini-2.5-flash", [
      { role: "assistant", content: "I am ready to help" },
      { role: "user", content: "Thanks!" },
    ]);

    assert(
      lastReceivedMessages.length === 3,
      `Message count increased by 1: ${lastReceivedMessages.length}`,
    );
    assert(
      lastReceivedMessages[0]?.role === "user",
      `First message is now user: ${lastReceivedMessages[0]?.role}`,
    );
    assert(
      lastReceivedMessages[0]?.content === "(continuing conversation)",
      `Placeholder content: ${lastReceivedMessages[0]?.content}`,
    );
    assert(
      lastReceivedMessages[1]?.role === "assistant",
      `Second message is assistant: ${lastReceivedMessages[1]?.role}`,
    );
  }

  // Test 3: System prompt + assistant-first - should insert after system
  {
    console.log("\n--- Test 3: System + assistant-first (insert after system) ---");
    lastReceivedMessages = [];

    await makeRequest("google/gemini-2.5-flash", [
      { role: "system", content: "You are helpful" },
      { role: "assistant", content: "I understand" },
      { role: "user", content: "Great!" },
    ]);

    assert(
      lastReceivedMessages.length === 4,
      `Message count increased by 1: ${lastReceivedMessages.length}`,
    );
    assert(
      lastReceivedMessages[0]?.role === "system",
      `First message is still system: ${lastReceivedMessages[0]?.role}`,
    );
    assert(
      lastReceivedMessages[1]?.role === "user",
      `Second message is placeholder user: ${lastReceivedMessages[1]?.role}`,
    );
    assert(
      lastReceivedMessages[1]?.content === "(continuing conversation)",
      `Placeholder content: ${lastReceivedMessages[1]?.content}`,
    );
    assert(
      lastReceivedMessages[2]?.role === "assistant",
      `Third message is assistant: ${lastReceivedMessages[2]?.role}`,
    );
  }

  // Test 4: Non-Google model - should NOT normalize
  {
    console.log("\n--- Test 4: Non-Google model (no normalization) ---");
    lastReceivedMessages = [];

    await makeRequest("openai/gpt-4o", [
      { role: "assistant", content: "I am ready" },
      { role: "user", content: "Hello" },
    ]);

    assert(
      lastReceivedMessages.length === 2,
      `Message count unchanged: ${lastReceivedMessages.length}`,
    );
    assert(
      lastReceivedMessages[0]?.role === "assistant",
      `First message is still assistant: ${lastReceivedMessages[0]?.role}`,
    );
  }

  // Test 5: System-only messages - should not change
  {
    console.log("\n--- Test 5: System-only messages (edge case) ---");
    lastReceivedMessages = [];

    await makeRequest("google/gemini-2.5-flash", [{ role: "system", content: "You are helpful" }]);

    assert(
      lastReceivedMessages.length === 1,
      `Message count unchanged: ${lastReceivedMessages.length}`,
    );
    assert(
      lastReceivedMessages[0]?.role === "system",
      `First message is system: ${lastReceivedMessages[0]?.role}`,
    );
  }

  // Test 6: Model role (alternative name for assistant) - should normalize
  {
    console.log("\n--- Test 6: 'model' role (Google's naming) ---");
    lastReceivedMessages = [];

    await makeRequest("google/gemini-2.5-pro", [
      { role: "model", content: "Previous response" },
      { role: "user", content: "Continue" },
    ]);

    assert(
      lastReceivedMessages.length === 3,
      `Message count increased by 1: ${lastReceivedMessages.length}`,
    );
    assert(
      lastReceivedMessages[0]?.role === "user",
      `First message is now user: ${lastReceivedMessages[0]?.role}`,
    );
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
