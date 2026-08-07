import { describe, expect, it } from "vitest";

import { RulesStrategy, getStrategy, registerStrategy } from "./strategy.js";
import { DEFAULT_ROUTING_CONFIG } from "./config.js";
import type { RouterStrategy, RouterOptions } from "./types.js";
import type { ModelPricing } from "./selector.js";
import { route } from "./index.js";

const MODEL_PRICING = new Map<string, ModelPricing>([
  ["moonshot/kimi-k2.5", { inputPrice: 0.5, outputPrice: 2.4 }],
  ["moonshot/kimi-k2.6", { inputPrice: 0.95, outputPrice: 4.0 }],
  ["anthropic/claude-opus-4.6", { inputPrice: 5, outputPrice: 25 }],
  ["anthropic/claude-opus-4.7", { inputPrice: 5, outputPrice: 25 }],
  ["anthropic/claude-opus-4.8", { inputPrice: 5, outputPrice: 25 }],
  ["google/gemini-2.5-flash", { inputPrice: 0.15, outputPrice: 0.6 }],
  ["google/gemini-2.5-flash-lite", { inputPrice: 0.1, outputPrice: 0.4 }],
  ["deepseek/deepseek-chat", { inputPrice: 0.14, outputPrice: 0.28 }],
  ["anthropic/claude-sonnet-4.6", { inputPrice: 3, outputPrice: 15 }],
  ["google/gemini-3.1-pro", { inputPrice: 1.25, outputPrice: 10 }],
  ["google/gemini-3.5-flash", { inputPrice: 0.5, outputPrice: 3 }],
  ["xai/grok-4.5", { inputPrice: 2.5, outputPrice: 9 }],
  ["anthropic/claude-sonnet-5", { inputPrice: 3, outputPrice: 15 }],
  ["deepseek/deepseek-v4-pro", { inputPrice: 0.435, outputPrice: 0.87 }],
  ["moonshot/kimi-k3", { inputPrice: 3, outputPrice: 15 }],
  ["xai/grok-4-1-fast-reasoning", { inputPrice: 0.2, outputPrice: 0.5 }],
  ["nvidia/gpt-oss-120b", { inputPrice: 0, outputPrice: 0 }],
  ["nvidia/gpt-oss-20b", { inputPrice: 0, outputPrice: 0 }],
  ["nvidia/deepseek-v3.2", { inputPrice: 0, outputPrice: 0 }],
  ["nvidia/deepseek-v4-pro", { inputPrice: 0, outputPrice: 0 }],
  ["nvidia/deepseek-v4-flash", { inputPrice: 0, outputPrice: 0 }],
  ["nvidia/qwen3-coder-480b", { inputPrice: 0, outputPrice: 0 }],
  ["nvidia/glm-4.7", { inputPrice: 0, outputPrice: 0 }],
  ["nvidia/llama-4-maverick", { inputPrice: 0, outputPrice: 0 }],
  ["nvidia/qwen3-next-80b-a3b-thinking", { inputPrice: 0, outputPrice: 0 }],
  ["nvidia/mistral-small-4-119b", { inputPrice: 0, outputPrice: 0 }],
  ["nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", { inputPrice: 0, outputPrice: 0 }],
  ["nvidia/qwen3-next-80b-a3b-instruct", { inputPrice: 0, outputPrice: 0 }],
  ["nvidia/seed-oss-36b", { inputPrice: 0, outputPrice: 0 }],
  ["nvidia/mistral-nemotron", { inputPrice: 0, outputPrice: 0 }],
  ["nvidia/step-3.7-flash", { inputPrice: 0, outputPrice: 0 }],
  ["nvidia/nemotron-nano-9b-v2", { inputPrice: 0, outputPrice: 0 }],
  ["nvidia/nemotron-nano-12b-v2-vl", { inputPrice: 0, outputPrice: 0 }],
]);

const baseOptions: RouterOptions = {
  config: DEFAULT_ROUTING_CONFIG,
  modelPricing: MODEL_PRICING,
};

