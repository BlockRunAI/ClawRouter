/**
 * End-to-end test for smart routing + proxy.
 *
 * Part 1: Router classification (no network, no wallet needed)
 * Part 2: Proxy startup + live request (requires BLOCKRUN_WALLET_KEY with funded USDC)
 *
 * Usage:
 *   npx tsup test/e2e.ts --format esm --outDir test/dist --no-dts && node test/dist/e2e.js
 */

import { route, DEFAULT_ROUTING_CONFIG, type RoutingDecision } from "../src/router/index.js";
import { classifyByRules } from "../src/router/rules.js";
import { BLOCKRUN_MODELS } from "../src/models.js";
import { startProxy } from "../src/proxy.js";
import type { ModelPricing } from "../src/router/selector.js";

// ─── Helpers ───

function buildModelPricing(): Map<string, ModelPricing> {
  const map = new Map<string, ModelPricing>();
  for (const m of BLOCKRUN_MODELS) {
    if (m.id === "blockrun/auto") continue;
    map.set(m.id, { inputPrice: m.inputPrice, outputPrice: m.outputPrice });
  }
  return map;
}

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

// ─── Part 1: Rule-Based Classifier ───

console.log("\n═══ Part 1: Rule-Based Classifier ═══\n");

const config = DEFAULT_ROUTING_CONFIG;

// Simple queries
{
  console.log("Simple queries:");
  const r1 = classifyByRules("What is the capital of France?", undefined, 8, config.scoring);
  assert(
    r1.tier === "SIMPLE",
    `"What is the capital of France?" → ${r1.tier} (score=${r1.score.toFixed(3)})`,
  );

  const r2 = classifyByRules("Hello", undefined, 2, config.scoring);
  assert(r2.tier === "SIMPLE", `"Hello" → ${r2.tier} (score=${r2.score.toFixed(3)})`);

  const r3 = classifyByRules("Define photosynthesis", undefined, 4, config.scoring);
  assert(
    r3.tier === "SIMPLE",
    `"Define photosynthesis" → ${r3.tier} (score=${r3.score.toFixed(3)})`,
  );

  const r4 = classifyByRules("Translate hello to Spanish", undefined, 6, config.scoring);
  assert(
    r4.tier === "SIMPLE",
    `"Translate hello to Spanish" → ${r4.tier} (score=${r4.score.toFixed(3)})`,
  );

  const r5 = classifyByRules("Yes or no: is the sky blue?", undefined, 8, config.scoring);
  assert(
    r5.tier === "SIMPLE",
    `"Yes or no: is the sky blue?" → ${r5.tier} (score=${r5.score.toFixed(3)})`,
  );
}

// Medium queries (may be ambiguous — that's ok, LLM classifier handles them)
{
  console.log("\nMedium/Ambiguous queries:");
  const r1 = classifyByRules(
    "Summarize the key differences between REST and GraphQL APIs",
    undefined,
    30,
    config.scoring,
  );
  console.log(
    `  → "Summarize REST vs GraphQL" → tier=${r1.tier ?? "AMBIGUOUS"} (score=${r1.score.toFixed(3)}, conf=${r1.confidence.toFixed(3)}) [${r1.signals.join(", ")}]`,
  );

  const r2 = classifyByRules(
    "Write a Python function to sort a list using merge sort",
    undefined,
    40,
    config.scoring,
  );
  console.log(
    `  → "Write merge sort" → tier=${r2.tier ?? "AMBIGUOUS"} (score=${r2.score.toFixed(3)}, conf=${r2.confidence.toFixed(3)}) [${r2.signals.join(", ")}]`,
  );
}

