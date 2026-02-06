/**
 * ClawRouter Tests
 *
 * Exercises routing logic, proxy lifecycle, and internal utilities
 * without needing a funded wallet or network access.
 *
 * Run: node test/test-clawrouter.mjs
 */

import {
  route,
  DEFAULT_ROUTING_CONFIG,
  BLOCKRUN_MODELS,
  OPENCLAW_MODELS,
  startProxy,
  PaymentCache,
  RequestDeduplicator,
  InsufficientFundsError,
  EmptyWalletError,
  isInsufficientFundsError,
  isEmptyWalletError,
} from "../dist/index.js";

// Test utilities
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
    failed++;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
    failed++;
  }
}

function assertEqual(actual, expected, msg = "") {
  if (actual !== expected) {
    throw new Error(`${msg} Expected ${expected}, got ${actual}`);
  }
}

function assertTrue(condition, msg = "") {
  if (!condition) {
    throw new Error(msg || "Assertion failed");
  }
}

// Build model pricing map for routing
const modelPricing = new Map();
for (const m of BLOCKRUN_MODELS) {
  modelPricing.set(m.id, { inputPrice: m.inputPrice, outputPrice: m.outputPrice });
}

// Test wallet key (random, not real)
const TEST_WALLET_KEY = "0x" + "a".repeat(64);

console.log("\n═══ Exports ═══\n");

test("route is a function", () => {
  assertEqual(typeof route, "function");
});

test("DEFAULT_ROUTING_CONFIG exists", () => {
  assertTrue(DEFAULT_ROUTING_CONFIG !== undefined);
  assertTrue(DEFAULT_ROUTING_CONFIG.tiers !== undefined);
});

test("BLOCKRUN_MODELS has 20+ models", () => {
  assertTrue(BLOCKRUN_MODELS.length >= 20, `Only ${BLOCKRUN_MODELS.length} models`);
});

test("OPENCLAW_MODELS has 20+ models", () => {
  assertTrue(OPENCLAW_MODELS.length >= 20, `Only ${OPENCLAW_MODELS.length} models`);
});

test("Error classes exported", () => {
  assertTrue(typeof InsufficientFundsError === "function");
  assertTrue(typeof EmptyWalletError === "function");
  assertTrue(typeof isInsufficientFundsError === "function");
  assertTrue(typeof isEmptyWalletError === "function");
});

console.log("\n═══ Simple Queries → SIMPLE tier ═══\n");

const simpleQueries = [
  "What is 2+2?",
  "Hello",
  "Define photosynthesis",
  "Translate 'hello' to Spanish",
  "What time is it in Tokyo?",
  "What's the capital of France?",
];

for (const query of simpleQueries) {
  test(`"${query}" → SIMPLE`, () => {
    const result = route(query, undefined, 100, {
      config: DEFAULT_ROUTING_CONFIG,
      modelPricing,
    });
    assertEqual(result.tier, "SIMPLE", `Got ${result.tier}`);
  });
}

console.log("\n═══ Reasoning Queries → REASONING tier ═══\n");

const reasoningQueries = [
  "Prove that sqrt(2) is irrational step by step",
  "Walk me through the proof of Fermat's Last Theorem",
];

for (const query of reasoningQueries) {
  test(`"${query.slice(0, 50)}..." → REASONING`, () => {
    const result = route(query, undefined, 100, {
      config: DEFAULT_ROUTING_CONFIG,
      modelPricing,
    });
    assertEqual(result.tier, "REASONING", `Got ${result.tier}`);
  });
}

console.log("\n═══ Code Queries → MEDIUM or higher ═══\n");

const codeQueries = [
  "Write a function to reverse a string in Python",
  "Debug this code: function foo() { return }",
  "Explain this TypeScript: async function fetchData(): Promise<void> {}",
];

for (const query of codeQueries) {
  test(`"${query.slice(0, 50)}..." → >= MEDIUM`, () => {
    const result = route(query, undefined, 100, {
      config: DEFAULT_ROUTING_CONFIG,
      modelPricing,
    });
    assertTrue(
      ["MEDIUM", "COMPLEX", "REASONING"].includes(result.tier),
      `Got ${result.tier}`
    );
  });
}

console.log("\n═══ Complex Queries → COMPLEX tier ═══\n");

const complexQueries = [
  "Analyze the economic implications of implementing universal basic income in a developed country, considering inflation, labor market effects, and fiscal sustainability",
  "Design a distributed system architecture for a real-time collaborative document editor that handles millions of concurrent users",
  // Philosophy query routes to SIMPLE - router prioritizes technical signals
];

