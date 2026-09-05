/**
 * The gateway-start plugin-id migration must recognise an ordinary pre-rename
 * install (#319).
 *
 * Since #313 the gate asked for BlockRun-owned config fields (`walletKey`,
 * `routing`) under `plugins.entries.clawrouter`. OpenClaw's installer commits
 * `{ enabled: true }` and nothing else for an enabledByDefault plugin, and the
 * wallet lives at `~/.openclaw/blockrun/wallet.key` rather than in
 * openclaw.json — so the common case carries neither field and was never
 * migrated on the `npm update -g` + restart path. Two consequences, verified
 * against a real openclaw@2026.8.2:
 *
 *   - a legacy `{ enabled: true }` ends up explicitly enabling OpenClaw's own
 *     bundled router, a product the user never configured
 *   - a legacy `{ enabled: false }` — a pre-rename opt-out — is INVERTED: the
 *     bundled router goes off, BlockRun goes on by the installer default, and
 *     the proxy comes up on a machine where the user had turned it off
 *
 * The fix consults the same on-disk proof `clawrouter setup` already uses. The
 * gate must stay closed without it: that id belongs to OpenClaw now, and
 * migrating an entry we did not write reconfigures an unrelated plugin.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("gateway-start plugin-id migration gate", () => {
  let homeDir: string | undefined;

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("node:os");
    if (homeDir) {
      rmSync(homeDir, { recursive: true, force: true });
      homeDir = undefined;
    }
  });

  /**
   * @param legacyEntry what `plugins.entries.clawrouter` holds on disk
   * @param legacyPackageName name in the legacy extension's package.json, or
   *        undefined to leave the directory absent entirely
   */
  async function withHome(legacyEntry: unknown, legacyPackageName?: string) {
    homeDir = mkdtempSync(join(tmpdir(), "clawrouter-plugin-id-"));
    const openclawDir = join(homeDir, ".openclaw");
    mkdirSync(openclawDir, { recursive: true });
    const configPath = join(openclawDir, "openclaw.json");
    writeFileSync(
      configPath,
      JSON.stringify({ plugins: { entries: { clawrouter: legacyEntry } } }, null, 2),
    );

    if (legacyPackageName !== undefined) {
      const legacyDir = join(openclawDir, "extensions", "clawrouter");
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(
        join(legacyDir, "package.json"),
        JSON.stringify({ name: legacyPackageName, version: "0.12.100" }),
      );
    }

    vi.doMock("node:os", async () => ({
      ...(await vi.importActual<typeof import("node:os")>("node:os")),
      homedir: () => homeDir,
    }));

    const mod = await import("./index.js");
    mod.injectModelsConfig({ info: vi.fn() }, { forceWrite: true });
    return JSON.parse(readFileSync(configPath, "utf8")).plugins.entries as Record<
      string,
      { enabled?: boolean }
    >;
  }

  it("migrates a bare `{ enabled: true }` when the legacy package is ours", async () => {
    const entries = await withHome({ enabled: true }, "@blockrun/clawrouter");
    expect(entries["blockrun-clawrouter"]?.enabled).toBe(true);
  });

  it("carries a pre-rename opt-out across instead of inverting it", async () => {
    // The failure this replaces: `clawrouter` disabled (silencing OpenClaw's
    // bundled router) while `blockrun-clawrouter` came up enabled by the
    // installer default — the proxy running on a machine where it was off.
    const entries = await withHome({ enabled: false }, "@blockrun/clawrouter");
    expect(entries["blockrun-clawrouter"]?.enabled).toBe(false);
  });

  it("leaves the entry alone when nothing proves it was ours", async () => {
    // No BlockRun-owned config fields and no legacy package directory: this is
    // what an entry OpenClaw wrote for its own bundled router looks like, and
    // claiming it would reconfigure someone else's plugin.
    const entries = await withHome({ enabled: true });
    expect(entries["blockrun-clawrouter"]).toBeUndefined();
    expect(entries.clawrouter?.enabled).toBe(true);
  });

  it("does not treat someone else's package at that path as proof", async () => {
    const entries = await withHome({ enabled: true }, "clawrouter");
    expect(entries["blockrun-clawrouter"]).toBeUndefined();
  });

  it("still migrates on config-field evidence alone, with no package on disk", async () => {
    // The #313 gate stays — an operator who hand-set `walletKey` has no
    // extensions directory if they installed by path.
    const entries = await withHome({ enabled: true, walletKey: "0xdead" });
    expect(entries["blockrun-clawrouter"]?.enabled).toBe(true);
  });
});