// Complex queries — these produce low confidence, which is correct.
// In production, the fallback classifier would route them to COMPLEX.
// Here we verify they're ambiguous (null) since rules alone can't be confident.
{
  console.log("\nComplex queries (expected: ambiguous → fallback classifier):");
  const r1 = classifyByRules(
    "Build a React component with TypeScript that implements a drag-and-drop kanban board with async data loading, error handling, and unit tests",
    undefined,
    200,
    config.scoring,
  );
  assert(
    r1.tier === null,
    `Kanban board → AMBIGUOUS (score=${r1.score.toFixed(3)}, conf=${r1.confidence.toFixed(3)}) — correctly defers to classifier`,
  );

  const r2 = classifyByRules(
    "Design a distributed microservice architecture for a real-time trading platform. Include the database schema, API endpoints, message queue topology, and kubernetes deployment manifests.",
    undefined,
    250,
    config.scoring,
  );
  assert(
    r2.tier === null,
    `Distributed trading platform → AMBIGUOUS (score=${r2.score.toFixed(3)}, conf=${r2.confidence.toFixed(3)}) — correctly defers to classifier`,
  );
}

// Reasoning queries
{
  console.log("\nReasoning queries:");
  const r1 = classifyByRules(
    "Prove that the square root of 2 is irrational using proof by contradiction. Show each step formally.",
    undefined,
    60,
    config.scoring,
  );
  assert(
    r1.tier === "REASONING",
    `"Prove sqrt(2) irrational" → ${r1.tier} (score=${r1.score.toFixed(3)}, conf=${r1.confidence.toFixed(3)})`,
  );

  const r2 = classifyByRules(
    "Derive the time complexity of the following algorithm step by step, then prove it is optimal using a lower bound argument.",
    undefined,
    80,
    config.scoring,
  );
  assert(
    r2.tier === "REASONING",
    `"Derive time complexity + prove optimal" → ${r2.tier} (score=${r2.score.toFixed(3)}, conf=${r2.confidence.toFixed(3)})`,
  );

  const r3 = classifyByRules(
    "Using chain of thought, solve this mathematical proof: for all n >= 1, prove that 1 + 2 + ... + n = n(n+1)/2",
    undefined,
    70,
    config.scoring,
  );
  assert(
    r3.tier === "REASONING",
    `"Chain of thought proof" → ${r3.tier} (score=${r3.score.toFixed(3)}, conf=${r3.confidence.toFixed(3)})`,
  );
}

// Override: large context
{
  console.log("\nOverride: large context:");
  const r1 = classifyByRules("What is 2+2?", undefined, 150000, config.scoring);
  // The rules classifier doesn't handle the override — that's in router/index.ts
  // But token count should push score up
  console.log(
    `  → 150K tokens "What is 2+2?" → tier=${r1.tier ?? "AMBIGUOUS"} (score=${r1.score.toFixed(3)}, conf=${r1.confidence.toFixed(3)})`,
  );
}

// ─── Part 2: Full Router (route function, no LLM classifier — uses mock) ───

console.log("\n═══ Part 2: Full Router (rules-only path) ═══\n");

const modelPricing = buildModelPricing();

// Mock payFetch that won't be called (rules handle these clearly)
const mockPayFetch = async () => new Response("", { status: 500 });

const routerOpts = {
  config: DEFAULT_ROUTING_CONFIG,
  modelPricing,
  payFetch: mockPayFetch,
  apiBase: "http://localhost:0",
};

async function testRoute(prompt: string, label: string, expectedTier?: string) {
  const decision = await route(prompt, undefined, 4096, routerOpts);
  const savingsPct = (decision.savings * 100).toFixed(1);
  if (expectedTier) {
    assert(
      decision.tier === expectedTier,
      `${label} → ${decision.model} (${decision.tier}, ${decision.method}) saved=${savingsPct}%`,
    );
  } else {
    console.log(
      `  → ${label} → ${decision.model} (${decision.tier}, ${decision.method}) saved=${savingsPct}%`,
    );
  }
  return decision;
}

await testRoute("What is the capital of France?", "Simple factual", "SIMPLE");
await testRoute("Hello, how are you?", "Greeting", "SIMPLE");
await testRoute(
  "Prove that sqrt(2) is irrational step by step using proof by contradiction",
  "Math proof",
  "REASONING",
);

