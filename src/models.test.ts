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
    expect(resolveModelAlias("opus")).toBe("anthropic/claude-opus-5");
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
    expect(resolveModelAlias("blockrun/opus")).toBe("anthropic/claude-opus-5");
  });

  it("keeps explicit version pins routable, promotes generic opus-4 to 4-series flagship 4.8", () => {
    expect(resolveModelAlias("anthropic/claude-sonnet-4")).toBe("anthropic/claude-sonnet-4.6");
    // `opus-4` names the 4-series generation, so it stays on 4.8 even though the
    // bare `opus` alias has moved on to Opus 5.
    expect(resolveModelAlias("anthropic/claude-opus-4")).toBe("anthropic/claude-opus-4.8");
    expect(resolveModelAlias("opus-4")).toBe("anthropic/claude-opus-4.8");
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
    expect(resolveModelAlias("openai/free")).toBe("free/nemotron-3.5-lightning"); // "free" is an alias, not a virtual profile
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

  it("promotes bare opus to Opus 5 while every 4.x pin stays routable", () => {
    // Opus 5 takes the bare alias because the move is cost-neutral: $5/$25 and a
    // 1M/128K envelope, identical to Opus 4.8 — so no per-call-cap wallet changes
    // behavior. BlockRun made the same call upstream, repointing its
    // `clawrouter-premium` redirect to anthropic/claude-opus-5 on launch day.
    // Contrast `kimi`, deliberately left on K2.7 because K3 is ~5x the price.
    const opus5 = BLOCKRUN_MODELS.find((m) => m.id === "anthropic/claude-opus-5");
    expect(opus5).toBeDefined();
    expect(opus5?.inputPrice).toBe(5.0);
    expect(opus5?.outputPrice).toBe(25.0);
    expect(opus5?.contextWindow).toBe(1000000);
    expect(opus5?.maxOutput).toBe(128000);

    for (const alias of [
      "opus",
      "opus-5",
      "opus-5.0",
      "opus-5-0",
      "anthropic/opus",
      "anthropic/claude-opus-5.0",
      "anthropic/claude-opus-5-0",
      "blockrun/opus",
      "openai/opus",
    ]) {
      expect(resolveModelAlias(alias)).toBe("anthropic/claude-opus-5");
    }
    // The catalog id must survive resolution untouched — it is not an alias key.
    expect(resolveModelAlias("anthropic/claude-opus-5")).toBe("anthropic/claude-opus-5");

    // Cost-stability callers pinned to a 4.x version keep that version.
    expect(resolveModelAlias("opus-4.8")).toBe("anthropic/claude-opus-4.8");
    expect(resolveModelAlias("anthropic/claude-opus-4-8")).toBe("anthropic/claude-opus-4.8");
    expect(resolveModelAlias("opus-4.7")).toBe("anthropic/claude-opus-4.7");
    expect(resolveModelAlias("opus-4.6")).toBe("anthropic/claude-opus-4.6");
    expect(resolveModelAlias("anthropic/claude-opus-4.5")).toBe("anthropic/claude-opus-4.5");
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

  it("registers GPT-5.5 Pro with gateway pricing and the max-compute shape", () => {
    // Full-shape equality — a subset match cannot fail on a stray flag.
    expect(BLOCKRUN_MODELS.find((m) => m.id === "openai/gpt-5.5-pro")).toEqual({
      id: "openai/gpt-5.5-pro",
      name: "GPT-5.5 Pro",
      version: "5.5",
      inputPrice: 30.0,
      outputPrice: 180.0,
      contextWindow: 1_050_000,
      maxOutput: 128_000,
      reasoning: true,
      vision: true,
      toolCalling: true,
    });
    expect(resolveModelAlias("gpt-5.5-pro")).toBe("openai/gpt-5.5-pro");
    // Catalog id is not an alias key — it must survive resolution untouched.
    expect(resolveModelAlias("openai/gpt-5.5-pro")).toBe("openai/gpt-5.5-pro");
    // Pro tier is deliberately NOT `agentic` (mirrors gpt-5.4-pro): max-compute
    // latency makes it a poor multi-step autonomous pick.
    expect(BLOCKRUN_MODELS.find((m) => m.id === "openai/gpt-5.5-pro")?.agentic).toBeUndefined();
    expect(TOP_MODELS).toContain("openai/gpt-5.5-pro");
  });

  it("registers ChatGPT Instant under the rolling chat-latest id", () => {
    expect(BLOCKRUN_MODELS.find((m) => m.id === "openai/chat-latest")).toEqual({
      id: "openai/chat-latest",
      name: "ChatGPT Instant (GPT-5.5)",
      version: "5.5",
      inputPrice: 5.0,
      outputPrice: 30.0,
      contextWindow: 128_000,
      maxOutput: 128_000,
      vision: true,
      toolCalling: true,
    });
    expect(resolveModelAlias("chat-latest")).toBe("openai/chat-latest");
    expect(resolveModelAlias("chatgpt")).toBe("openai/chat-latest");
    expect(resolveModelAlias("openai/chat-latest")).toBe("openai/chat-latest");
    // Chat/vision only upstream — claiming reasoning would mis-route it into the
    // REASONING tier and inflate its per-model timeout.
    const instant = BLOCKRUN_MODELS.find((m) => m.id === "openai/chat-latest");
    expect(instant?.reasoning).toBeUndefined();
    expect(instant?.agentic).toBeUndefined();
    // Deliberately NOT in the picker: a rolling alias is a pin-on-purpose model,
    // not a curated default (same treatment as sonnet-4.5 / opus-4.6).
    expect(TOP_MODELS).not.toContain("openai/chat-latest");
  });
});

describe("capability flags vs blockrun's catalog", () => {
  // `vision` gates filterByVision() — an under-claim drops the model from the
  // candidate pool on image requests; an over-claim routes an image to a model
  // that cannot read it. `reasoning` enrolls the id in REASONING_MODEL_IDS,
  // which triples the per-model timeout (60s -> 180s) on a hung upstream.
  // Both were silently drifting from blockrun's categories until the 2026-07-25
  // audit, so the resolved set is pinned here rather than left to drift again.

  it("marks every max-compute Pro tier vision-capable", () => {
    // Missing on 5.2-pro/5.4-pro until 2026-07-25 — blockrun lists vision on
    // both, so image requests were skipping them for no reason.
    for (const id of ["openai/gpt-5.2-pro", "openai/gpt-5.4-pro", "openai/gpt-5.5-pro"]) {
      expect(BLOCKRUN_MODELS.find((m) => m.id === id)?.vision).toBe(true);
    }
  });

  it("marks thinking-capable models as reasoning so they get the 180s timeout", () => {
    for (const id of [
      "google/gemini-3-flash-preview",
      "free/nemotron-3.5-lightning",
      "free/nemotron-3-nano-30b",
      "free/nemotron-3-ultra-550b",
      "free/north-mini-code",
      "zai/glm-5.3",
      "zai/glm-5.3-flash",
      "zai/glm-5",
      "zai/glm-5.1",
      "zai/glm-5.2",
      "zai/glm-5-turbo",
    ]) {
      expect(BLOCKRUN_MODELS.find((m) => m.id === id)?.reasoning).toBe(true);
    }
  });

  it("keeps vision on Claude models that blockrun's catalog under-claims", () => {
    // blockrun lists haiku-4.5 as chat+coding and sonnet-4.6 as
    // chat+coding+reasoning — neither carries `vision`. That is an upstream
    // catalog bug, not a ClawRouter over-claim: a live gateway probe on
    // 2026-07-25 sent an image to claude-haiku-4.5 and it answered correctly.
    // Dropping the flag to "match" blockrun would break image routing to the
    // premium REASONING and agentic COMPLEX/REASONING primaries.
    for (const id of ["anthropic/claude-haiku-4.5", "anthropic/claude-sonnet-4.6"]) {
      expect(BLOCKRUN_MODELS.find((m) => m.id === id)?.vision).toBe(true);
    }
  });

  it("marks MiniMax M3 vision-capable so image_url requests reach it", () => {
    // blockrun's catalog lists M3 as chat+reasoning+coding with no `vision`
    // category, but that is an upstream under-claim (same class as the Claude
    // models above): a live gateway probe on 2026-08-02 sent a two-color image
    // to minimax/minimax-m3 and it described both colors and their positions
    // correctly. Without the flag, filterByVision() excluded M3 whenever a
    // request carried an image_url content part. M2.7 is text-only upstream
    // and must stay without the flag.
    expect(BLOCKRUN_MODELS.find((m) => m.id === "minimax/minimax-m3")?.vision).toBe(true);
    expect(BLOCKRUN_MODELS.find((m) => m.id === "minimax/minimax-m2.7")?.vision).toBeUndefined();
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
    // The `free` alias resolves to nemotron-3.5-lightning; the picker label must
    // agree (the retired "Nemotron Ultra 253B" label shadowed it until v0.12.206,
    // "GPT-OSS 120B" outlived that model's death by two weeks until v0.12.250,
    // and "Step 3.7 Flash" outlived NVIDIA's 2026-08-30 sweep until v0.12.258).
    expect(freeEntries[0]!.name).toContain("Nemotron 3.5 Lightning");
  });

  it("advertises visible models in top-models order", () => {
    expect(VISIBLE_OPENCLAW_MODELS).toHaveLength(TOP_MODELS.length);
    expect(VISIBLE_OPENCLAW_MODELS.map((m) => m.id)).toEqual(TOP_MODELS);
  });
});
