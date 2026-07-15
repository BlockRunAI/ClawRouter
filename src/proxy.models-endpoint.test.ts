import { describe, expect, it } from "vitest";

import { resolveModelAlias } from "./models.js";
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
    // new blockrun-featured free flagships (2026-06-14 sweep)
    expect(ids.has("free/mistral-large-3-675b")).toBe(true);
    expect(ids.has("free/qwen3.5-122b-a10b")).toBe(true);
  });

  it("returns unique model IDs", () => {
    const list = buildProxyModelList(1234567890);
    const ids = list.map((model) => model.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