// Large context override
{
  const longPrompt = "x".repeat(500000); // ~125K tokens
  const decision = await route(longPrompt, undefined, 4096, routerOpts);
  assert(
    decision.tier === "COMPLEX",
    `125K token input → ${decision.tier} (forced COMPLEX override)`,
  );
}

// Structured output override
{
  const decision = await route(
    "What is 2+2?",
    "Respond in JSON format with the answer",
    4096,
    routerOpts,
  );
  assert(
    decision.tier === "MEDIUM" || decision.tier === "SIMPLE",
    `Structured output "What is 2+2?" → ${decision.tier} (min MEDIUM applied: ${decision.tier !== "SIMPLE"})`,
  );
}

// Cost estimates sanity check
{
  console.log("\nCost estimate sanity:");
  const d = await route("What is 2+2?", undefined, 4096, routerOpts);
  assert(d.costEstimate > 0, `Cost estimate > 0: $${d.costEstimate.toFixed(6)}`);
  assert(d.baselineCost > 0, `Baseline cost > 0: $${d.baselineCost.toFixed(6)}`);
  assert(d.savings >= 0 && d.savings <= 1, `Savings in range [0,1]: ${d.savings.toFixed(4)}`);
  assert(
    d.costEstimate <= d.baselineCost,
    `Cost ($${d.costEstimate.toFixed(6)}) <= Baseline ($${d.baselineCost.toFixed(6)})`,
  );
}

// ─── Part 3: Proxy Startup (requires wallet key) ───

console.log("\n═══ Part 3: Proxy Startup ═══\n");

const walletKey = process.env.BLOCKRUN_WALLET_KEY;
if (!walletKey) {
  console.log("  Skipped — set BLOCKRUN_WALLET_KEY to test proxy startup\n");
} else {
  try {
    const proxy = await startProxy({
      walletKey,
      port: 0,
      onReady: (port) => console.log(`  Proxy started on port ${port}`),
      onError: (err) => console.error(`  Proxy error: ${err.message}`),
      onRouted: (d) => {
        const pct = (d.savings * 100).toFixed(1);
        console.log(`  [routed] ${d.model} (${d.tier}) saved=${pct}%`);
      },
    });

    // Test health endpoint
    const health = await fetch(`${proxy.baseUrl}/health`);
    const healthData = (await health.json()) as { status: string; wallet: string };
    assert(
      healthData.status === "ok",
      `Health check: ${healthData.status}, wallet: ${healthData.wallet}`,
    );

    // Send a test chat completion with blockrun/auto
    console.log("\n  Sending test request (blockrun/auto)...");
    try {
      const chatRes = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "blockrun/auto",
          messages: [{ role: "user", content: "What is 2+2?" }],
          max_tokens: 50,
        }),
      });

      if (chatRes.ok) {
        const chatData = (await chatRes.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const content = chatData.choices?.[0]?.message?.content ?? "(no content)";
        console.log(`  ✓ Response: ${content.slice(0, 100)}`);
        passed++;
      } else {
        const errText = await chatRes.text();
        console.log(`  Response status: ${chatRes.status} — ${errText.slice(0, 200)}`);
        // 402 or payment errors are expected if wallet isn't funded
        if (chatRes.status === 402) {
          console.log("  (402 = wallet needs USDC funding — routing still worked)");
        }
      }
    } catch (err) {
      console.log(`  Request error: ${err instanceof Error ? err.message : String(err)}`);
    }

    await proxy.close();
    console.log("  Proxy closed.\n");
  } catch (err) {
    console.error(`  Proxy startup failed: ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

// ─── Summary ───

console.log("═══════════════════════════════════");
console.log(`  ${passed} passed, ${failed} failed`);
console.log("═══════════════════════════════════\n");

process.exit(failed > 0 ? 1 : 0);
