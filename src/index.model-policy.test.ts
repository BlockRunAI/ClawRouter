import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// OpenClaw 2026.8+ gates the /model picker on agents.defaults.modelPolicy.allow,
// a plain string array. Nothing synced it before, so newly-shipped models were
// rejected with "not available for this agent". These pin the repair.
describe("injectModelsConfig — modelPolicy.allow sync", () => {
  let homeDir: string | undefined;

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("node:os");
    if (homeDir) {
      rmSync(homeDir, { recursive: true, force: true });
      homeDir = undefined;
    }
  });

  async function withConfig(config: unknown) {
    homeDir = mkdtempSync(join(tmpdir(), "clawrouter-model-policy-"));
    const configDir = join(homeDir, ".openclaw");
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, "openclaw.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    vi.doMock("node:os", async () => ({
      ...(await vi.importActual<typeof import("node:os")>("node:os")),
      homedir: () => homeDir,
    }));

    const mod = await import("./index.js");
    const { TOP_MODELS } = await import("./top-models.js");
    return { mod, configPath, TOP_MODELS };
  }

  const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));

  it("adds newly-shipped blockrun models to modelPolicy.allow and prunes stale ones", async () => {
    const { mod, configPath, TOP_MODELS } = await withConfig({
      agents: {
        defaults: {
          modelPolicy: {
            allow: [
              "blockrun/openai/gpt-5.5",
              "blockrun/deepseek/deepseek-v4-pro",
              "blockrun/free/retired-model",
              "minimax/MiniMax-M2.7",
            ],
          },
        },
      },
    });

    mod.injectModelsConfig({ info: vi.fn() }, { forceWrite: true });

    const allow = read(configPath).agents.defaults.modelPolicy.allow as string[];
    expect(allow).toContain("blockrun/deepseek/deepseek-v4-flash");
    expect(allow).not.toContain("blockrun/free/retired-model");
    // non-blockrun entries preserved
    expect(allow).toContain("minimax/MiniMax-M2.7");
    // every TOP_MODEL is present under its blockrun/ prefix
    const expected = new Set(TOP_MODELS.map((id: string) => `blockrun/${id}`));
    for (const id of TOP_MODELS as string[]) {
      expect(allow).toContain(`blockrun/${id}`);
    }
    const blockrunEntries = allow.filter((k) => k.startsWith("blockrun/"));
    expect(blockrunEntries.length).toBe(expected.size);
  });

  it("creates modelPolicy.allow when the key is absent", async () => {
    const { mod, configPath, TOP_MODELS } = await withConfig({ agents: { defaults: {} } });

    mod.injectModelsConfig({ info: vi.fn() }, { forceWrite: true });

    const allow = read(configPath).agents.defaults.modelPolicy.allow as string[];
    expect(Array.isArray(allow)).toBe(true);
    expect(allow).toContain("blockrun/deepseek/deepseek-v4-flash");
  });

  it("treats a non-array modelPolicy.allow as empty instead of crashing", async () => {
    const { mod, configPath, TOP_MODELS } = await withConfig({
      agents: { defaults: { modelPolicy: { allow: "not-an-array" } } },
    });

    mod.injectModelsConfig({ info: vi.fn() }, { forceWrite: true });

    const allow = read(configPath).agents.defaults.modelPolicy.allow as string[];
    expect(Array.isArray(allow)).toBe(true);
    expect(allow).toContain("blockrun/deepseek/deepseek-v4-flash");
  });
});
