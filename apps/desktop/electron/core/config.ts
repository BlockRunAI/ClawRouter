import { parseDocument } from "yaml";

import { atomicWrite, readText } from "./files.js";

const START = "# >>> ClawRouter Desktop >>>";
const END = "# <<< ClawRouter Desktop <<<";
const ROOT_START = "# >>> ClawRouter Desktop root >>>";
const ROOT_END = "# <<< ClawRouter Desktop root <<<";

export async function upsertCodexConfig(
  path: string,
  baseUrl: string,
  model = "auto",
  setDefault = false,
): Promise<void> {
  const original = await readText(path);
  const managedPattern = new RegExp(
    `\\n?${escapeRegExp(START)}[\\s\\S]*?${escapeRegExp(END)}\\n?`,
    "g",
  );
  const rootPattern = new RegExp(
    `${escapeRegExp(ROOT_START)}[\\s\\S]*?${escapeRegExp(ROOT_END)}\\n?`,
    "g",
  );
  const clean = original.replace(managedPattern, "").replace(rootPattern, "").trim();
  const rootDefaults = setDefault
    ? `${ROOT_START}\nmodel_provider = "clawrouter"\nmodel = "${tomlString(model)}"\n${ROOT_END}\n\n`
    : "";
  const block = `${START}\n[model_providers.clawrouter]\nname = "ClawRouter"\nbase_url = "${tomlString(baseUrl)}"\nwire_api = "responses"\nrequires_openai_auth = false\n\n[profiles.clawrouter]\nmodel_provider = "clawrouter"\nmodel = "${tomlString(model)}"\n${END}`;
  await atomicWrite(path, `${rootDefaults}${clean}${clean ? "\n\n" : ""}${block}\n`, 0o600);
}

export async function upsertDshConfig(
  settingsPath: string,
  credentialsPath: string,
  baseUrl: string,
  models: string[],
  selectedModel = "auto",
): Promise<void> {
  const settings = parseDocument((await readText(settingsPath)) || "{}\n");
  if (settings.errors.length)
    throw new Error(`Invalid DSH settings.yaml: ${settings.errors[0]?.message}`);
  settings.setIn(["llm-pi-ai", "providers", "clawrouter"], {
    displayName: "ClawRouter",
    apiKeyEnv: "CLAWROUTER_API_KEY",
    api: "openai-completions",
    baseURL: baseUrl,
    models: models.map((id) => ({ id, name: displayModelName(id) })),
  });
  settings.setIn(["agent-default-model"], { provider: "clawrouter", model: selectedModel });
  await atomicWrite(settingsPath, settings.toString(), 0o600);

  const credentials = parseDocument((await readText(credentialsPath)) || "{}\n");
  if (credentials.errors.length) {
    throw new Error(`Invalid DSH .credentials.yaml: ${credentials.errors[0]?.message}`);
  }
  const legacy = credentials.toJS() as Record<string, unknown> | null;
  if (!credentials.has("version") && !credentials.has("refs")) {
    credentials.contents = null;
    credentials.set("version", 1);
    credentials.set("refs", { ...(legacy ?? {}), CLAWROUTER_API_KEY: "clawrouter-local" });
  } else {
    credentials.set("version", 1);
    if (!credentials.has("refs")) {
      credentials.set("refs", { CLAWROUTER_API_KEY: "clawrouter-local" });
    } else {
      credentials.setIn(["refs", "CLAWROUTER_API_KEY"], "clawrouter-local");
    }
  }
  await atomicWrite(credentialsPath, credentials.toString(), 0o600);
}

export type PiModelConfig = {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

export async function upsertPiConfig(
  modelsPath: string,
  settingsPath: string,
  baseUrl: string,
  models: PiModelConfig[],
  selectedModel = "auto",
): Promise<void> {
  const modelConfig = parseJsonObject(await readText(modelsPath), "Pi models.json");
  const providers = isJsonObject(modelConfig.providers) ? modelConfig.providers : {};
  modelConfig.providers = providers;
  providers.clawrouter = {
    baseUrl,
    api: "openai-completions",
    apiKey: "clawrouter-local",
    authHeader: false,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
    },
    models,
  };
  await atomicWrite(modelsPath, `${JSON.stringify(modelConfig, null, 2)}\n`, 0o600);

  const settings = parseJsonObject(await readText(settingsPath), "Pi settings.json");
  settings.defaultProvider = "clawrouter";
  settings.defaultModel = selectedModel;
  await atomicWrite(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 0o600);
}

