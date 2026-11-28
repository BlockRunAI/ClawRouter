import { describe, expect, it } from "vitest";

import {
  removeBlockrunModelPolicyAllow,
  syncBlockrunModelPolicyAllow,
} from "./openclaw-model-policy.js";

const EXPECTED = [
  "blockrun/auto",
  "blockrun/openai/gpt-6.2-sol",
  "blockrun/moonshot/kimi-k3.1-pro",
];

describe("syncBlockrunModelPolicyAllow", () => {
  it("adds models shipped after OpenClaw froze the allowlist, and prunes retired ones", () => {
    // What OpenClaw 2026.8+ leaves after its one-time migration of agents.defaults.models.
    const defaults = {
      modelPolicy: {
        allow: ["openrouter/x-ai/grok-4", "blockrun/auto", "blockrun/openai/o3"],
        deny: ["blockrun/openai/gpt-6.2-sol"],
      },
    };

    expect(syncBlockrunModelPolicyAllow(defaults, EXPECTED)).toEqual({ added: 2, pruned: 1 });
    expect(defaults.modelPolicy.allow).toEqual([
      "openrouter/x-ai/grok-4",
      "blockrun/auto",
      "blockrun/openai/gpt-6.2-sol",
      "blockrun/moonshot/kimi-k3.1-pro",
    ]);
    // The user's deny list is theirs: never touched.
    expect(defaults.modelPolicy.deny).toEqual(["blockrun/openai/gpt-6.2-sol"]);
  });

  it("is a no-op once in sync", () => {
    const defaults = { modelPolicy: { allow: [...EXPECTED] } };
    expect(syncBlockrunModelPolicyAllow(defaults, EXPECTED)).toEqual({ added: 0, pruned: 0 });
    expect(defaults.modelPolicy.allow).toEqual(EXPECTED);
  });

  it("writes nothing when OpenClaw has not created modelPolicy (older OpenClaw, or not migrated yet)", () => {
    // Writing modelPolicy into a pre-2026.8 OpenClaw config bricks it, and a not-yet-migrated
    // config will copy agents.defaults.models on its own.
    const defaults: Record<string, unknown> = { models: { "blockrun/auto": {} } };
    expect(syncBlockrunModelPolicyAllow(defaults, EXPECTED)).toEqual({ added: 0, pruned: 0 });
    expect(defaults).toEqual({ models: { "blockrun/auto": {} } });
  });

  it("never creates an allow list where there is none: no `allow` means no restriction", () => {
    const defaults = { modelPolicy: { deny: ["x/y"] } };
    expect(syncBlockrunModelPolicyAllow(defaults, EXPECTED)).toEqual({ added: 0, pruned: 0 });
    expect(defaults.modelPolicy).toEqual({ deny: ["x/y"] });
  });

  it("leaves the list alone when a wildcard already admits every BlockRun model", () => {
    for (const wildcard of ["blockrun/*", "*", " blockrun/* "]) {
      const defaults = { modelPolicy: { allow: [wildcard, "blockrun/openai/o3"] } };
      expect(syncBlockrunModelPolicyAllow(defaults, EXPECTED)).toEqual({ added: 0, pruned: 0 });
      expect(defaults.modelPolicy.allow).toEqual([wildcard, "blockrun/openai/o3"]);
    }
  });

  it("keeps entries it does not own: other providers, prefix wildcards, non-strings", () => {
    const defaults = {
      modelPolicy: { allow: ["blockrun/openai/*", 42, "anthropic/claude-x", "blockrun/auto"] },
    };
    syncBlockrunModelPolicyAllow(defaults, ["blockrun/auto"]);
    expect(defaults.modelPolicy.allow).toEqual([
      "blockrun/openai/*",
      42,
      "anthropic/claude-x",
      "blockrun/auto",
    ]);
  });

  it("ignores a malformed modelPolicy instead of throwing", () => {
    for (const modelPolicy of [null, "x", [], { allow: "blockrun/auto" }]) {
      const defaults: Record<string, unknown> = { modelPolicy };
      expect(syncBlockrunModelPolicyAllow(defaults, EXPECTED)).toEqual({ added: 0, pruned: 0 });
      expect(defaults.modelPolicy).toEqual(modelPolicy);
    }
  });
});

describe("removeBlockrunModelPolicyAllow", () => {
  it("removes BlockRun models and keeps everything else", () => {
    const defaults = {
      modelPolicy: { allow: ["anthropic/claude-x", "blockrun/auto", "blockrun/openai/*"] },
    };
    expect(removeBlockrunModelPolicyAllow(defaults)).toBe(1);
    expect(defaults.modelPolicy.allow).toEqual(["anthropic/claude-x", "blockrun/openai/*"]);
  });

  it("drops `allow` rather than leave it empty once only BlockRun models were in it", () => {
    const defaults: { modelPolicy: Record<string, unknown> } = {
      modelPolicy: { allow: ["blockrun/auto", "blockrun/openai/gpt-6.2-sol"], deny: [] },
    };
    expect(removeBlockrunModelPolicyAllow(defaults)).toBe(2);
    expect(defaults.modelPolicy).toEqual({ deny: [] });
  });

  it("does nothing without an explicit allow list", () => {
    const defaults: Record<string, unknown> = { models: {} };
    expect(removeBlockrunModelPolicyAllow(defaults)).toBe(0);
    expect(defaults).toEqual({ models: {} });
  });
});
