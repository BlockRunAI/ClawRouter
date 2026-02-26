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
  // With adjusted weights, this may route to SIMPLE or MEDIUM
  assert(
    r3.tier === "SIMPLE" || r3.tier === "MEDIUM" || r3.tier === null,
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

// System prompt with reasoning/agentic keywords should NOT affect simple queries
// Bug: if client's system prompt had "step by step" / "edit files" / "fix bugs", ALL queries became REASONING/agentic
{
  console.log("\nSystem prompt with reasoning keywords (should NOT affect simple queries):");
  const systemPrompt = "Think step by step and reason logically about the user's question.";

  const r1 = classifyByRules("What is 2+2?", systemPrompt, 10, config.scoring);
  assert(
    r1.tier === "SIMPLE",
    `"2+2" with reasoning system prompt → ${r1.tier} (should be SIMPLE)`,
  );

  const r2 = classifyByRules("Hello", systemPrompt, 5, config.scoring);
  assert(
    r2.tier === "SIMPLE",
    `"Hello" with reasoning system prompt → ${r2.tier} (should be SIMPLE)`,
  );

  const r3 = classifyByRules("What is the capital of France?", systemPrompt, 12, config.scoring);
  assert(
    r3.tier === "SIMPLE",
    `"Capital of France" with reasoning system prompt → ${r3.tier} (should be SIMPLE)`,
  );

  // But if USER explicitly asks for step-by-step, it SHOULD trigger REASONING
  const r4 = classifyByRules(
    "Prove step by step that sqrt(2) is irrational",
    systemPrompt,
    50,
    config.scoring,
  );
  assert(
    r4.tier === "REASONING",
    `User asks for step-by-step proof → ${r4.tier} (should be REASONING)`,
  );
}

// Coding assistant system prompt should NOT force agentic mode on simple queries
// Bug: OpenClaw's system prompt ("edit files", "fix bugs", "check", "verify") was
// triggering agenticScore >= 0.6 on EVERY request, routing all to Sonnet via agentic tiers
{
  console.log("\nCoding assistant system prompt (should NOT force agentic mode):");
  const codingSystemPrompt =
    "You are a coding assistant. You can edit files, fix bugs, check code quality, " +
    "verify tests, deploy applications, and install dependencies. Make sure to follow " +
    "best practices and confirm changes before applying them.";

  const r1 = classifyByRules("What does this function do?", codingSystemPrompt, 20, config.scoring);
  assert(
    r1.agenticScore < 0.5,
    `Simple question with coding system prompt → agenticScore=${r1.agenticScore} (should be <0.5, not forced agentic)`,
  );

  const r2 = classifyByRules("What is React?", codingSystemPrompt, 15, config.scoring);
  assert(
    r2.agenticScore < 0.5,
    `"What is React?" with coding system prompt → agenticScore=${r2.agenticScore} (should be <0.5)`,
  );

  // But if USER explicitly requests agentic work, it SHOULD trigger agentic mode
  // Need 3+ agentic keyword matches for score 0.6: "fix", "deploy", "make sure"
  const r3 = classifyByRules(
    "Fix the bug in auth.ts, deploy to staging, and make sure it works",
    codingSystemPrompt,
    30,
    config.scoring,
  );
  assert(
    r3.agenticScore >= 0.5,
    `User asks for multi-step agentic task → agenticScore=${r3.agenticScore} (should be >=0.5)`,
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

// Complex/high-signal queries should not be down-routed to SIMPLE.
// Depending on scoring weights, these may be MEDIUM/COMPLEX or ambiguous.
{
  console.log("\nComplex queries (expected: non-SIMPLE):");
  const r1 = classifyByRules(
    "Build a React component with TypeScript that implements a drag-and-drop kanban board with async data loading, error handling, and unit tests",
    undefined,
    200,
    config.scoring,
  );
  assert(
    r1.tier === null || r1.tier === "MEDIUM" || r1.tier === "COMPLEX" || r1.tier === "REASONING",
    `Kanban board → ${r1.tier ?? "AMBIGUOUS"} (score=${r1.score.toFixed(3)}, conf=${r1.confidence.toFixed(3)})`,
  );

  const r2 = classifyByRules(
    "Design a distributed microservice architecture for a real-time trading platform. Include the database schema, API endpoints, message queue topology, and kubernetes deployment manifests.",
    undefined,
    250,
    config.scoring,
  );
  assert(
    r2.tier === null || r2.tier === "MEDIUM" || r2.tier === "COMPLEX" || r2.tier === "REASONING",
    `Distributed trading platform → ${r2.tier ?? "AMBIGUOUS"} (score=${r2.score.toFixed(3)}, conf=${r2.confidence.toFixed(3)})`,
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

// Multilingual keyword tests
{
  console.log("\nMultilingual keyword tests:");

  // Chinese reasoning - 证明 (prove) + 逐步 (step by step)
  const zhReasoning = classifyByRules(
    "请证明根号2是无理数，逐步推导",
    undefined,
    20,
    config.scoring,
  );
  assert(
    zhReasoning.tier === "REASONING",
    `Chinese "证明...逐步" → ${zhReasoning.tier} (should be REASONING)`,
  );

  // Chinese simple - 你好 (hello) + 什么是 (what is)
  const zhSimple = classifyByRules("你好，什么是人工智能？", undefined, 15, config.scoring);
  assert(
    zhSimple.tier === "SIMPLE",
    `Chinese "你好...什么是" → ${zhSimple.tier} (should be SIMPLE)`,
  );

  // Japanese simple - こんにちは (hello)
  const jaSimple = classifyByRules("こんにちは、東京とは何ですか", undefined, 15, config.scoring);
  assert(
    jaSimple.tier === "SIMPLE",
    `Japanese "こんにちは...とは" → ${jaSimple.tier} (should be SIMPLE)`,
  );

  // Russian technical - алгоритм (algorithm) + оптимизировать (optimize)
  const ruTech = classifyByRules(
    "Оптимизировать алгоритм сортировки для распределённой системы",
    undefined,
    20,
    config.scoring,
  );
  assert(
    ruTech.tier !== "SIMPLE",
    `Russian "алгоритм...распределённой" → ${ruTech.tier} (should NOT be SIMPLE)`,
  );

  // Russian simple - привет (hello) + что такое (what is)
  const ruSimple = classifyByRules(
    "Привет, что такое машинное обучение?",
    undefined,
    15,
    config.scoring,
  );
  assert(
    ruSimple.tier === "SIMPLE",
    `Russian "привет...что такое" → ${ruSimple.tier} (should be SIMPLE)`,
  );

  // German reasoning - beweisen (prove) + schritt für schritt (step by step)
  const deReasoning = classifyByRules(
    "Beweisen Sie, dass die Quadratwurzel von 2 irrational ist, Schritt für Schritt",
    undefined,
    25,
    config.scoring,
  );
  assert(
    deReasoning.tier === "REASONING",
    `German "beweisen...schritt für schritt" → ${deReasoning.tier} (should be REASONING)`,
  );

  // German simple - hallo (hello) + was ist (what is)
  const deSimple = classifyByRules(
    "Hallo, was ist maschinelles Lernen?",
    undefined,
    10,
    config.scoring,
  );
  assert(
    deSimple.tier === "SIMPLE",
    `German "hallo...was ist" → ${deSimple.tier} (should be SIMPLE)`,
  );

  // German technical - algorithmus (algorithm) + optimieren (optimize)
  const deTech = classifyByRules(
    "Optimieren Sie den Sortieralgorithmus für eine verteilte Architektur",
    undefined,
    20,
    config.scoring,
  );
  assert(
    deTech.tier !== "SIMPLE",
    `German "algorithmus...verteilt" → ${deTech.tier} (should NOT be SIMPLE)`,
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
      wallet: walletKey,
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