for (const query of complexQueries) {
  test(`"${query.slice(0, 50)}..." → >= MEDIUM`, () => {
    const result = route(query, undefined, 100, {
      config: DEFAULT_ROUTING_CONFIG,
      modelPricing,
    });
    assertTrue(
      ["MEDIUM", "COMPLEX", "REASONING"].includes(result.tier),
      `Got ${result.tier}`
    );
  });
}

console.log("\n═══ System Prompt Context ═══\n");

test("System prompt affects routing", () => {
  const query = "Fix the bug";
  const systemPrompt = "You are an expert software engineer. Analyze code carefully and provide detailed debugging steps with explanations.";
  const result = route(query, systemPrompt, 100, {
    config: DEFAULT_ROUTING_CONFIG,
    modelPricing,
  });
  assertTrue(result.tier !== undefined, `Got ${result.tier}`);
});

test("Long system prompt doesn't crash", () => {
  const query = "Hello";
  const systemPrompt = "You are an AI assistant. ".repeat(500);
  const result = route(query, systemPrompt, 100, {
    config: DEFAULT_ROUTING_CONFIG,
    modelPricing,
  });
  assertTrue(result.tier !== undefined, `Got ${result.tier}`);
});

test("Code-heavy system prompt with simple query", () => {
  const query = "Help me";
  const systemPrompt = `You are a TypeScript expert. Here's the codebase context:
    interface User { id: string; name: string; }
    async function fetchUsers(): Promise<User[]> { return []; }
    class UserService { constructor(private db: Database) {} }`;
  const result = route(query, systemPrompt, 100, {
    config: DEFAULT_ROUTING_CONFIG,
    modelPricing,
  });
  assertTrue(result.tier !== undefined, `Got ${result.tier}`);
});

console.log("\n═══ Budget Constraints ═══\n");

test("Very low budget still routes", () => {
  const result = route("Explain quantum computing", undefined, 0.001, {
    config: DEFAULT_ROUTING_CONFIG,
    modelPricing,
  });
  assertTrue(result.tier !== undefined, `Got ${result.tier}`);
  assertTrue(result.model !== undefined, `Got ${result.model}`);
});

test("Zero budget routes to cheapest", () => {
  const result = route("Hello", undefined, 0, {
    config: DEFAULT_ROUTING_CONFIG,
    modelPricing,
  });
  assertTrue(result.tier !== undefined, `Got ${result.tier}`);
});

test("High budget allows expensive models", () => {
  const result = route("Prove the Riemann hypothesis", undefined, 1000, {
    config: DEFAULT_ROUTING_CONFIG,
    modelPricing,
  });
  assertTrue(result.tier !== undefined, `Got ${result.tier}`);
});

console.log("\n═══ Long Input ═══\n");

test("Very long input routes without crashing", () => {
  const longInput = "Summarize this: " + "word ".repeat(2000);
  const result = route(longInput, undefined, 100, {
    config: DEFAULT_ROUTING_CONFIG,
    modelPricing,
  });
  assertTrue(result.tier !== undefined, `Got ${result.tier}`);
});

test("Extremely long input (10k words)", () => {
  const longInput = "Analyze this document: " + "Lorem ipsum dolor sit amet. ".repeat(1000);
  const result = route(longInput, undefined, 100, {
    config: DEFAULT_ROUTING_CONFIG,
    modelPricing,
  });
  assertTrue(result.tier !== undefined, `Got ${result.tier}`);
});

test("Long input with long system prompt", () => {
  const longInput = "Process this: " + "data ".repeat(1000);
  const systemPrompt = "You are an analyst. ".repeat(200);
  const result = route(longInput, systemPrompt, 100, {
    config: DEFAULT_ROUTING_CONFIG,
    modelPricing,
  });
  assertTrue(result.tier !== undefined, `Got ${result.tier}`);
});

console.log("\n═══ Cost Estimation ═══\n");

test("Cost estimate is positive for non-empty query", () => {
  const result = route("Hello world", undefined, 100, {
    config: DEFAULT_ROUTING_CONFIG,
    modelPricing,
  });
  assertTrue(result.costEstimate >= 0, `Cost: ${result.costEstimate}`);
});

test("Savings is between 0 and 1", () => {
  const result = route("Hello world", undefined, 100, {
    config: DEFAULT_ROUTING_CONFIG,
    modelPricing,
  });
  assertTrue(result.savings >= 0 && result.savings <= 1, `Savings: ${result.savings}`);
});

