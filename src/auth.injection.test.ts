import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// The legacy auth-profiles.json write is now sqlite-aware: beside an
// openclaw-agent.sqlite store the file is obsolete — and since OpenClaw
// 2026.8.1 a leftover legacy file beside an empty store fails auth migration
// closed, bricking dispatch for the whole agent fleet. These pin the new
// behavior.
describe("injectAuthProfile", () => {
  let homeDir: string | undefined;

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("node:os");
    if (homeDir) {
      rmSync(homeDir, { recursive: true, force: true });
      homeDir = undefined;
    }
  });

  async function withHome() {
    homeDir = mkdtempSync(join(tmpdir(), "clawrouter-auth-profile-"));
    vi.doMock("node:os", async () => ({
      ...(await vi.importActual<typeof import("node:os")>("node:os")),
      homedir: () => homeDir,
    }));
    const mod = await import("./index.js");
    return { mod, homeDir };
  }

  const agentDir = (home: string, agent: string) =>
    join(home, ".openclaw", "agents", agent, "agent");
  const authPath = (home: string, agent: string) =>
    join(agentDir(home, agent), "auth-profiles.json");

  it("still bootstraps the legacy JSON when no SQLite store exists", async () => {
    const { mod, homeDir } = await withHome();
    mkdirSync(agentDir(homeDir, "main"), { recursive: true });
    mkdirSync(agentDir(homeDir, "mike"), { recursive: true });

    mod.injectAuthProfile({ info: vi.fn() });

    expect(existsSync(authPath(homeDir, "mike"))).toBe(true);
    const store = JSON.parse(readFileSync(authPath(homeDir, "mike"), "utf8"));
    expect(store.profiles["blockrun:default"]?.key).toBe("x402-proxy-handles-auth");
  });

  it("never writes into the shared auth-owner directory, even without a store", async () => {
    const { mod, homeDir } = await withHome();
    mkdirSync(agentDir(homeDir, "main"), { recursive: true });

    mod.injectAuthProfile({ info: vi.fn() });

    expect(existsSync(authPath(homeDir, "main"))).toBe(false);
  });

  it("does not write the legacy JSON beside an existing SQLite store", async () => {
    const { mod, homeDir } = await withHome();
    const dir = agentDir(homeDir, "mike");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "openclaw-agent.sqlite"), "placeholder bytes");

    mod.injectAuthProfile({ info: vi.fn() });

    expect(existsSync(authPath(homeDir, "mike"))).toBe(false);
  });

  it("removes our own placeholder beside a SQLite store", async () => {
    const { mod, homeDir } = await withHome();
    const dir = agentDir(homeDir, "mike");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "openclaw-agent.sqlite"), "placeholder bytes");
    writeFileSync(
      authPath(homeDir, "mike"),
      JSON.stringify({
        version: 1,
        profiles: {
          "blockrun:default": {
            type: "api_key",
            provider: "blockrun",
            key: "x402-proxy-handles-auth",
          },
        },
      }),
    );

    mod.injectAuthProfile({ info: vi.fn() });

    expect(existsSync(authPath(homeDir, "mike"))).toBe(false);
  });

  it("never removes a JSON file that carries real credentials", async () => {
    const { mod, homeDir } = await withHome();
    const dir = agentDir(homeDir, "mike");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "openclaw-agent.sqlite"), "placeholder bytes");
    writeFileSync(
      authPath(homeDir, "mike"),
      JSON.stringify({
        version: 1,
        profiles: {
          "blockrun:default": {
            type: "api_key",
            provider: "blockrun",
            key: "x402-proxy-handles-auth",
          },
          "anthropic:default": { type: "api_key", provider: "anthropic", key: "sk-real-key" },
        },
      }),
    );

    mod.injectAuthProfile({ info: vi.fn() });

    expect(existsSync(authPath(homeDir, "mike"))).toBe(true);
  });
});