describe("RulesStrategy", () => {
  it("returns tierConfigs in the decision", () => {
    const strategy = new RulesStrategy();
    const decision = strategy.route("hello", undefined, 100, baseOptions);

    expect(decision.tierConfigs).toBeDefined();
    expect(decision.tierConfigs!.SIMPLE).toBeDefined();
    expect(decision.tierConfigs!.MEDIUM).toBeDefined();
    expect(decision.tierConfigs!.COMPLEX).toBeDefined();
    expect(decision.tierConfigs!.REASONING).toBeDefined();
  });

  it("returns profile in the decision", () => {
    const strategy = new RulesStrategy();
    const decision = strategy.route("hello", undefined, 100, baseOptions);

    expect(decision.profile).toBeDefined();
    expect(["auto", "eco", "premium", "agentic"]).toContain(decision.profile);
  });

  it("honors the protocol structured-output requirement", () => {
    const strategy = new RulesStrategy();
    const decision = strategy.route("hello", undefined, 100, {
      ...baseOptions,
      requiresStructuredOutput: true,
    });

    expect(decision.tier).toBe("MEDIUM");
    expect(decision.reasoning).toContain("structured output");
  });

  it("sets eco profile when routingProfile is eco", () => {
    const strategy = new RulesStrategy();
    const decision = strategy.route("hello", undefined, 100, {
      ...baseOptions,
      routingProfile: "eco",
    });

    expect(decision.profile).toBe("eco");
    expect(decision.tierConfigs).toEqual(DEFAULT_ROUTING_CONFIG.ecoTiers);
  });

  it("sets premium profile when routingProfile is premium", () => {
    const strategy = new RulesStrategy();
    const decision = strategy.route("hello", undefined, 100, {
      ...baseOptions,
      routingProfile: "premium",
    });

    expect(decision.profile).toBe("premium");
    expect(decision.tierConfigs).toEqual(DEFAULT_ROUTING_CONFIG.premiumTiers);
  });

  it("falls back to regular tiers when ecoTiers is null without dropping into auto mode", () => {
    const strategy = new RulesStrategy();
    const config = {
      ...DEFAULT_ROUTING_CONFIG,
      ecoTiers: null,
    };
    const decision = strategy.route("hello", undefined, 100, {
      ...baseOptions,
      config,
      routingProfile: "eco",
      hasTools: true,
      now: new Date("2025-01-01"),
    });

    expect(decision.profile).toBe("eco");
    expect(decision.tierConfigs).toEqual(DEFAULT_ROUTING_CONFIG.tiers);
  });

  it("falls back to regular tiers when premiumTiers is null without dropping into auto mode", () => {
    const strategy = new RulesStrategy();
    const config = {
      ...DEFAULT_ROUTING_CONFIG,
      premiumTiers: null,
    };
    const decision = strategy.route("hello", undefined, 100, {
      ...baseOptions,
      config,
      routingProfile: "premium",
      hasTools: true,
      now: new Date("2025-01-01"),
    });

    expect(decision.profile).toBe("premium");
    expect(decision.tierConfigs).toEqual(DEFAULT_ROUTING_CONFIG.tiers);
  });

  it("sets agentic profile when tools are present", () => {
    const strategy = new RulesStrategy();
    const decision = strategy.route("hello", undefined, 100, {
      ...baseOptions,
      hasTools: true,
    });

    expect(decision.profile).toBe("agentic");
    expect(decision.tierConfigs).toEqual(DEFAULT_ROUTING_CONFIG.agenticTiers);
  });

  it("sets auto profile for default requests", () => {
    const strategy = new RulesStrategy();
    // Use a date well outside any promo windows to test base tiers (no promotion overrides)
    const decision = strategy.route("what is the capital of France", undefined, 100, {
      ...baseOptions,
      now: new Date("2025-01-01"),
    });

    expect(decision.profile).toBe("auto");
    expect(decision.tierConfigs).toEqual(DEFAULT_ROUTING_CONFIG.tiers);
  });

  it("does NOT use agentic tiers when overrides.agenticMode is false (even with tools)", () => {
    // Regression test for #148: agenticMode: false should disable agentic tier
    // selection entirely, even when the request includes tools.
    const strategy = new RulesStrategy();
    const config = {
      ...DEFAULT_ROUTING_CONFIG,
      overrides: { ...DEFAULT_ROUTING_CONFIG.overrides, agenticMode: false },
    };
    const decision = strategy.route("hello", undefined, 100, {
      ...baseOptions,
      config,
      hasTools: true,
      now: new Date("2025-01-01"),
    });

    expect(decision.profile).toBe("auto");
    expect(decision.tierConfigs).toEqual(DEFAULT_ROUTING_CONFIG.tiers);
  });

  it("forces agentic tiers when overrides.agenticMode is true (even without tools)", () => {
    const strategy = new RulesStrategy();
    const config = {
      ...DEFAULT_ROUTING_CONFIG,
      overrides: { ...DEFAULT_ROUTING_CONFIG.overrides, agenticMode: true },
    };
    const decision = strategy.route("hello", undefined, 100, {
      ...baseOptions,
      config,
      hasTools: false,
      now: new Date("2025-01-01"),
    });

    expect(decision.profile).toBe("agentic");
    expect(decision.tierConfigs).toEqual(DEFAULT_ROUTING_CONFIG.agenticTiers);
  });
});