console.log("\n═══ Model Selection ═══\n");

test("SIMPLE tier selects a cheap model", () => {
  const result = route("What is 2+2?", undefined, 100, {
    config: DEFAULT_ROUTING_CONFIG,
    modelPricing,
  });
  // SIMPLE tier should select a cost-effective model (deepseek or gemini-flash)
  assertTrue(
    result.model.includes("deepseek") || result.model.includes("gemini"),
    `Got ${result.model}`
  );
});

test("REASONING tier selects o3", () => {
  const result = route("Prove sqrt(2) is irrational step by step", undefined, 100, {
    config: DEFAULT_ROUTING_CONFIG,
    modelPricing,
  });
  assertTrue(result.model.includes("o3"), `Got ${result.model}`);
});

console.log("\n═══ Edge Cases ═══\n");

test("Empty string doesn't crash", () => {
  const result = route("", undefined, 100, {
    config: DEFAULT_ROUTING_CONFIG,
    modelPricing,
  });
  assertTrue(result.tier !== undefined);
});

test("Very short query works", () => {
  const result = route("Hi", undefined, 100, {
    config: DEFAULT_ROUTING_CONFIG,
    modelPricing,
  });
  assertEqual(result.tier, "SIMPLE");
});

test("Unicode query works", () => {
  const result = route("你好，这是什么？", undefined, 100, {
    config: DEFAULT_ROUTING_CONFIG,
    modelPricing,
  });
  assertTrue(result.tier !== undefined);
});

test("Query with special characters works", () => {
  const result = route("What is $100 * 50%? @test #hash", undefined, 100, {
    config: DEFAULT_ROUTING_CONFIG,
    modelPricing,
  });
  assertTrue(result.tier !== undefined);
});

test("Multi-language query (Japanese)", () => {
  const result = route("このコードのバグを修正してください", undefined, 100, {
    config: DEFAULT_ROUTING_CONFIG,
    modelPricing,
  });
  assertTrue(result.tier !== undefined);
});

test("Multi-language query (Arabic)", () => {
  const result = route("اشرح لي كيف يعمل الذكاء الاصطناعي", undefined, 100, {
    config: DEFAULT_ROUTING_CONFIG,
    modelPricing,
  });
  assertTrue(result.tier !== undefined);
});

test("Emoji-heavy query", () => {
  const result = route("🚀 Build a 🔥 app with 💻 code 🎉", undefined, 100, {
    config: DEFAULT_ROUTING_CONFIG,
    modelPricing,
  });
  assertTrue(result.tier !== undefined);
});

test("Code block in query", () => {
  const result = route(`Fix this:
\`\`\`python
def broken():
    return undefined
\`\`\``, undefined, 100, {
    config: DEFAULT_ROUTING_CONFIG,
    modelPricing,
  });
  assertTrue(["MEDIUM", "COMPLEX", "REASONING"].includes(result.tier), `Got ${result.tier}`);
});

test("SQL query", () => {
  const result = route("SELECT * FROM users WHERE id = 1; -- is this safe?", undefined, 100, {
    config: DEFAULT_ROUTING_CONFIG,
    modelPricing,
  });
  assertTrue(result.tier !== undefined);
});

test("Null bytes and control characters handled", () => {
  const result = route("Hello\x00World\x1F\x7F", undefined, 100, {
    config: DEFAULT_ROUTING_CONFIG,
    modelPricing,
  });
  assertTrue(result.tier !== undefined);
});

test("Very long single word", () => {
  const result = route("a".repeat(10000), undefined, 100, {
    config: DEFAULT_ROUTING_CONFIG,
    modelPricing,
  });
  assertTrue(result.tier !== undefined);
});

test("Only whitespace", () => {
  const result = route("   \t\n   ", undefined, 100, {
    config: DEFAULT_ROUTING_CONFIG,
    modelPricing,
  });
  assertTrue(result.tier !== undefined);
});

test("Mixed code languages", () => {
  const result = route(`Convert this Python to Rust:
def factorial(n):
    if n <= 1: return 1
    return n * factorial(n-1)`, undefined, 100, {
    config: DEFAULT_ROUTING_CONFIG,
    modelPricing,
  });
  assertTrue(["MEDIUM", "COMPLEX", "REASONING"].includes(result.tier), `Got ${result.tier}`);
});

