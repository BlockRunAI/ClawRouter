#!/usr/bin/env node
/**
 * End-to-end test for Kimi thinking token stripping.
 *
 * 1. Start a mock BlockRun API that returns responses with Kimi thinking tokens
 * 2. Start ClawRouter proxy pointing to the mock server
 * 3. Send requests through the proxy
 * 4. Verify thinking tokens are stripped from responses
 */

import { createServer } from "node:http";
import { startProxy } from "../dist/index.js";

// Test wallet key (for testing only - no real funds)
const TEST_WALLET_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

// Test cases: mock responses with thinking tokens
const TEST_CASES = [
  {
    name: "Kimi end token in response",
    mockResponse: {
      id: "chatcmpl-test1",
      object: "chat.completion",
      created: Date.now(),
      model: "moonshot-v1-8k",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: 'sessions_list()<｜end▁of▁thinking｜>{"sessions": [{"id": 1}]}',
          },
          finish_reason: "stop",
        },
      ],
    },
    expectedContent: 'sessions_list(){"sessions": [{"id": 1}]}',
  },
  {
    name: "Full Kimi thinking block",
    mockResponse: {
      id: "chatcmpl-test2",
      object: "chat.completion",
      created: Date.now(),
      model: "moonshot-v1-8k",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "<｜begin▁of▁thinking｜>Let me think about this...<｜end▁of▁thinking｜>The answer is 42.",
          },
          finish_reason: "stop",
        },
      ],
    },
    expectedContent: "The answer is 42.",
  },
  {
    name: "Standard think tags",
    mockResponse: {
      id: "chatcmpl-test3",
      object: "chat.completion",
      created: Date.now(),
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Hello <think>internal reasoning here</think> world!",
          },
          finish_reason: "stop",
        },
      ],
    },
    expectedContent: "Hello  world!",
  },
  {
    name: "Clean response (no tokens)",
    mockResponse: {
      id: "chatcmpl-test4",
      object: "chat.completion",
      created: Date.now(),
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "This is a normal response without any thinking tokens.",
          },
          finish_reason: "stop",
        },
      ],
    },
    expectedContent: "This is a normal response without any thinking tokens.",
  },
];

let currentTestIndex = 0;

function getListeningPort(server) {
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Failed to resolve listening port");
  }
  return addr.port;
}

async function runTests() {
  console.log("=== ClawRouter E2E Test: Thinking Token Stripping ===\n");

  // 1. Start mock BlockRun API server
  const mockServer = createServer((req, res) => {
    // Skip x402 payment flow - just return 200 directly
    const mockResponse = TEST_CASES[currentTestIndex].mockResponse;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(mockResponse));
  });

  await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
  const mockPort = getListeningPort(mockServer);
  console.log(`✓ Mock BlockRun API started on port ${mockPort}`);

  // 2. Start ClawRouter proxy pointing to mock server
  let proxy;
  try {
    proxy = await startProxy({
      wallet: TEST_WALLET_KEY,
      apiBase: `http://127.0.0.1:${mockPort}`,
      port: 0,
      onReady: (port) => console.log(`✓ ClawRouter proxy started on port ${port}`),
    });
  } catch (err) {
    console.error("Failed to start proxy:", err.message);
    mockServer.close();
    process.exit(1);
  }

  console.log("\n--- Running test cases ---\n");

  let passed = 0;
  let failed = 0;

  for (let i = 0; i < TEST_CASES.length; i++) {
    currentTestIndex = i;
    const tc = TEST_CASES[i];

    try {
      // Send request through proxy (streaming mode to test SSE conversion)
      // Use unique message content to avoid dedup cache
      const response = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: tc.mockResponse.model,
          messages: [{ role: "user", content: `test-${i}-${Date.now()}` }],
          stream: true,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }

      // Read SSE response and extract content
      const text = await response.text();
      const lines = text.split("\n").filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"));

      let content = "";
      for (const line of lines) {
        try {
          const data = JSON.parse(line.slice(6));
          if (data.choices?.[0]?.delta?.content) {
            content += data.choices[0].delta.content;
          }
        } catch {}
      }

      // Verify
      if (content === tc.expectedContent) {
        console.log(`✅ ${tc.name}`);
        passed++;
      } else {
        console.log(`❌ ${tc.name}`);
        console.log(`   Expected: ${JSON.stringify(tc.expectedContent)}`);
        console.log(`   Got:      ${JSON.stringify(content)}`);
        failed++;
      }
    } catch (err) {
      console.log(`❌ ${tc.name}`);
      console.log(`   Error: ${err.message}`);
      failed++;
    }
  }

  console.log("\n=== Results ===");
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total:  ${TEST_CASES.length}`);

  // Cleanup
  await proxy.close();
  mockServer.close();

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
