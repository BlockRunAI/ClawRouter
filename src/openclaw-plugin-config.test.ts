import { describe, expect, it } from "vitest";
import { BLOCKRUN_PLUGIN_ID, prepareBlockRunPluginConfig } from "./openclaw-plugin-config.js";

describe("OpenClaw plugin id preparation", () => {
  it("enables the BlockRun id for an explicit setup without changing the official id", () => {
    const config = {
      plugins: {
        entries: { clawrouter: { enabled: false } },
        allow: ["clawrouter", "other"],
        deny: ["clawrouter", BLOCKRUN_PLUGIN_ID],
      },
    };

    expect(prepareBlockRunPluginConfig(config, { explicitSetup: true })).toBe(true);
    expect(config.plugins.entries.clawrouter).toEqual({ enabled: false });
    expect((config.plugins.entries as Record<string, unknown>)[BLOCKRUN_PLUGIN_ID]).toEqual({
      enabled: true,
    });
    expect(config.plugins.allow).toEqual(["clawrouter", "other", BLOCKRUN_PLUGIN_ID]);
    expect(config.plugins.deny).toEqual(["clawrouter"]);
  });

  it("moves proven BlockRun fields without deleting the official entry", () => {
    const config = {
      plugins: {
        entries: {
          clawrouter: {
            enabled: false,
            officialSetting: "keep",
            walletKey: "0xlegacy",
            config: { routing: { mode: "eco" }, officialNested: true },
          },
        },
      },
    };

    prepareBlockRunPluginConfig(config, { legacyBlockRunInstall: true });

    expect(config.plugins.entries.clawrouter).toEqual({
      enabled: false,
      officialSetting: "keep",
      config: { officialNested: true },
    });
    expect((config.plugins.entries as Record<string, unknown>)[BLOCKRUN_PLUGIN_ID]).toEqual({
      enabled: false,
      walletKey: "0xlegacy",
      config: { routing: { mode: "eco" } },
    });
  });

  it("keeps values already configured under the new id", () => {
    const config = {
      plugins: {
        entries: {
          clawrouter: { walletKey: "legacy", routing: { tier: "eco" } },
          [BLOCKRUN_PLUGIN_ID]: { walletKey: "current", enabled: true },
        },
      },
    };

    prepareBlockRunPluginConfig(config, { legacyBlockRunInstall: true });

    expect(config.plugins.entries.clawrouter).toEqual({});
    expect(config.plugins.entries[BLOCKRUN_PLUGIN_ID]).toEqual({
      walletKey: "current",
      routing: { tier: "eco" },
      enabled: true,
    });
  });

  it("does not infer ownership from the ambiguous old id", () => {
    const config = {
      plugins: {
        entries: { clawrouter: { enabled: true } },
        allow: ["clawrouter"],
        deny: ["clawrouter"],
      },
    };

    expect(prepareBlockRunPluginConfig(config)).toBe(false);
    expect(config.plugins).toEqual({
      entries: { clawrouter: { enabled: true } },
      allow: ["clawrouter"],
      deny: ["clawrouter"],
    });
  });

  it("only mirrors allow/deny when a legacy BlockRun install was proven", () => {
    const config = {
      plugins: { entries: {}, allow: ["clawrouter"], deny: ["clawrouter"] },
    };

    prepareBlockRunPluginConfig(config, { legacyBlockRunInstall: true });

    expect(config.plugins.allow).toContain(BLOCKRUN_PLUGIN_ID);
    expect(config.plugins.deny).toContain(BLOCKRUN_PLUGIN_ID);
    expect(config.plugins.allow).toContain("clawrouter");
    expect(config.plugins.deny).toContain("clawrouter");
  });

  it("removes the schema-invalid legacy installs key instead of renaming it", () => {
    const config = {
      plugins: {
        entries: {},
        installs: { clawrouter: { version: "0.12.264" }, other: { version: "1.0.0" } },
      },
    };

    prepareBlockRunPluginConfig(config, { stripUnsupportedInstalls: true });

    expect("installs" in config.plugins).toBe(false);
  });

  it("is idempotent", () => {
    const config = { plugins: { entries: {}, allow: [] as string[] } };
    expect(prepareBlockRunPluginConfig(config, { explicitSetup: true })).toBe(true);
    expect(prepareBlockRunPluginConfig(config, { explicitSetup: true })).toBe(false);
  });
});
