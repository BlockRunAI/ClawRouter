import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// OpenClaw keeps a third model-list plane at ~/.openclaw/agents/<agent>/agent/models.json,
// separate from openclaw.json's picker and allowlist planes. Nothing synced it before
// v0.12.223, so it served long-retired models forever. These pin the repair.
describe("syncAgentModelCache", () => {
  let homeDir: string | undefined;

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("node:os");
    if (homeDir) {
      rmSync(homeDir, { recursive: true, force: true });
      homeDir = undefined;
    }
  });

  async function withCache(cache: unknown) {
    homeDir = mkdtempSync(join(tmpdir(), "clawrouter-agent-cache-"));
    const agentDir = join(homeDir, ".openclaw", "agents", "main", "agent");
    mkdirSync(agentDir, { recursive: true });
    const cachePath = join(agentDir, "models.json");
    writeFileSync(cachePath, JSON.stringify(cache, null, 2));

    vi.doMock("node:os", async () => ({
      ...(await vi.importActual<typeof import("node:os")>("node:os")),
      homedir: () => homeDir,
    }));

    const mod = await import("./index.js");
    return { mod, cachePath };
  }

  const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));

  it("replaces a stale cache with the current picker set, in order", async () => {
    const { mod, cachePath } = await withCache({
      providers: {
        blockrun: {
          baseUrl: "http://127.0.0.1:8402/v1",
          api: "openai-completions",
          apiKey: "x402-proxy-handles-auth",
          models: [
            { id: "openai/gpt-5.2", name: "retired" },
            { id: "openai/gpt-4.1", name: "retired" },
            { id: "free", name: "dupe" },
            { id: "free", name: "dupe" },
          ],
        },
      },
    });

    mod.syncAgentModelCache({ info: vi.fn() }, { forceWrite: true });

    const ids = read(cachePath).providers.blockrun.models.map((m: { id: string }) => m.id);
    expect(ids).toEqual(mod.VISIBLE_OPENCLAW_MODELS.map((m) => m.id));
    expect(ids).not.toContain("openai/gpt-5.2");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("rewrites a set-equal but misordered cache (order is what the picker renders)", async () => {
    const homeSetup = await withCache({ providers: { blockrun: { models: [] } } });
    const expected = homeSetup.mod.VISIBLE_OPENCLAW_MODELS;
    writeFileSync(
      homeSetup.cachePath,
      JSON.stringify({ providers: { blockrun: { models: [...expected].reverse() } } }),
    );

    homeSetup.mod.syncAgentModelCache({ info: vi.fn() }, { forceWrite: true });

    const ids = read(homeSetup.cachePath).providers.blockrun.models.map(
      (m: { id: string }) => m.id,
    );
    expect(ids).toEqual(expected.map((m) => m.id));
  });

  it("preserves other providers and blockrun's non-models fields", async () => {
    const { mod, cachePath } = await withCache({
      providers: {
        blockrun: { baseUrl: "http://127.0.0.1:9999/v1", apiKey: "keep-me", models: [] },
        openai: { models: [{ id: "gpt-5" }] },
      },
    });

    mod.syncAgentModelCache({ info: vi.fn() }, { forceWrite: true });

    const out = read(cachePath);
    expect(out.providers.openai.models).toEqual([{ id: "gpt-5" }]);
    expect(out.providers.blockrun.baseUrl).toBe("http://127.0.0.1:9999/v1");
    expect(out.providers.blockrun.apiKey).toBe("keep-me");
  });

  it("never introduces a blockrun provider into a cache that lacks one", async () => {
    const { mod, cachePath } = await withCache({ providers: { openai: { models: [] } } });

    mod.syncAgentModelCache({ info: vi.fn() }, { forceWrite: true });

    expect(read(cachePath).providers.blockrun).toBeUndefined();
  });

  it("is a no-op outside gateway mode unless forced (install-transaction safety)", async () => {
    const { mod, cachePath } = await withCache({
      providers: { blockrun: { models: [{ id: "openai/gpt-5.2" }] } },
    });

    mod.syncAgentModelCache({ info: vi.fn() }); // no forceWrite, argv has no "gateway"

    expect(read(cachePath).providers.blockrun.models).toEqual([{ id: "openai/gpt-5.2" }]);
  });

  it("survives a corrupt cache without throwing", async () => {
    homeDir = mkdtempSync(join(tmpdir(), "clawrouter-agent-cache-"));
    const agentDir = join(homeDir, ".openclaw", "agents", "main", "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "models.json"), "{ not json");

    vi.doMock("node:os", async () => ({
      ...(await vi.importActual<typeof import("node:os")>("node:os")),
      homedir: () => homeDir,
    }));

    const mod = await import("./index.js");
    const info = vi.fn();
    expect(() => mod.syncAgentModelCache({ info }, { forceWrite: true })).not.toThrow();
    expect(info).toHaveBeenCalledWith(expect.stringContaining("Skipped main model cache"));
  });
});
