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

  async function run(config: unknown): Promise<Record<string, never>> {
    await writeFile(join(home, ".openclaw", "openclaw.json"), JSON.stringify(config, null, 2));
    const { injectModelsConfig } = await import("./index.js");
    injectModelsConfig(logger as never, { forceWrite: true });
    return JSON.parse(await readFile(join(home, ".openclaw", "openclaw.json"), "utf8"));
  }

  it("moves a pre-rename entry to the new id, preserving the enabled flag", async () => {
    const out = (await run({ plugins: { entries: { clawrouter: { enabled: true } } } })) as {
      plugins: { entries: Record<string, { enabled: boolean }> };
    };
    expect(out.plugins.entries["blockrun-clawrouter"]).toEqual({ enabled: true });
    expect(out.plugins.entries.clawrouter).toBeUndefined();
  });

  it("preserves a disabled choice rather than silently re-enabling", async () => {
    const out = (await run({ plugins: { entries: { clawrouter: { enabled: false } } } })) as {
      plugins: { entries: Record<string, { enabled: boolean }> };
    };
    expect(out.plugins.entries["blockrun-clawrouter"]).toEqual({ enabled: false });
  });

  it("never clobbers an existing blockrun-clawrouter entry", async () => {
    const out = (await run({
      plugins: {
        entries: { clawrouter: { enabled: true }, "blockrun-clawrouter": { enabled: false } },
      },
    })) as { plugins: { entries: Record<string, { enabled: boolean }> } };
    expect(out.plugins.entries["blockrun-clawrouter"]).toEqual({ enabled: false });
  });

  it("leaves a config with no clawrouter entry alone", async () => {
    const out = (await run({ plugins: { entries: { other: { enabled: true } } } })) as {
      plugins: { entries: Record<string, unknown> };
    };
    expect(out.plugins.entries["blockrun-clawrouter"]).toBeUndefined();
    expect(out.plugins.entries.other).toEqual({ enabled: true });
  });
});
