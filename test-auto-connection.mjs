/**
 * Diagnostic test for "auto" model connection error
 *
 * This script tests both "auto" and explicit models to identify
 * where the connection error occurs.
 */

import { startProxy } from "./dist/index.js";

const WALLET_KEY = process.env.BLOCKRUN_WALLET_KEY;
if (!WALLET_KEY) {
  console.error("ERROR: BLOCKRUN_WALLET_KEY environment variable not set");
  process.exit(1);
}

console.log("=== ClawRouter Auto Model Diagnostic Test ===\n");

// Start proxy
console.log("Starting proxy...");
const proxy = await startProxy({
  wallet: WALLET_KEY,
  port: 8405,
  onReady: (port) => console.log(`✓ Proxy ready on port ${port}`),
  onError: (err) => console.error(`✗ Proxy error: ${err.message}`),
  onRouted: (decision) => {
    console.log(`→ Routed to: ${decision.model} (tier: ${decision.tier})`);
    console.log(`  Reasoning: ${decision.reasoning}`);
  },
});

console.log(`Wallet: ${proxy.walletAddress}\n`);

// Test cases
const testCases = [
  { name: "Explicit model (gpt-4o-mini)", model: "openai/gpt-4o-mini" },
  { name: "Explicit model (gemini-flash)", model: "google/gemini-2.0-flash-exp" },
  { name: "Auto routing", model: "auto" },
  { name: "Auto routing (blockrun prefix)", model: "blockrun/auto" },
];

for (const testCase of testCases) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Testing: ${testCase.name}`);
  console.log(`Model: ${testCase.model}`);
  console.log("=".repeat(60));

  try {
    console.log("→ Making request...");
    const startTime = Date.now();

    const response = await fetch("http://127.0.0.1:8405/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: testCase.model,
        messages: [{ role: "user", content: "Say 'hello' and nothing else" }],
        max_tokens: 10,
      }),
    });

    const elapsed = Date.now() - startTime;
    console.log(`✓ Response received in ${elapsed}ms`);
    console.log(`  Status: ${response.status} ${response.statusText}`);
    console.log(`  Headers:`, Object.fromEntries(response.headers.entries()));

    if (response.ok) {
      const data = await response.json();
      console.log(`  Response: ${JSON.stringify(data, null, 2)}`);
      console.log(`✓ SUCCESS - ${testCase.name} worked`);
    } else {
      const errorText = await response.text();
      console.log(`✗ FAILED - Status ${response.status}`);
      console.log(`  Error body: ${errorText}`);
    }
  } catch (err) {
    console.log(`✗ EXCEPTION - ${testCase.name} failed`);
    console.log(`  Error type: ${err.name}`);
    console.log(`  Error message: ${err.message}`);
    console.log(`  Error code: ${err.code || "N/A"}`);
    console.log(`  Full error:`, err);

    // This is the connection error we're looking for
    if (
      err.code === "ECONNREFUSED" ||
      err.code === "ECONNRESET" ||
      err.message.includes("connection")
    ) {
      console.log(`\n⚠️  CONNECTION ERROR DETECTED FOR: ${testCase.model}`);
    }
  }
}

console.log(`\n${"=".repeat(60)}`);
console.log("Test completed");
console.log("=".repeat(60));

await proxy.close();
process.exit(0);
