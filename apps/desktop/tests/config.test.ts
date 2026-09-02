import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import {
  hasHermesConfig,
  hasOpenClawConfig,
  removeHermesConfig,
  removeOpenClawConfig,
  upsertCodexConfig,
  upsertDshConfig,
  upsertPiConfig,
} from "../electron/core/config.js";

describe("agent configuration writers", () => {
  it("adds a valid Codex root default and leaves existing tables intact", async () => {
    const root = await mkdtemp(join(tmpdir(), "clawrouter-codex-"));
    const path = join(root, "config.toml");
    await writeFile(
      path,
      'approval_policy = "on-request"\n\n[projects."/work"]\ntrust_level = "trusted"\n',
    );

    await upsertCodexConfig(path, "http://127.0.0.1:8403/v1", "blockrun/auto", true);
    const result = await readFile(path, "utf8");

    expect(result.indexOf('model_provider = "clawrouter"')).toBeLessThan(
      result.indexOf('[projects."/work"]'),
    );
    expect(result).toContain('approval_policy = "on-request"');
    expect(result).toContain("[model_providers.clawrouter]");
    expect(result).toContain("[profiles.clawrouter]");
  });

  it("escapes control characters instead of allowing TOML line injection", async () => {
    const root = await mkdtemp(join(tmpdir(), "clawrouter-codex-"));
    const path = join(root, "config.toml");

    await upsertCodexConfig(
      path,
      "http://127.0.0.1:8403/v1",
      'safe\\model"\nmodel_provider = "attacker"',
      true,
    );
    const result = await readFile(path, "utf8");

    expect(result).toContain('model = "safe\\\\model\\"\\nmodel_provider = \\"attacker\\""');
    expect(result).not.toContain('\nmodel_provider = "attacker"\n');
  });

  it("writes current DSH settings and versioned credential schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "clawrouter-dsh-"));
    const settings = join(root, "settings.yaml");
    const credentials = join(root, ".credentials.yaml");
    await writeFile(settings, "theme:\n  mode: dark\n");
    await writeFile(credentials, "version: 1\nrefs:\n  EXISTING_KEY: keep-me\n", { mode: 0o600 });

    await upsertDshConfig(
      settings,
      credentials,
      "http://127.0.0.1:8402/v1",
      ["auto", "anthropic/claude-sonnet-4.6"],
      "auto",
    );

    const settingsValue = parse(await readFile(settings, "utf8"));
    const credentialsValue = parse(await readFile(credentials, "utf8"));
    expect(settingsValue.theme.mode).toBe("dark");
    expect(settingsValue["llm-pi-ai"].providers.clawrouter.baseURL).toBe(
      "http://127.0.0.1:8402/v1",
    );
    expect(settingsValue["agent-default-model"]).toEqual({ provider: "clawrouter", model: "auto" });
    expect(credentialsValue).toMatchObject({
      version: 1,
      refs: { EXISTING_KEY: "keep-me", CLAWROUTER_API_KEY: "clawrouter-local" },
    });
    expect((await stat(credentials)).mode & 0o777).toBe(0o600);
  });

  it("merges Pi's ClawRouter provider without removing existing settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "clawrouter-pi-"));
    const models = join(root, "models.json");
    const settings = join(root, "settings.json");
    await writeFile(
      models,
      `${JSON.stringify({ providers: { ollama: { baseUrl: "http://localhost:11434/v1" } } })}\n`,
    );
    await writeFile(
      settings,
      `${JSON.stringify({ theme: "dark", defaultThinkingLevel: "high" })}\n`,
    );

    await upsertPiConfig(
      models,
      settings,
      "http://127.0.0.1:8402/v1",
      [{ id: "auto", name: "Auto (Smart Router)", contextWindow: 1_000_000 }],
      "auto",
    );

    const modelValue = JSON.parse(await readFile(models, "utf8"));
    const settingsValue = JSON.parse(await readFile(settings, "utf8"));
    expect(modelValue.providers.ollama.baseUrl).toBe("http://localhost:11434/v1");
    expect(modelValue.providers.clawrouter).toMatchObject({
      baseUrl: "http://127.0.0.1:8402/v1",
      api: "openai-completions",
      apiKey: "clawrouter-local",
      authHeader: false,
    });
    expect(settingsValue).toMatchObject({
      theme: "dark",
      defaultThinkingLevel: "high",
      defaultProvider: "clawrouter",
      defaultModel: "auto",
    });
  });

  it("disconnects a pre-Desktop OpenClaw config without touching unrelated settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "clawrouter-openclaw-remove-"));
    const configPath = join(root, "openclaw.json");
    const authPath = join(root, "auth-profiles.json");
    await writeFile(
      configPath,
      JSON.stringify({
        models: {
          providers: {
            blockrun: { baseUrl: "http://127.0.0.1:8402/v1" },
            openai: { baseUrl: "https://example.test" },
          },
        },
        plugins: {
          entries: {
            clawrouter: { enabled: false },
            "blockrun-clawrouter": { enabled: true },
            blockrun: { enabled: true, owner: "unrelated" },
            keep: { enabled: true },
          },
          installs: { blockrun: { source: "unrelated" } },
          allow: ["clawrouter", "blockrun-clawrouter", "blockrun", "keep"],
          deny: ["blockrun"],
        },
        agents: {
          defaults: {
            models: { "blockrun/auto": {}, "openai/native": {} },
            model: { primary: "blockrun/auto" },
          },
        },
        theme: "dark",
      }),
    );
    await writeFile(
      authPath,
      JSON.stringify({
        profiles: { "blockrun:default": { token: "local" }, keep: { token: "safe" } },
      }),
    );

    expect(hasOpenClawConfig(await readFile(configPath, "utf8"))).toBe(true);
    await removeOpenClawConfig(configPath, authPath);
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const auth = JSON.parse(await readFile(authPath, "utf8"));
    expect(hasOpenClawConfig(JSON.stringify(config))).toBe(false);
    expect(config).toMatchObject({
      models: { providers: { openai: {} } },
      plugins: {
        entries: {
          clawrouter: { enabled: false },
          blockrun: { enabled: true, owner: "unrelated" },
          keep: {},
        },
        installs: { blockrun: { source: "unrelated" } },
        allow: ["clawrouter", "blockrun", "keep"],
        deny: ["blockrun"],
      },
      theme: "dark",
    });
    expect(config.agents.defaults.models).toHaveProperty("openai/native");
    expect(config.agents.defaults.model.primary).toBeUndefined();
    expect(auth.profiles).toHaveProperty("keep");
    expect(auth.profiles).not.toHaveProperty("blockrun:default");
  });

  it("does not mistake OpenClaw's official clawrouter plugin for BlockRun", () => {
    const officialOnly = JSON.stringify({
      plugins: { entries: { clawrouter: { enabled: true } }, allow: ["clawrouter"] },
      models: { providers: { clawrouter: { baseUrl: "https://clawrouter.openclaw.ai" } } },
    });
    expect(hasOpenClawConfig(officialOnly)).toBe(false);
  });

  it("disconnects a pre-Desktop Hermes provider and preserves other providers and env keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "clawrouter-hermes-remove-"));
    const configPath = join(root, "config.yaml");
    const envPath = join(root, ".env");
    await writeFile(
      configPath,
      "model:\n  default: auto\n  provider: clawrouter\nproviders:\n  clawrouter:\n    base_url: http://127.0.0.1:8402/v1\n  keep:\n    base_url: https://example.test\ntheme: dark\n",
    );
    await writeFile(envPath, "CLAWROUTER_API_KEY=clawrouter-local\nTELEGRAM_BOT_TOKEN=keep-me\n");

    expect(hasHermesConfig(await readFile(configPath, "utf8"))).toBe(true);
    await removeHermesConfig(configPath, envPath);
    const config = parse(await readFile(configPath, "utf8"));
    const env = await readFile(envPath, "utf8");
    expect(hasHermesConfig(await readFile(configPath, "utf8"))).toBe(false);
    expect(config.providers.keep.base_url).toBe("https://example.test");
    expect(config.providers.clawrouter).toBeUndefined();
    expect(config.model?.provider).toBeUndefined();
    expect(config.theme).toBe("dark");
    expect(env).toBe("TELEGRAM_BOT_TOKEN=keep-me\n");
  });
});
