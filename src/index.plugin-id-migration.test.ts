import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * #305 — OpenClaw bundles its own plugin under the id `clawrouter` since the
 * 2026.7.1 line, so ours was overridden and never loaded. We renamed to
 * `blockrun-clawrouter`; installs made before the rename still carry a
 * `plugins.entries.clawrouter` entry that no longer refers to us.
 */
type PluginEntry = { enabled?: boolean };
type PluginsConfig = {
  plugins: {
    entries: Record<string, PluginEntry>;
    allow?: string[];
    deny?: string[];
    installs?: Record<string, unknown>;
  };
};

describe("plugin id migration", () => {
  let home: string;
  const logger = { info: () => {}, warn: () => {}, error: () => {} };

  beforeEach(async () => {
    vi.resetModules();
    home = await mkdtemp(join(tmpdir(), "clawrouter-pluginid-"));
    await mkdir(join(home, ".openclaw"), { recursive: true });
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return { ...actual, homedir: () => home };
    });
  });

  afterEach(async () => {
    vi.doUnmock("node:os");
    await rm(home, { recursive: true, force: true });
  });

  async function run(config: unknown): Promise<PluginsConfig> {
    await writeFile(join(home, ".openclaw", "openclaw.json"), JSON.stringify(config, null, 2));
    const { injectModelsConfig } = await import("./index.js");
    injectModelsConfig(logger as never, { forceWrite: true });
    const raw = await readFile(join(home, ".openclaw", "openclaw.json"), "utf8");
    return JSON.parse(raw) as PluginsConfig;
  }

  it("moves a pre-rename entry to the new id, preserving the enabled flag", async () => {
    const out = await run({ plugins: { entries: { clawrouter: { enabled: true } } } });
    expect(out.plugins.entries["blockrun-clawrouter"]).toEqual({ enabled: true });
    expect(out.plugins.entries.clawrouter).toBeUndefined();
  });

  it("preserves a disabled choice rather than silently re-enabling", async () => {
    const out = await run({ plugins: { entries: { clawrouter: { enabled: false } } } });
    expect(out.plugins.entries["blockrun-clawrouter"]).toEqual({ enabled: false });
  });

  it("never clobbers an existing blockrun-clawrouter entry", async () => {
    const out = await run({
      plugins: {
        entries: { clawrouter: { enabled: true }, "blockrun-clawrouter": { enabled: false } },
      },
    });
    expect(out.plugins.entries["blockrun-clawrouter"]).toEqual({ enabled: false });
  });

  it("leaves a config with no clawrouter entry alone", async () => {
    const out = await run({ plugins: { entries: { other: { enabled: true } } } });
    expect(out.plugins.entries["blockrun-clawrouter"]).toBeUndefined();
    expect(out.plugins.entries.other).toEqual({ enabled: true });
  });

  // plugins.allow is an EXCLUSIVE allowlist — OpenClaw's docs: "if plugins.allow
  // is set, the installed plugin id must be in that list before the plugin can
  // load". Missing this would BLOCK the plugin outright, worse than the
  // collision the rename fixes.
  it("adds the new id to plugins.allow so the rename cannot block loading", async () => {
    const out = await run({
      plugins: { entries: { clawrouter: { enabled: true } }, allow: ["clawrouter", "other"] },
    });
    expect(out.plugins.allow).toContain("blockrun-clawrouter");
  });

  it("leaves the old id in plugins.allow — it may now permit OpenClaw's bundled plugin", async () => {
    const out = await run({ plugins: { entries: {}, allow: ["clawrouter"] } });
    expect(out.plugins.allow).toEqual(["clawrouter", "blockrun-clawrouter"]);
  });

  it("honours an explicit deny of the old id", async () => {
    const out = await run({ plugins: { entries: {}, deny: ["clawrouter"] } });
    expect(out.plugins.deny).toContain("blockrun-clawrouter");
  });

  it("renames plugins.installs, which is unambiguously ours", async () => {
    const out = await run({
      plugins: { entries: {}, installs: { clawrouter: { version: "0.12.264" } } },
    });
    expect(out.plugins.installs?.["blockrun-clawrouter"]).toEqual({ version: "0.12.264" });
    expect(out.plugins.installs?.clawrouter).toBeUndefined();
  });

  it("does not touch an allowlist that never mentioned the old id", async () => {
    const out = await run({ plugins: { entries: {}, allow: ["something-else"] } });
    expect(out.plugins.allow).toEqual(["something-else"]);
  });
});