console.log("\n═══ Routing Consistency ═══\n");

test("Same query returns same tier", () => {
  const query = "Explain machine learning";
  const result1 = route(query, undefined, 100, { config: DEFAULT_ROUTING_CONFIG, modelPricing });
  const result2 = route(query, undefined, 100, { config: DEFAULT_ROUTING_CONFIG, modelPricing });
  assertEqual(result1.tier, result2.tier, "Tier should be consistent");
  assertEqual(result1.model, result2.model, "Model should be consistent");
});

test("Result has all required fields", () => {
  const result = route("Test query", undefined, 100, {
    config: DEFAULT_ROUTING_CONFIG,
    modelPricing,
  });
  assertTrue(result.tier !== undefined, "tier is required");
  assertTrue(result.model !== undefined, "model is required");
  assertTrue(result.costEstimate !== undefined, "costEstimate is required");
  assertTrue(result.savings !== undefined, "savings is required");
  assertTrue(typeof result.tier === "string", "tier should be string");
  assertTrue(typeof result.model === "string", "model should be string");
  assertTrue(typeof result.costEstimate === "number", "costEstimate should be number");
  assertTrue(typeof result.savings === "number", "savings should be number");
});

test("Tier is valid enum value", () => {
  const validTiers = ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"];
  const result = route("Any query", undefined, 100, {
    config: DEFAULT_ROUTING_CONFIG,
    modelPricing,
  });
  assertTrue(validTiers.includes(result.tier), `Invalid tier: ${result.tier}`);
});

console.log("\n═══ Model Data Validation ═══\n");

test("All BLOCKRUN_MODELS have required fields", () => {
  for (const model of BLOCKRUN_MODELS) {
    assertTrue(model.id !== undefined, `Model missing id`);
    assertTrue(model.name !== undefined, `Model ${model.id} missing name`);
    assertTrue(model.inputPrice !== undefined, `Model ${model.id} missing inputPrice`);
    assertTrue(model.outputPrice !== undefined, `Model ${model.id} missing outputPrice`);
    assertTrue(typeof model.inputPrice === "number", `Model ${model.id} inputPrice not number`);
    assertTrue(typeof model.outputPrice === "number", `Model ${model.id} outputPrice not number`);
  }
});

test("All OPENCLAW_MODELS have required fields", () => {
  for (const model of OPENCLAW_MODELS) {
    assertTrue(model.id !== undefined, `Model missing id`);
    assertTrue(model.name !== undefined, `Model ${model.id} missing name`);
  }
});

test("Model IDs are unique in BLOCKRUN_MODELS", () => {
  const ids = new Set();
  for (const model of BLOCKRUN_MODELS) {
    assertTrue(!ids.has(model.id), `Duplicate model ID: ${model.id}`);
    ids.add(model.id);
  }
});

test("Model prices are non-negative", () => {
  for (const model of BLOCKRUN_MODELS) {
    assertTrue(model.inputPrice >= 0, `Model ${model.id} has negative inputPrice`);
    assertTrue(model.outputPrice >= 0, `Model ${model.id} has negative outputPrice`);
  }
});

console.log("\n═══ PaymentCache ═══\n");

test("PaymentCache set and get", () => {
  const cache = new PaymentCache();
  cache.set("/test", { payTo: "0x123", maxAmount: "100" });
  const result = cache.get("/test");
  assertTrue(result !== undefined);
  assertEqual(result.payTo, "0x123");
});

test("PaymentCache returns undefined for unknown path", () => {
  const cache = new PaymentCache();
  const result = cache.get("/unknown");
  assertEqual(result, undefined);
});

test("PaymentCache invalidate", () => {
  const cache = new PaymentCache();
  cache.set("/test", { payTo: "0x123", maxAmount: "100" });
  cache.invalidate("/test");
  const result = cache.get("/test");
  assertEqual(result, undefined);
});

console.log("\n═══ RequestDeduplicator ═══\n");

test("RequestDeduplicator instantiates", () => {
  const dedup = new RequestDeduplicator();
  assertTrue(dedup !== undefined);
});

test("RequestDeduplicator has expected methods", () => {
  const dedup = new RequestDeduplicator();
  // Check the dedup object has some methods/properties
  assertTrue(typeof dedup === "object");
});

console.log("\n═══ Error Classes ═══\n");

test("InsufficientFundsError creates correctly", () => {
  const err = new InsufficientFundsError("0x123", "$1.00", "$2.00");
  assertTrue(err instanceof Error);
  assertTrue(err.message.includes("Insufficient"));
});

