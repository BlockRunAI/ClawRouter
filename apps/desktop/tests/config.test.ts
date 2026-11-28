import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import {
  codexConfigConflicts,
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

  it("replaces an existing root model and model_provider instead of repeating the key", async () => {
    const root = await mkdtemp(join(tmpdir(), "clawrouter-codex-"));
    const path = join(root, "config.toml");
    await writeFile(
      path,
      [
        'model = "gpt-5-codex"',
        'model_provider = "openai"',
        'model_reasoning_effort = "high"',
        "",
        "[profiles.fast]",
        'model = "o3"',
        "",
      ].join("\n"),
    );

    await upsertCodexConfig(path, "http://127.0.0.1:8403/v1", "blockrun/auto", true);
    const result = await readFile(path, "utf8");

    expect(result.match(/^model = /gm)).toHaveLength(3);
    expect(result.match(/^model_provider = /gm)).toHaveLength(2);
    expect(result).toContain('model_reasoning_effort = "high"');
    expect(result).toContain('model = "o3"');
    expect(result).not.toContain("gpt-5-codex");
  });

  it("keeps multi-line strings and arrays that hold model-looking lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "clawrouter-codex-"));
    const path = join(root, "config.toml");
    const user = [
      'developer_instructions = """',
      'model = "inside a basic string"',
      "[fake]",
      '"""',
      "notes = '''",
      'model_provider = "inside a literal string"',
      "'''",
      "matrix = [",
      "  [1],",
      "  [2]",
      "]",
    ].join("\n");
    await writeFile(path, `${user}\nmodel = "gpt-5-codex"\n\n[profiles.fast]\nmodel = "o3"\n`);

    await upsertCodexConfig(path, "http://127.0.0.1:8403/v1", "blockrun/auto", true);
    const result = await readFile(path, "utf8");

    expect(result).toContain(user);
    expect(result).not.toContain("gpt-5-codex");
    expect(result).toContain('model = "o3"');
  });

  it("reads a quoted table header that holds an escaped quote", async () => {
    const root = await mkdtemp(join(tmpdir(), "clawrouter-codex-"));
    const path = join(root, "config.toml");
    const user = '[profiles."a\\"b"]\nmodel = "o3"\nmodel_provider = "openai"';
    await writeFile(path, `model = "gpt-5-codex"\n\n${user}\n`);

    await upsertCodexConfig(path, "http://127.0.0.1:8403/v1", "blockrun/auto", true);
    const result = await readFile(path, "utf8");

    expect(result).toContain(user);
    expect(result).not.toContain("gpt-5-codex");
  });

  it("decodes escapes in a quoted root key", async () => {
    const root = await mkdtemp(join(tmpdir(), "clawrouter-codex-"));
    const path = join(root, "config.toml");
    await writeFile(
      path,
      '"mod\\u0065l" = "gpt-5-codex"\n"model_provider" = "openai"\n"my\\u0020model" = "keep"\n',
    );

    await upsertCodexConfig(path, "http://127.0.0.1:8403/v1", "blockrun/auto", true);
    const result = await readFile(path, "utf8");

    expect(result).not.toContain("gpt-5-codex");
    expect(result).not.toContain('"openai"');
    expect(result).toContain('"my\\u0020model" = "keep"');
  });

  it("drops a root model value that spans several lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "clawrouter-codex-"));
    const path = join(root, "config.toml");
    await writeFile(path, 'model = """\nold\n"""\nmodel_reasoning_effort = "high"\n');

    await upsertCodexConfig(path, "http://127.0.0.1:8403/v1", "blockrun/auto", true);
    const result = await readFile(path, "utf8");

    expect(result).not.toContain("old");
    expect(result).toContain('model_reasoning_effort = "high"');
  });

  it("leaves an existing root model alone when no default is requested", async () => {
    const root = await mkdtemp(join(tmpdir(), "clawrouter-codex-"));
    const path = join(root, "config.toml");
    await writeFile(path, 'model = "gpt-5-codex"\n');

    await upsertCodexConfig(path, "http://127.0.0.1:8403/v1", "blockrun/auto", false);

    expect(await readFile(path, "utf8")).toContain('model = "gpt-5-codex"');
  });

  it("drops a dotted root model key, which would clash with the managed root model", async () => {
    const root = await mkdtemp(join(tmpdir(), "clawrouter-codex-"));
    const path = join(root, "config.toml");
    await writeFile(path, 'model.sub = 1\nmodel . "other" = 2\napproval_policy = "never"\n');

    await upsertCodexConfig(path, "http://127.0.0.1:8403/v1", "blockrun/auto", true);
    const result = await readFile(path, "utf8");

    expect(result).not.toContain("model.sub");
    expect(result).not.toContain('"other"');
    expect(result).toContain('approval_policy = "never"');
    expect(codexConfigConflicts(result)).toEqual([]);
  });

  it("replaces ClawRouter tables written outside the managed block, keeping comments and sub-tables", async () => {
    const root = await mkdtemp(join(tmpdir(), "clawrouter-codex-"));
    const path = join(root, "config.toml");
    await writeFile(
      path,
      [
        'model_catalog_json = "/home/u/.codex/clawrouter-catalog.json"',
        "",
        "# provider from clawrouter-codex",
        "[model_providers.clawrouter]",
        'base_url = "http://localhost:8403/v1"',
        "requires_openai_auth = true",
        "",
        "# legacy profile",
        "[profiles.clawrouter]",
        'model = "old-model"',
        "",
        "[profiles.clawrouter.extra]",
        "flag = true",
        "",
        "[profiles]",
        'clawrouter.model_provider = "dotted-old"',
        'fast.model = "o3"',
        "",
        '[projects."/work"]',
        'trust_level = "trusted"',
      ].join("\n"),
    );

    for (const setDefault of [false, true]) {
      await upsertCodexConfig(path, "http://127.0.0.1:8403/v1", "blockrun/auto", setDefault);
      const result = await readFile(path, "utf8");

      expect(codexConfigConflicts(result)).toEqual([]);
      expect(result.match(/^\[model_providers\.clawrouter\]/gm)).toHaveLength(1);
      expect(result.match(/^\[profiles\.clawrouter\]/gm)).toHaveLength(1);
      for (const gone of [
        "localhost:8403",
        "requires_openai_auth = true",
        "old-model",
        "dotted-old",
      ]) {
        expect(result).not.toContain(gone);
      }
      for (const kept of [
        "model_catalog_json",
        "# provider from clawrouter-codex",
        "# legacy profile",
        "[profiles.clawrouter.extra]",
        'fast.model = "o3"',
        '[projects."/work"]',
      ]) {
        expect(result).toContain(kept);
      }
    }
  });

  it("finds no conflicts in what the Codex writer produces", async () => {
    const root = await mkdtemp(join(tmpdir(), "clawrouter-codex-"));
    const path = join(root, "config.toml");
    await writeFile(
      path,
      'model = "gpt-5-codex"\nmodel_provider = "openai"\n\n[profiles.fast]\nmodel = "o3"\n',
    );

    await upsertCodexConfig(path, "http://127.0.0.1:8403/v1", "blockrun/auto", true);
    await upsertCodexConfig(path, "http://127.0.0.1:8403/v1", "blockrun/auto", true);

    expect(codexConfigConflicts(await readFile(path, "utf8"))).toEqual([]);
  });

  it("reports each key or table the Codex writer owns that is defined more than once", () => {
    expect(codexConfigConflicts('model = "a"\nmodel = "b"\n')).toEqual([
      '"model" is defined 2 times',
    ]);
    expect(codexConfigConflicts('model = "a"\nmodel.sub = 1\n')).toEqual([
      '"model" is defined 2 times',
    ]);
    expect(codexConfigConflicts('"model_provider" = "a"\n[model_provider]\nx = 1\n')).toEqual([
      '"model_provider" is defined 2 times',
    ]);
    expect(
      codexConfigConflicts(
        '[model_providers.clawrouter]\nname = "mine"\n\n[model_providers . "clawrouter"]\nname = "ours"\n',
      ),
    ).toEqual(['"model_providers.clawrouter" is defined 2 times']);
    expect(
      codexConfigConflicts(
        '[profiles]\nclawrouter = { model = "x" }\n\n[profiles.clawrouter]\nmodel = "y"\n',
      ),
    ).toEqual(['"profiles.clawrouter" is defined 2 times']);
  });

  it("does not count lines that TOML allows: sub-tables, dotted keys of one table, and values", () => {
    const valid = [
      'model = "a"',
      'notes = """',
      'model = "inside a string"',
      "[profiles.clawrouter]",
      '"""',
      "matrix = [",
      "  [1],",
      "]",
      "",
      "[profiles]",
      'clawrouter.model = "x"',
      'clawrouter.model_provider = "y"',
      "",
      "[profiles.clawrouter.extra]",
      "flag = true",
      "",
      "[model_providers.other]",
      'model = "not the root model"',
    ].join("\n");

    expect(codexConfigConflicts(valid)).toEqual([]);
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
            // OpenClaw 2026.8+ keeps the allowlist here once it has migrated `models`.
            modelPolicy: {
              allow: ["blockrun/auto", "openai/native", "blockrun/openai/*"],
              deny: ["x/y"],
            },
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
    expect(config.agents.defaults.modelPolicy).toEqual({
      allow: ["openai/native", "blockrun/openai/*"],
      deny: ["x/y"],
    });
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
