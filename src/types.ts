/**
 * OpenClaw Plugin Types (locally defined)
 *
 * OpenClaw's plugin SDK uses duck typing — these match the shapes
 * expected by registerProvider() and the plugin system.
 * Defined locally to avoid depending on internal OpenClaw paths.
 */

export type ModelApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai"
  | "github-copilot"
  | "bedrock-converse-stream";

export type ModelDefinitionConfig = {
  id: string;
  name: string;
  api?: ModelApi;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
};

export type ModelProviderConfig = {
  baseUrl: string;
  apiKey?: string;
  api?: ModelApi;
  headers?: Record<string, string>;
  authHeader?: boolean;
  models: ModelDefinitionConfig[];
};

export type AuthProfileCredential = {
  apiKey?: string;
  type?: string;
  [key: string]: unknown;
};

export type ProviderAuthResult = {
  profiles: Array<{ profileId: string; credential: AuthProfileCredential }>;
  configPatch?: Record<string, unknown>;
  defaultModel?: string;
  notes?: string[];
};

export type WizardPrompter = {
  text: (opts: {
    message: string;
    validate?: (value: string) => string | undefined;
  }) => Promise<string | symbol>;
  note: (message: string) => void;
  progress: (message: string) => { stop: (message?: string) => void };
};

export type ProviderAuthContext = {
  config: Record<string, unknown>;
  agentDir?: string;
  workspaceDir?: string;
  prompter: WizardPrompter;
  runtime: { log: (message: string) => void };
  isRemote: boolean;
  openUrl: (url: string) => Promise<void>;
};

export type ProviderAuthMethod = {
  id: string;
  label: string;
  hint?: string;
  kind: "oauth" | "api_key" | "token" | "device_code" | "custom";
  run: (ctx: ProviderAuthContext) => Promise<ProviderAuthResult>;
};

export type ProviderPlugin = {
  id: string;
  label: string;
  docsPath?: string;
  aliases?: string[];
  envVars?: string[];
  models?: ModelProviderConfig;
  auth: ProviderAuthMethod[];
  formatApiKey?: (cred: AuthProfileCredential) => string;
};

export type PluginLogger = {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type OpenClawPluginApi = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  source: string;
  config: Record<string, unknown> & {
    models?: { providers?: Record<string, ModelProviderConfig> };
  };
  pluginConfig?: Record<string, unknown>;
  logger: PluginLogger;
  registerProvider: (provider: ProviderPlugin) => void;
  registerTool: (tool: unknown, opts?: unknown) => void;
  registerHook: (events: string | string[], handler: unknown, opts?: unknown) => void;
  registerHttpRoute: (params: { path: string; handler: unknown }) => void;
  registerService: (service: unknown) => void;
  registerCommand: (command: unknown) => void;
  resolvePath: (input: string) => string;
  on: (hookName: string, handler: unknown, opts?: unknown) => void;
};

export type OpenClawPluginDefinition = {
  id?: string;
  name?: string;
  description?: string;
  version?: string;
  register?: (api: OpenClawPluginApi) => void | Promise<void>;
  activate?: (api: OpenClawPluginApi) => void | Promise<void>;
};
