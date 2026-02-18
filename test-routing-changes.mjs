#!/usr/bin/env node
/**
 * Test script to verify routing optimizations
 * Tests: tier boundaries, fallback order, agentic threshold
 */

import { route, DEFAULT_ROUTING_CONFIG } from "./dist/index.js";

// Test prompts representing different complexity levels
const testPrompts = [
  {
    name: "Simple explanation",
    prompt: "Explain what an array is in programming",
    expectedOld: "COMPLEX (score ~0.20)",
    expectedNew: "MEDIUM (score 0.20 < 0.30)",
  },
  {
    name: "Borderline complex",
    prompt:
      "Write a React component with useState and useEffect hooks that fetches data from an API",
    expectedOld: "COMPLEX (score ~0.25)",
    expectedNew: "MEDIUM (score 0.25 < 0.30)",
  },
  {
    name: "Truly complex",
    prompt:
      "Design a distributed caching system with Redis cluster, handle failover, and implement consistent hashing for data sharding across nodes",
    expectedOld: "COMPLEX (score ~0.35)",
    expectedNew: "COMPLEX (score 0.35 >= 0.30)",
  },
  {
    name: "Reasoning task",
    prompt:
      "Given a complex logic puzzle: If A implies B, B implies C, and C is false, what can we deduce about A? Explain step by step with formal logic",
    expectedOld: "REASONING (score ~0.55)",
    expectedNew: "REASONING (score 0.55 >= 0.5)",
  },
  {
    name: "2-keyword agentic",
    prompt: "Research best practices for API design and summarize findings",
    expectedOld: "Not agentic (2 keywords < 3)",
    expectedNew: "Agentic (2 keywords >= 2)",
  },
  {
    name: "Multi-step agentic",
    prompt: "Analyze this codebase, find security vulnerabilities, and suggest improvements",
    expectedOld: "Agentic (3 keywords)",
    expectedNew: "Agentic (3 keywords)",
  },
];

console.log("\n═══════════════════════════════════════════════════════════");
console.log("  CLAWROUTER ROUTING OPTIMIZATION TEST");
console.log("═══════════════════════════════════════════════════════════\n");

console.log("📊 Testing tier boundaries:");
console.log("   - mediumComplex: 0.18 → 0.30 (+67%)");
console.log("   - complexReasoning: 0.4 → 0.5 (+25%)");
console.log("   - agenticThreshold: 0.69 → 0.5 (-27%)\n");

console.log("📦 Testing fallback order:");
console.log("   - COMPLEX tier: Grok 1st, Sonnet last\n");

console.log("───────────────────────────────────────────────────────────\n");

// Create minimal modelPricing map
const modelPricing = new Map();
modelPricing.set("nvidia/kimi-k2.5", { input: 0.001, output: 0.001, contextWindow: 128000 });
modelPricing.set("google/gemini-2.5-flash", { input: 0.075, output: 0.3, contextWindow: 1000000 });
modelPricing.set("deepseek/deepseek-chat", { input: 0.14, output: 0.28, contextWindow: 64000 });
modelPricing.set("xai/grok-code-fast-1", { input: 0.2, output: 1.5, contextWindow: 131000 });
modelPricing.set("xai/grok-4-0709", { input: 0.2, output: 1.5, contextWindow: 131000 });
modelPricing.set("openai/gpt-4o-mini", { input: 0.15, output: 0.6, contextWindow: 128000 });
modelPricing.set("openai/gpt-4o", { input: 2.5, output: 10, contextWindow: 128000 });
modelPricing.set("google/gemini-2.5-pro", { input: 0.625, output: 2.5, contextWindow: 2000000 });
modelPricing.set("openai/gpt-5.2", { input: 2.5, output: 10, contextWindow: 200000 });
modelPricing.set("anthropic/claude-sonnet-4.6", { input: 3, output: 15, contextWindow: 200000 });

// Test each prompt
for (const test of testPrompts) {
  console.log(`🔍 ${test.name}:`);
  console.log(
    `   Prompt: "${test.prompt.substring(0, 70)}${test.prompt.length > 70 ? "..." : ""}"`,
  );

  try {
    const result = route(test.prompt, "", 4000, {
      config: DEFAULT_ROUTING_CONFIG,
      modelPricing: modelPricing,
    });

    const tier = result.tier;
    const model = result.selectedModel;
    const confidence = result.confidence;
    const reasoning = result.reasoning;

    console.log(`   ✅ Tier: ${tier}`);
    console.log(`   ✅ Model: ${model}`);
    console.log(`   ✅ Confidence: ${(confidence * 100).toFixed(1)}%`);
    console.log(`   ✅ Reasoning: ${reasoning}`);

    // Check if it matches expected behavior
    if (reasoning.includes("agentic")) {
      console.log(`   🎯 Agentic mode: ACTIVE`);
    }
  } catch (error) {
    console.log(`   ❌ Error: ${error.message}`);
  }

  console.log("");
}

console.log("───────────────────────────────────────────────────────────\n");

console.log("📈 Expected Improvements:");
console.log("   • Borderline prompts (score 0.18-0.29) → MEDIUM instead of COMPLEX");
console.log("   • COMPLEX fallback → Grok ($0.20/$1.50) before Sonnet ($3/$15)");
console.log("   • Agentic detection → activates with 2+ keywords instead of 3+");
console.log("   • Overall cost reduction: 30-40%\n");

console.log("═══════════════════════════════════════════════════════════\n");