describe("Strategy Registry", () => {
  it("retrieves the default rules strategy", () => {
    const strategy = getStrategy("rules");
    expect(strategy).toBeInstanceOf(RulesStrategy);
    expect(strategy.name).toBe("rules");
  });

  it("throws for unknown strategy", () => {
    expect(() => getStrategy("nonexistent")).toThrow("Unknown routing strategy: nonexistent");
  });

  it("registers and retrieves a custom strategy", () => {
    const custom: RouterStrategy = {
      name: "custom-test",
      route: (_prompt, _sys, _max, options) => ({
        model: "test/model",
        tier: "SIMPLE" as const,
        confidence: 1,
        method: "rules" as const,
        reasoning: "custom strategy",
        costEstimate: 0,
        baselineCost: 0,
        savings: 0,
        tierConfigs: options.config.tiers,
        profile: "auto",
      }),
    };

    registerStrategy(custom);
    const retrieved = getStrategy("custom-test");
    expect(retrieved.name).toBe("custom-test");

    const decision = retrieved.route("test", undefined, 100, baseOptions);
    expect(decision.model).toBe("test/model");
    expect(decision.reasoning).toBe("custom strategy");
  });
});

describe("Portfolio default", () => {
  it("route() uses the V3 portfolio while retaining rule tiers", () => {
    // Simple prompt → SIMPLE tier
    const simple = route("hello", undefined, 100, baseOptions);
    expect(simple.tier).toBe("SIMPLE");
    expect(simple.method).toBe("portfolio");
    expect(simple.model).toBeDefined();
    expect(simple.candidates?.[0]).toBe(simple.model);
    expect(simple.routerVersion).toBe("v3-portfolio");

    // Reasoning prompt → REASONING tier
    const reasoning = route(
      "prove the theorem step by step using mathematical induction",
      undefined,
      4096,
      baseOptions,
    );
    expect(reasoning.tier).toBe("REASONING");
    expect(reasoning.method).toBe("portfolio");

    // New fields are present
    expect(simple.tierConfigs).toBeDefined();
    expect(simple.profile).toBeDefined();
    expect(reasoning.tierConfigs).toBeDefined();
    expect(reasoning.profile).toBeDefined();
  });

  it("supports a config-only rollback to the V2 rules strategy", () => {
    const decision = route("hello", undefined, 100, {
      ...baseOptions,
      config: { ...DEFAULT_ROUTING_CONFIG, strategy: "rules" },
    });
    expect(decision.method).toBe("rules");
  });

  it("recognizes multiple-choice reasoning and uses the calibrated model pool", () => {
    const decision = route(
      "Which statement is correct?\n\nA. First\nB. Second\nC. Third\nD. Fourth\n\nReturn the final answer choice.",
      undefined,
      512,
      baseOptions,
    );

    expect(decision.taskType).toBe("reasoning_mcq");
    expect(decision.tier).toBe("REASONING");
    expect(decision.model).toBe("google/gemini-3-flash-preview");
    expect(decision.candidates).toContain("xai/grok-4.5");
    expect(decision.tierConfigs?.REASONING.primary).toBe(decision.model);
  });

  it("recognizes compact multilingual arithmetic as mathematical reasoning", () => {
    const decision = route(
      "Una caja tiene 12 libros. Hay 4 cajas. ¿Cuántos libros hay en total?",
      undefined,
      512,
      baseOptions,
    );

    expect(decision.taskType).toBe("reasoning_math");
    expect(decision.tier).toBe("REASONING");
    expect(decision.model).toBe("google/gemini-3.5-flash");
  });

  it("recognizes math word problems in languages that omit question marks", () => {
    const decision = route(
      "เรือแล่นได้เร็ว 10 ไมล์ต่อชั่วโมง ตั้งแต่ 13.00 น. ถึง 16.00 น. และกลับด้วยความเร็ว 6 ไมล์ต่อชั่วโมง",
      undefined,
      512,
      baseOptions,
    );

    expect(decision.taskType).toBe("reasoning_math");
  });
});
