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
  const unmanaged = original.replace(managedPattern, "").replace(rootPattern, "");
  // The managed blocks define these keys and tables, and TOML rejects a repeated definition, so
  // any already in the file must go first: the user's own root `model`, or a provider table that
  // another tool wrote (`clawrouter-codex desktop on` writes its own [model_providers.clawrouter]).
  const clean = withoutDefinitions(
    unmanaged,
    setDefault ? CODEX_OWNED_PATHS : CODEX_TABLE_PATHS,
  ).trim();
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
      // Lowercase `clawrouter` belongs to OpenClaw's bundled router. It is a
      // different product and must survive BlockRun disconnect/uninstall.
      for (const key of ["blockrun-clawrouter", "ClawRouter", "@blockrun/clawrouter"]) {
        delete plugins[key];
        deleteNestedKey(plugins, ["entries"], key);
        deleteNestedKey(plugins, ["installs"], key);
      }
      if (Array.isArray(plugins.allow)) {
        const managed = new Set(["blockrun-clawrouter", "ClawRouter", "@blockrun/clawrouter"]);
        plugins.allow = plugins.allow.filter((value: unknown) => !managed.has(String(value)));
      }
      if (Array.isArray(plugins.deny)) {
        const managed = new Set(["blockrun-clawrouter", "ClawRouter", "@blockrun/clawrouter"]);
        plugins.deny = plugins.deny.filter((value: unknown) => !managed.has(String(value)));
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
    const keys = ["blockrun-clawrouter", "ClawRouter", "@blockrun/clawrouter"];
    const hasBlockRunPlugin = keys.some((key) =>
      Boolean(plugins?.[key] || entries?.[key] || installs?.[key]),
    );
    return Boolean(providers?.blockrun) && hasBlockRunPlugin;
  } catch {
    return /blockrun-clawrouter|@blockrun\/clawrouter/i.test(raw);
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

/** Root keys the managed root block writes when ClawRouter is the default. */
const CODEX_ROOT_KEYS = ["model", "model_provider"];

/**
 * Every key or table the Codex writer puts in config.toml. TOML rejects defining any of them twice,
 * and Codex then refuses to load the whole file, so each must appear at most once.
 */
const CODEX_TABLE_PATHS = [
  ["model_providers", "clawrouter"],
  ["profiles", "clawrouter"],
];
const CODEX_OWNED_PATHS = [...CODEX_ROOT_KEYS.map((key) => [key]), ...CODEX_TABLE_PATHS];

/**
 * Each key or table the Codex writer owns that `toml` defines more than once, e.g.
 * `"model" is defined 2 times`. Empty when the file is free of the clashes the writer can cause.
 *
 * Deliberately not a full TOML validator: Codex accepts TOML 1.1 (multi-line inline tables, `\e`),
 * so a stricter parser would refuse configs that work. A repeated definition is invalid in every
 * TOML version, so this check cannot refuse a file Codex would load.
 */
export function codexConfigConflicts(toml: string): string[] {
  const lines = scanTomlLines(toml);
  return CODEX_OWNED_PATHS.flatMap((owned) => {
    let count = 0;
    let dotted = false;
    for (const line of lines) {
      if (!definesPath(line, owned)) continue;
      // Dotted keys such as `clawrouter.a` and `clawrouter.b` extend one table: one definition.
      if (line.key && !samePath([...line.table, ...line.key], owned)) dotted = true;
      else count++;
    }
    if (dotted) count++;
    return count > 1 ? [`"${owned.join(".")}" is defined ${count} times`] : [];
  });
}

/**
 * Drop every definition of `paths`: a table's header and keys, a root key such as `model` or
 * `model.sub`, and a definition from a parent table (`[profiles]` then `clawrouter = {…}`).
 * Lines of a multi-line value go with their key. Comments, blank lines and sub-tables such as
 * `[profiles.clawrouter.extra]` stay.
 */
function withoutDefinitions(toml: string, paths: string[][]): string {
  let dropping = false;
  const kept: string[] = [];
  for (const line of scanTomlLines(toml)) {
    if (!line.continuation) {
      dropping = paths.some(
        (owned) => definesPath(line, owned) || (!!line.key && samePath(line.table, owned)),
      );
    }
    if (!dropping) kept.push(line.text);
  }
  return kept.join("\n");
}

/**
 * Whether `line` defines `owned`: its table header, or a key from a parent table, which defines
 * it as a value when the path ends there and as a dotted table when it goes on. A key inside the
 * owned table only fills it.
 */
function definesPath(line: TomlLine, owned: string[]): boolean {
  if (line.header) return samePath(line.header, owned);
  return (
    !!line.key && !startsWith(line.table, owned) && startsWith([...line.table, ...line.key], owned)
  );
}

type TomlLine = {
  text: string;
  /** The table this line belongs to; `[]` is the root. */
  table: string[];
  /** Set when the line is a `[table]` or `[[array]]` header. */
  header?: string[];
  /** Set when the line starts a key/value pair: the dotted key, decoded. */
  key?: string[];
  /** True inside a multi-line string or array: the line belongs to a value, never a key or header. */
  continuation: boolean;
};

const TOML_KEY_PART = String.raw`(?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)`;
const TOML_HEADER = /^\s*\[\[?((?:[^\]"']|"(?:[^"\\]|\\.)*"|'[^']*')+)\]\]?\s*(#.*)?\r?$/;
const TOML_KEY = new RegExp(String.raw`^\s*(${TOML_KEY_PART}(?:\s*\.\s*${TOML_KEY_PART})*)\s*=`);

/** Read TOML line by line, far enough to tell headers and keys from the lines of a value. */
function scanTomlLines(toml: string): TomlLine[] {
  let table: string[] = [];
  let multiline = ""; // the open `"""` or `'''`
  let depth = 0; // open `[` and `{` of a value that spans lines
  const lines: TomlLine[] = [];
  for (const text of toml.split("\n")) {
    const line: TomlLine = { text, table, continuation: Boolean(multiline) || depth > 0 };
    if (!line.continuation) {
      const header = TOML_HEADER.exec(text);
      if (header) {
        // An unreadable header still ends the root, so its keys are never taken as root keys.
        table = dottedKey(header[1]!) ?? [header[1]!.trim()];
        line.table = table;
        line.header = table;
      } else {
        const key = TOML_KEY.exec(text);
        if (key) line.key = dottedKey(key[1]!) ?? undefined;
      }
    }
    for (let i = 0; i < text.length;) {
      if (multiline) {
        if (multiline === '"""' && text[i] === "\\") {
          i += 2;
        } else if (text.startsWith(multiline, i)) {
          for (i += 3; text[i] === multiline[0]; i++);
          multiline = "";
        } else {
          i++;
        }
      } else if (text[i] === "#") {
        break;
      } else if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
        multiline = text.slice(i, i + 3);
        i += 3;
      } else if (text[i] === '"') {
        for (i++; i < text.length && text[i] !== '"'; i += text[i] === "\\" ? 2 : 1);
        i++;
      } else if (text[i] === "'") {
        const end = text.indexOf("'", i + 1);
        i = end < 0 ? text.length : end + 1;
      } else {
        if (text[i] === "[" || text[i] === "{") depth++;
        if (text[i] === "]" || text[i] === "}") depth = Math.max(0, depth - 1);
        i++;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Split a dotted TOML key such as `profiles . "click house"` into its decoded parts. */
function dottedKey(raw: string): string[] | null {
  const part = new RegExp(String.raw`\s*(${TOML_KEY_PART})\s*(\.|$)`, "y");
  const parts: string[] = [];
  for (let i = 0; i < raw.length;) {
    part.lastIndex = i;
    const match = part.exec(raw);
    if (!match) return null;
    parts.push(tomlKey(match[1]!));
    i = part.lastIndex;
    if (!match[2]) break;
  }
  return parts.length ? parts : null;
}

function samePath(a: string[], b: string[]): boolean {
  return a.length === b.length && startsWith(a, b);
}

function startsWith(path: string[], prefix: string[]): boolean {
  return prefix.length <= path.length && prefix.every((part, i) => path[i] === part);
}

/** The name a TOML key spells. A quoted key has its escapes decoded, so "mod\u0065l" is model. */
function tomlKey(raw: string): string {
  if (raw.startsWith("'")) return raw.slice(1, -1);
  if (!raw.startsWith('"')) return raw;
  const simple: Record<string, string> = {
    b: "\b",
    t: "\t",
    n: "\n",
    f: "\f",
    r: "\r",
    '"': '"',
    "\\": "\\",
  };
  return raw.slice(1, -1).replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (all, e: string) => {
    if (e.length > 1) {
      const code = parseInt(e.slice(1), 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : all;
    }
    return simple[e] ?? all;
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