export async function removeOpenClawConfig(configPath: string, authPath: string): Promise<void> {
  const rawConfig = await readText(configPath);
  if (rawConfig.trim()) {
    const config = parseJsonObject(rawConfig, "OpenClaw config");
    deleteNestedKey(config, ["models", "providers"], "blockrun");

    const plugins = isJsonObject(config.plugins) ? config.plugins : undefined;
    if (plugins) {
      for (const key of ["clawrouter", "ClawRouter", "@blockrun/clawrouter", "blockrun"]) {
        delete plugins[key];
        deleteNestedKey(plugins, ["entries"], key);
        deleteNestedKey(plugins, ["installs"], key);
      }
      if (Array.isArray(plugins.allow)) {
        const managed = new Set(["clawrouter", "ClawRouter", "@blockrun/clawrouter", "blockrun"]);
        plugins.allow = plugins.allow.filter((value: unknown) => !managed.has(String(value)));
      }
    }

    const allowedModels = nestedObject(config, ["agents", "defaults", "models"]);
    if (allowedModels) {
      for (const key of Object.keys(allowedModels)) {
        if (key.startsWith("blockrun/")) delete allowedModels[key];
      }
    }
    const defaultModel = nestedObject(config, ["agents", "defaults", "model"]);
    if (typeof defaultModel?.primary === "string" && defaultModel.primary.startsWith("blockrun/")) {
      delete defaultModel.primary;
    }
    const webSearch = nestedObject(config, ["tools", "web", "search"]);
    if (webSearch?.provider === "blockrun-exa") delete webSearch.provider;
    await atomicWrite(configPath, `${JSON.stringify(config, null, 2)}\n`, 0o600);
  }

  const rawAuth = await readText(authPath);
  if (rawAuth.trim()) {
    const auth = parseJsonObject(rawAuth, "OpenClaw auth profiles");
    deleteNestedKey(auth, ["profiles"], "blockrun:default");
    await atomicWrite(authPath, `${JSON.stringify(auth, null, 2)}\n`, 0o600);
  }
}

export async function removeHermesConfig(configPath: string, envPath: string): Promise<void> {
  const rawConfig = await readText(configPath);
  if (rawConfig.trim()) {
    const config = parseDocument(rawConfig);
    if (config.errors.length)
      throw new Error(`Invalid Hermes config.yaml: ${config.errors[0]?.message}`);
    const provider = config.getIn(["model", "provider"]);
    if (provider === "clawrouter") {
      config.deleteIn(["model", "provider"]);
      config.deleteIn(["model", "default"]);
    }
    config.deleteIn(["providers", "clawrouter"]);
    await atomicWrite(configPath, config.toString(), 0o600);
  }

  const rawEnv = await readText(envPath);
  if (rawEnv) {
    const clean = rawEnv
      .split(/\r?\n/)
      .filter((line) => !/^CLAWROUTER_API_KEY=/.test(line))
      .join("\n")
      .replace(/\n*$/, "\n");
    await atomicWrite(envPath, clean, 0o600);
  }
}

export function hasOpenClawConfig(raw: string): boolean {
  if (!raw.trim()) return false;
  try {
    const config = parseJsonObject(raw, "OpenClaw config");
    const providers = nestedObject(config, ["models", "providers"]);
    const plugins = isJsonObject(config.plugins) ? config.plugins : undefined;
    const entries = plugins && isJsonObject(plugins.entries) ? plugins.entries : undefined;
    const installs = plugins && isJsonObject(plugins.installs) ? plugins.installs : undefined;
    const keys = ["clawrouter", "ClawRouter", "@blockrun/clawrouter", "blockrun"];
    return (
      Boolean(providers?.blockrun) ||
      keys.some((key) => Boolean(plugins?.[key] || entries?.[key] || installs?.[key]))
    );
  } catch {
    return /blockrun|clawrouter/i.test(raw);
  }
}

export function hasHermesConfig(raw: string): boolean {
  if (!raw.trim()) return false;
  const config = parseDocument(raw);
  return !config.errors.length && config.hasIn(["providers", "clawrouter"]);
}

export function containsClawRouterConfig(raw: string): boolean {
  return raw.includes("clawrouter") && raw.includes("127.0.0.1");
}

function displayModelName(id: string): string {
  if (id === "auto") return "Auto (Smart Router)";
  return id.split("/").at(-1)?.replaceAll("-", " ") ?? id;
}

function parseJsonObject(raw: string, label: string): Record<string, any> {
  if (!raw.trim()) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isJsonObject(value)) throw new Error("the root value must be an object");
    return value;
  } catch (error) {
    throw new Error(`Invalid ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isJsonObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nestedObject(root: Record<string, any>, path: string[]): Record<string, any> | undefined {
  let current: unknown = root;
  for (const key of path) {
    if (!isJsonObject(current) || !isJsonObject(current[key])) return undefined;
    current = current[key];
  }
  return current as Record<string, any>;
}

function deleteNestedKey(root: Record<string, any>, path: string[], key: string): void {
  const parent = nestedObject(root, path);
  if (parent) delete parent[key];
}

function tomlString(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\b", "\\b")
    .replaceAll("\t", "\\t")
    .replaceAll("\n", "\\n")
    .replaceAll("\f", "\\f")
    .replaceAll("\r", "\\r");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
