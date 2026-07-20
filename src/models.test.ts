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

  it("maps gpt5 shorthand to the stable GPT-5.6 Terra tier (not the flaky Sol tier — #202)", () => {
    expect(resolveModelAlias("gpt5")).toBe("openai/gpt-5.6-terra");
    expect(resolveModelAlias("gpt-5.6")).toBe("openai/gpt-5.6-terra");
    expect(resolveModelAlias("openai/gpt-5.6")).toBe("openai/gpt-5.6-terra");
  });

  it("keeps explicit GPT-5.6 tier pins routable to their exact tier", () => {
    expect(resolveModelAlias("gpt-5.6-sol")).toBe("openai/gpt-5.6-sol");
    expect(resolveModelAlias("gpt-5.6-terra")).toBe("openai/gpt-5.6-terra");
    expect(resolveModelAlias("gpt-5.6-luna")).toBe("openai/gpt-5.6-luna");
  });

  it("maps bare Gemini Pro shorthands to the current Pro model", () => {
    expect(resolveModelAlias("gemini-pro")).toBe("google/gemini-3.1-pro");
    expect(resolveModelAlias("gemini-3-pro")).toBe("google/gemini-3.1-pro");
    expect(resolveModelAlias("gemini-3.1-pro")).toBe("google/gemini-3.1-pro");
    // The delisted -preview ids keep redirecting rather than 400ing
    expect(resolveModelAlias("gemini-3-pro-preview")).toBe("google/gemini-3.1-pro");
    expect(resolveModelAlias("google/gemini-3-pro-preview")).toBe("google/gemini-3.1-pro");
  });

  it("keeps the canonical Gemini Pro catalog entry unshadowed by the bare alias", () => {
    // Bare alias keys are advertised as their own /v1/models rows; slash-prefixed
    // ones shadow the catalog entry. `gemini-3.1-pro` is bare, so the real
    // `google/gemini-3.1-pro` entry (with its true pricing) must survive.
    const ids = OPENCLAW_MODELS.map((m) => m.id);
    expect(ids).toContain("google/gemini-3.1-pro");
    expect(ids).toContain("gemini-3.1-pro");
    expect(BLOCKRUN_MODELS.some((m) => m.id === "google/gemini-3.1-pro")).toBe(true);
  });

  // grok → 4.5 is a deliberate cost decision (4.5 is $2.50/$9.00 vs 4.3's $1.50/$4.00,
  // and 2x above 200K prompt tokens). It buys a direct-xAI SKU; 4.3 is OpenRouter-only
  // and silently drops Live Search. Pinning it so the tradeoff can't be flipped silently.
  it("maps the generic grok shorthand to the 4.5 flagship, with 4.3 still pinnable", () => {
    expect(resolveModelAlias("grok")).toBe("xai/grok-4.5");
    expect(resolveModelAlias("grok-4.5")).toBe("xai/grok-4.5");
    expect(resolveModelAlias("grok-4-5")).toBe("xai/grok-4.5");
    expect(resolveModelAlias("grok-4.3")).toBe("xai/grok-4.3");
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

  it("registers Qwen3.7 Max with its public aliases and gateway pricing", () => {
    const qwen = BLOCKRUN_MODELS.find((model) => model.id === "qwen/qwen3.7-max");

    // Full-shape equality, not toMatchObject — a subset match cannot fail on a
    // stray `deprecated` / `fallbackModel` / `flatPrice` sneaking onto the entry.
    expect(qwen).toEqual({
      id: "qwen/qwen3.7-max",
      name: "Qwen3.7 Max",
      version: "3.7-max",
      inputPrice: 1.475,
      outputPrice: 4.425,
      contextWindow: 1_000_000,
      maxOutput: 65_536,
      reasoning: true,
      agentic: true,
      toolCalling: true,
    });

    // Every advertised pin resolves, including both punctuation conventions.
    expect(resolveModelAlias("qwen3.7-max")).toBe("qwen/qwen3.7-max");
    expect(resolveModelAlias("qwen-3.7-max")).toBe("qwen/qwen3.7-max");
    expect(resolveModelAlias("qwen3-7-max")).toBe("qwen/qwen3.7-max");
  });

  it("leaves bare `qwen` unbound so it cannot silently bill a free-tier caller", () => {
    // Every other qwen* shorthand is FREE. Binding the shortest name to the
    // $1.475/$4.425 flagship would re-price callers who typed it expecting the
    // free tier — same precedent as generic `kimi`, which stays on K2.7.
    expect(resolveModelAlias("qwen")).toBe("qwen");
    for (const alias of ["qwen-coder", "qwen-thinking", "qwen3-next", "qwen3.5-122b"]) {
      expect(resolveModelAlias(alias)).toMatch(/^free\//);
    }
  });

  it("advertises Qwen3.7 Max in the picker", () => {
    expect(TOP_MODELS).toContain("qwen/qwen3.7-max");
    expect(VISIBLE_OPENCLAW_MODELS.map((m) => m.id)).toContain("qwen/qwen3.7-max");
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
