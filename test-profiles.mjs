/**
 * Internal test for routing profiles
 * Tests free/eco/auto/premium with real-world prompts
 */

import { route, DEFAULT_ROUTING_CONFIG, BLOCKRUN_MODELS } from "./dist/index.js";

// Build model pricing map
function buildModelPricing() {
  const map = new Map();
  for (const m of BLOCKRUN_MODELS) {
    if (m.id === "auto" || m.id === "free" || m.id === "eco" || m.id === "premium") continue;
    map.set(m.id, { inputPrice: m.inputPrice, outputPrice: m.outputPrice });
  }
  return map;
}

// Test prompts with varying complexity
const testPrompts = [
  {
    name: "Simple Q&A",
    prompt: "What is the capital of France?",
    systemPrompt: undefined,
    maxTokens: 100,
  },
  {
    name: "Code explanation",
    prompt: "Explain how async/await works in JavaScript",
    systemPrompt: "You are a helpful programming assistant.",
    maxTokens: 500,
  },
  {
    name: "Complex code task",
    prompt:
      "Write a TypeScript function that implements a LRU cache with generics, proper error handling, and thread safety",
    systemPrompt: "You are an expert TypeScript developer.",
    maxTokens: 2000,
  },
  {
    name: "Reasoning task",
    prompt:
      "If a train leaves New York at 3pm traveling 60mph, and another leaves Boston at 4pm traveling 80mph, when will they meet? Show your reasoning step by step.",
    systemPrompt: undefined,
    maxTokens: 1000,
  },
  {
    name: "Multi-step agentic task",
    prompt:
      "Research the latest trends in AI agents, analyze the top 3 frameworks, compare their features, and create a recommendation report",
    systemPrompt:
      "You are an AI research analyst with access to web search and analysis tools.",
    maxTokens: 4000,
  },
];

const profiles = ["free", "eco", "auto", "premium"];

console.log("╔════════════════════════════════════════════════════════════╗");
console.log("║        ClawRouter Routing Profile Internal Test           ║");
console.log("╠════════════════════════════════════════════════════════════╣");
console.log("");

const modelPricing = buildModelPricing();
const config = DEFAULT_ROUTING_CONFIG;

// Test each prompt with each profile
for (const test of testPrompts) {
  console.log(`\n📝 Test: ${test.name}`);
  console.log(`   Prompt: "${test.prompt.slice(0, 60)}${test.prompt.length > 60 ? "..." : ""}"`);
  console.log("");

  const results = [];

  for (const profile of profiles) {
    const routerOpts = {
      config,
      modelPricing,
      routingProfile: profile,
    };

    const decision = route(test.prompt, test.systemPrompt, test.maxTokens, routerOpts);

    results.push({
      profile,
      model: decision.model,
      tier: decision.tier,
      cost: decision.costEstimate,
      baseline: decision.baselineCost,
      savings: decision.savings,
      reasoning: decision.reasoning,
    });
  }

  // Display results in a table
  console.log("   Profile    Tier       Model                           Cost      Savings");
  console.log("   ─────────  ─────────  ──────────────────────────────  ────────  ───────");

  for (const r of results) {
    const profileStr = r.profile.padEnd(9);
    const tierStr = r.tier.padEnd(9);
    const modelStr = r.model.slice(0, 30).padEnd(30);
    const costStr = `$${r.cost.toFixed(6)}`.padStart(8);
    const savingsStr = `${(r.savings * 100).toFixed(1)}%`.padStart(6);

    console.log(`   ${profileStr}  ${tierStr}  ${modelStr}  ${costStr}  ${savingsStr}`);
  }

  console.log("");
  console.log(`   💡 Reasoning examples:`);
  results.forEach((r) => {
    if (r.profile === "auto" || r.profile === "eco") {
      console.log(`      [${r.profile}] ${r.reasoning}`);
    }
  });
}

console.log("\n╔════════════════════════════════════════════════════════════╗");
console.log("║                      Test Complete                         ║");
console.log("╚════════════════════════════════════════════════════════════╝");
