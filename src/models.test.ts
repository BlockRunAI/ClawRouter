import { describe, expect, it } from "vitest";

import {
  BLOCKRUN_MODELS,
  OPENCLAW_MODELS,
  VISIBLE_OPENCLAW_MODELS,
  resolveModelAlias,
} from "./models.js";
import { TOP_MODELS } from "./top-models.js";

describe("resolveModelAlias", () => {
  it("maps Claude aliases to current flagship versions", () => {
    // Sonnet → 4.6, Opus → 4.8 (new flagship), Haiku → 4.5
    expect(resolveModelAlias("claude")).toBe("anthropic/claude-sonnet-4.6");
    expect(resolveModelAlias("br-sonnet")).toBe("anthropic/claude-sonnet-4.6");
    expect(resolveModelAlias("sonnet")).toBe("anthropic/claude-sonnet-4.6");
    expect(resolveModelAlias("opus")).toBe("anthropic/claude-opus-4.8");
    expect(resolveModelAlias("haiku")).toBe("anthropic/claude-haiku-4.5");
  });

  it("maps gpt5 shorthand to the newest GPT-5 flagship", () => {
    expect(resolveModelAlias("gpt5")).toBe("openai/gpt-5.5");
  });

  it("resolves aliases even when sent with blockrun/ prefix", () => {
    expect(resolveModelAlias("blockrun/claude")).toBe("anthropic/claude-sonnet-4.6");
    expect(resolveModelAlias("blockrun/sonnet-4.6")).toBe("anthropic/claude-sonnet-4.6");
    expect(resolveModelAlias("blockrun/opus")).toBe("anthropic/claude-opus-4.8");
  });

  it("keeps explicit version pins routable, promotes generic opus-4 to flagship 4.8", () => {
    expect(resolveModelAlias("anthropic/claude-sonnet-4")).toBe("anthropic/claude-sonnet-4.6");
    expect(resolveModelAlias("anthropic/claude-opus-4")).toBe("anthropic/claude-opus-4.8");
    // Newest flagship resolves both as bare alias and explicit pin.
    expect(resolveModelAlias("opus-4.8")).toBe("anthropic/claude-opus-4.8");
    expect(resolveModelAlias("anthropic/claude-opus-4-8")).toBe("anthropic/claude-opus-4.8");
    // Explicit version pins must stay on their version, not upgrade to the flagship.
    expect(resolveModelAlias("opus-4.7")).toBe("anthropic/claude-opus-4.7");
    expect(resolveModelAlias("anthropic/claude-opus-4-7")).toBe("anthropic/claude-opus-4.7");
    // 4.5 is a distinct model in blockrun (200K context, smaller than 4.6/4.7/4.8's 1M);
    // the explicit pin must be preserved end-to-end, not silently upgraded.
    expect(resolveModelAlias("anthropic/claude-opus-4.5")).toBe("anthropic/claude-opus-4.5");
    expect(resolveModelAlias("anthropic/claude-opus-4-5")).toBe("anthropic/claude-opus-4.5");
    expect(resolveModelAlias("anthropic/claude-opus-4-6")).toBe("anthropic/claude-opus-4.6");
  });

  it("strips openai/ prefix from virtual routing profiles (issue #78)", () => {
    // OpenClaw sends virtual profiles as "openai/eco", "openai/auto", etc.
    expect(resolveModelAlias("openai/eco")).toBe("eco");
    expect(resolveModelAlias("openai/free")).toBe("free/gpt-oss-120b"); // "free" is now an alias, not a virtual profile
    expect(resolveModelAlias("openai/auto")).toBe("auto");
    expect(resolveModelAlias("openai/premium")).toBe("premium");
  });

  it("strips openai/ prefix from aliases", () => {
    expect(resolveModelAlias("openai/claude")).toBe("anthropic/claude-sonnet-4.6");
    expect(resolveModelAlias("openai/sonnet")).toBe("anthropic/claude-sonnet-4.6");
  });

  it("redirects delisted grok-code-fast-1 IDs to deepseek", () => {
    expect(resolveModelAlias("xai/grok-code-fast-1")).toBe("deepseek/deepseek-chat");
    expect(resolveModelAlias("blockrun/xai/grok-code-fast-1")).toBe("deepseek/deepseek-chat");
    expect(resolveModelAlias("grok-code-fast-1")).toBe("deepseek/deepseek-chat");
  });

  it("keeps sonnet-4.5 as a distinct pin while bare sonnet stays on 4.6", () => {
    // BlockRun hosts 4.5 as a separate public model ($3/$15) — the pin must
    // not silently upgrade to 4.6.
    expect(resolveModelAlias("sonnet-4.5")).toBe("anthropic/claude-sonnet-4.5");
    expect(resolveModelAlias("anthropic/claude-sonnet-4-5")).toBe("anthropic/claude-sonnet-4.5");
    expect(BLOCKRUN_MODELS.some((m) => m.id === "anthropic/claude-sonnet-4.5")).toBe(true);
    expect(resolveModelAlias("sonnet")).toBe("anthropic/claude-sonnet-4.6");
  });
});

describe("OPENCLAW_MODELS integrity", () => {
  it("contains no duplicate ids (alias-shadowed catalog entries are excluded)", () => {
    const ids = OPENCLAW_MODELS.map((m) => m.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dupes).toEqual([]);
  });

  it("shows exactly one truthful `free` picker entry", () => {
    const freeEntries = VISIBLE_OPENCLAW_MODELS.filter((m) => m.id === "free");
    expect(freeEntries).toHaveLength(1);
    // The `free` alias resolves to gpt-oss-120b; the picker label must agree
    // (the retired "Nemotron Ultra 253B" label shadowed it until v0.12.206).
    expect(freeEntries[0]!.name).toContain("GPT-OSS 120B");
  });

  it("advertises visible models in top-models order", () => {
    expect(VISIBLE_OPENCLAW_MODELS).toHaveLength(TOP_MODELS.length);
    expect(VISIBLE_OPENCLAW_MODELS.map((m) => m.id)).toEqual(TOP_MODELS);
  });
});
