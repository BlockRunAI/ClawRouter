/**
 * OpenClaw 2026.8+ freezes the allowlist into `agents.defaults.modelPolicy.allow` on its first
 * config write and stops reading `agents.defaults.models` (resolveConfiguredModelPolicyAllow).
 * Models ClawRouter shipped after that never reached `/model`. The gateway-start sync must keep
 * the blockrun/* entries of `modelPolicy.allow` equal to the ones it writes to
 * `agents.defaults.models`, and must not create `modelPolicy` where OpenClaw has not, since a
 * pre-2026.8 OpenClaw refuses a config that carries it.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type Defaults = {
  models?: Record<string, unknown>;
  modelPolicy?: { allow?: unknown[]; deny?: unknown[] };
};

describe("gateway-start sync of OpenClaw's modelPolicy.allow", () => {
  let homeDir: string | undefined;

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("node:os");
    if (homeDir) {
      rmSync(homeDir, { recursive: true, force: true });
      homeDir = undefined;
    }
  });

  async function syncFrom(config: Record<string, unknown>): Promise<Defaults> {
    homeDir = mkdtempSync(join(tmpdir(), "clawrouter-model-policy-"));
    const openclawDir = join(homeDir, ".openclaw");
    mkdirSync(openclawDir, { recursive: true });
    const configPath = join(openclawDir, "openclaw.json");
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    vi.doMock("node:os", async () => ({
      ...(await vi.importActual<typeof import("node:os")>("node:os")),
      homedir: () => homeDir,
    }));
    const mod = await import("./index.js");
    mod.injectModelsConfig({ info: vi.fn() }, { forceWrite: true });
    return JSON.parse(readFileSync(configPath, "utf8")).agents.defaults as Defaults;
  }

  it("adds every synced BlockRun model to a frozen allow list and prunes retired ones", async () => {
    const defaults = await syncFrom({
      meta: { migrations: { modelPolicyAllowlist: true } },
      agents: {
        defaults: {
          model: { primary: "blockrun/auto" },
          models: { "blockrun/auto": {} },
          modelPolicy: {
            allow: ["anthropic/claude-x", "blockrun/auto", "blockrun/retired/model-0"],
            deny: ["blockrun/retired/model-1"],
          },
        },
      },
    });

    const synced = Object.keys(defaults.models ?? {}).filter((key) => key.startsWith("blockrun/"));
    const allow = defaults.modelPolicy?.allow ?? [];
    expect(synced.length).toBeGreaterThan(10);
    expect(allow.filter((entry) => String(entry).startsWith("blockrun/")).sort()).toEqual(
      [...synced].sort(),
    );
    expect(allow).toContain("anthropic/claude-x");
    expect(allow).not.toContain("blockrun/retired/model-0");
    expect(defaults.modelPolicy?.deny).toEqual(["blockrun/retired/model-1"]);
  });

  it("does not create modelPolicy on a config OpenClaw has not migrated", async () => {
    const defaults = await syncFrom({
      agents: { defaults: { model: { primary: "blockrun/auto" }, models: {} } },
    });

    expect(Object.keys(defaults.models ?? {}).length).toBeGreaterThan(10);
    expect(defaults).not.toHaveProperty("modelPolicy");
  });
});
