import { describe, expect, it } from "vitest";

import { BLOCKRUN_MODELS, MODEL_ALIASES, resolveModelAlias } from "./models.js";
import { buildProxyModelList } from "./proxy.js";

describe("buildProxyModelList", () => {
  it("includes alias models used by /model commands", () => {
    const list = buildProxyModelList(1234567890);
    const ids = new Set(list.map((model) => model.id));

    expect(ids.has("flash")).toBe(true);
    expect(ids.has("kimi")).toBe(true);
    expect(ids.has("kimi-k2.7")).toBe(true);
    expect(ids.has("kimi-k2.6")).toBe(true);
    expect(ids.has("free")).toBe(true);
    expect(ids.has("opus")).toBe(true);
    expect(ids.has("google/gemini-2.5-flash")).toBe(true);
    expect(ids.has("moonshot/kimi-k2.5")).toBe(true);
    expect(ids.has("moonshot/kimi-k2.6")).toBe(true);
    expect(ids.has("moonshot/kimi-k2.7")).toBe(true);
    expect(ids.has("anthropic/claude-opus-4.8")).toBe(true);
    expect(ids.has("anthropic/claude-opus-5")).toBe(true);
  });

  it("lists relisted fable-5 and new free flagships as resolvable targets", () => {
    const list = buildProxyModelList(1234567890);
    const ids = new Set(list.map((model) => model.id));
    // fable-5 relisted by Anthropic 2026-07-06 — alias resolves to the real model again
    expect(ids.has("fable")).toBe(true);
    expect(ids.has("anthropic/claude-fable-5")).toBe(true);
    expect(resolveModelAlias("fable")).toBe("anthropic/claude-fable-5");
    // grok-4.5 added upstream 2026-07-13
    expect(ids.has("xai/grok-4.5")).toBe(true);
    expect(resolveModelAlias("grok-4.5")).toBe("xai/grok-4.5");
    // dead-but-routable pins (both EOL'd upstream — mistral-large 07-28,
    // qwen3.5-122b 07-17 — the gateway redirects; explicit pins must resolve)
    expect(ids.has("free/mistral-large-3-675b")).toBe(true);
    expect(ids.has("free/qwen3.5-122b-a10b")).toBe(true);
  });

  it("returns unique model IDs", () => {
    const list = buildProxyModelList(1234567890);
    const ids = list.map((model) => model.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("returns authoritative pricing, limits, and capabilities for every model", () => {
    const list = buildProxyModelList(1234567890);

    for (const item of list) {
      const canonical = BLOCKRUN_MODELS.find(
        (model) => model.id === (MODEL_ALIASES[item.id] ?? item.id),
      );
      expect(canonical, item.id).toBeDefined();
      expect(item, item.id).toMatchObject({
        context_window: canonical!.contextWindow,
        max_output: canonical!.maxOutput,
        input_price: canonical!.inputPrice,
        output_price: canonical!.outputPrice,
        reasoning: canonical!.reasoning ?? false,
        vision: canonical!.vision ?? false,
        agentic: canonical!.agentic ?? false,
        tool_calling: canonical!.toolCalling ?? false,
      });
    }
  });
});