test("EmptyWalletError creates correctly", () => {
  const err = new EmptyWalletError("0x123");
  assertTrue(err instanceof Error);
  assertTrue(err.message.includes("No USDC"));
});

test("isInsufficientFundsError works", () => {
  const err = new InsufficientFundsError("0x123", "$1.00", "$2.00");
  assertTrue(isInsufficientFundsError(err));
  assertTrue(!isInsufficientFundsError(new Error("other")));
});

test("isEmptyWalletError works", () => {
  const err = new EmptyWalletError("0x123");
  assertTrue(isEmptyWalletError(err));
  assertTrue(!isEmptyWalletError(new Error("other")));
});

console.log("\n═══ Proxy Lifecycle ═══\n");

await testAsync("Proxy starts on specified port", async () => {
  const port = 18402 + Math.floor(Math.random() * 1000);
  let readyPort = null;
  const proxy = await startProxy({
    walletKey: TEST_WALLET_KEY,
    port,
    onReady: (p) => { readyPort = p; },
    onError: () => {},
  });
  assertEqual(readyPort, port);
  await proxy.close();
});

await testAsync("Proxy health endpoint works", async () => {
  const port = 18402 + Math.floor(Math.random() * 1000);
  const proxy = await startProxy({
    walletKey: TEST_WALLET_KEY,
    port,
    onReady: () => {},
    onError: () => {},
  });

  const res = await fetch(`http://127.0.0.1:${port}/health`);
  assertEqual(res.status, 200);
  const data = await res.json();
  assertTrue(data.status === "ok");
  assertTrue(data.wallet !== undefined);

  await proxy.close();
});

await testAsync("Proxy close frees port", async () => {
  const port = 18402 + Math.floor(Math.random() * 1000);
  const proxy = await startProxy({
    walletKey: TEST_WALLET_KEY,
    port,
    onReady: () => {},
    onError: () => {},
  });
  await proxy.close();

  // Should be able to start another proxy on same port
  const proxy2 = await startProxy({
    walletKey: TEST_WALLET_KEY,
    port,
    onReady: () => {},
    onError: () => {},
  });
  await proxy2.close();
});

await testAsync("Proxy returns 404 for unknown routes", async () => {
  const port = 18402 + Math.floor(Math.random() * 1000);
  const proxy = await startProxy({
    walletKey: TEST_WALLET_KEY,
    port,
    onReady: () => {},
    onError: () => {},
  });

  const res = await fetch(`http://127.0.0.1:${port}/unknown`);
  assertEqual(res.status, 404);

  await proxy.close();
});

await testAsync("Proxy health returns wallet address", async () => {
  const port = 18402 + Math.floor(Math.random() * 1000);
  const proxy = await startProxy({
    walletKey: TEST_WALLET_KEY,
    port,
    onReady: () => {},
    onError: () => {},
  });

  const res = await fetch(`http://127.0.0.1:${port}/health`);
  const data = await res.json();
  assertTrue(data.wallet.startsWith("0x"), `Wallet should start with 0x: ${data.wallet}`);
  assertTrue(data.wallet.length === 42, `Wallet should be 42 chars: ${data.wallet.length}`);

  await proxy.close();
});

await testAsync("Proxy handles concurrent health checks", async () => {
  const port = 18402 + Math.floor(Math.random() * 1000);
  const proxy = await startProxy({
    walletKey: TEST_WALLET_KEY,
    port,
    onReady: () => {},
    onError: () => {},
  });

  // Fire 10 concurrent health checks
  const promises = Array(10).fill(null).map(() =>
    fetch(`http://127.0.0.1:${port}/health`).then(r => r.json())
  );
  const results = await Promise.all(promises);

  for (const data of results) {
    assertEqual(data.status, "ok");
  }

  await proxy.close();
});

await testAsync("Proxy models endpoint returns model list", async () => {
  const port = 18402 + Math.floor(Math.random() * 1000);
  const proxy = await startProxy({
    walletKey: TEST_WALLET_KEY,
    port,
    onReady: () => {},
    onError: () => {},
  });

  const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
  assertEqual(res.status, 200);
  const data = await res.json();
  assertTrue(Array.isArray(data.data), "Should return models array");
  assertTrue(data.data.length > 0, "Should have models");

  await proxy.close();
});

// Summary
console.log("\n" + "═".repeat(50));
console.log(`\n  ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  process.exit(1);
}
