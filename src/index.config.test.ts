import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("OpenClaw config sync", () => {
  let homeDir: string | undefined;

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("node:os");
    if (homeDir) {
      rmSync(homeDir, { recursive: true, force: true });
      homeDir = undefined;
    }
  });

  it("repairs provider and allowlist order on install/update", async () => {
    homeDir = mkdtempSync(join(tmpdir(), "clawrouter-openclaw-"));
    const openclawDir = join(homeDir, ".openclaw");
    const configPath = join(openclawDir, "openclaw.json");

    vi.doMock("node:os", async () => ({
      ...(await vi.importActual<typeof import("node:os")>("node:os")),
      homedir: () => homeDir,
    }));

    const { mkdirSync } = await import("node:fs");
    mkdirSync(openclawDir, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          models: {
            providers: {
              blockrun: {
                baseUrl: "http://127.0.0.1:8402/v1",
                api: "openai-completions",
                apiKey: "x402-proxy-handles-auth",
                models: [
                  { id: "free/gpt-oss-120b", name: "stale first" },
                  { id: "auto", name: "Auto" },
                ],
              },
            },
          },
          agents: {
            defaults: {
              model: { primary: "blockrun/auto" },
              models: {
                "blockrun/free/gpt-oss-120b": {},
                "openai/gpt-5": {},
                "blockrun/auto": {},
              },
            },
          },
        },
        null,
        2,
      ),
    );

    const [{ injectModelsConfig }, { TOP_MODELS }, { VISIBLE_OPENCLAW_MODELS }] = await Promise.all(
      [import("./index.js"), import("./top-models.js"), import("./models.js")],
    );

    injectModelsConfig({ info: vi.fn() }, { forceWrite: true });

    const synced = JSON.parse(readFileSync(configPath, "utf8"));
    expect(synced.models.providers.blockrun.models.map((m: { id: string }) => m.id)).toEqual(
      VISIBLE_OPENCLAW_MODELS.map((m) => m.id),
    );
    expect(Object.keys(synced.agents.defaults.models)).toEqual([
      ...TOP_MODELS.map((id) => `blockrun/${id}`),
      "openai/gpt-5",
    ]);
  }, 30_000);
});
