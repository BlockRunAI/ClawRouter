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

export type OpenClawPluginService = {
  id: string;
  start: () => void | Promise<void>;
  stop?: () => void | Promise<void>;
};

// --- Image generation provider types ---

export type ImageGenerationResolution = "1K" | "2K" | "4K";

export type GeneratedImageAsset = {
  buffer: Buffer;
  mimeType: string;
  fileName?: string;
  revisedPrompt?: string;
  metadata?: Record<string, unknown>;
};

export type ImageGenerationSourceImage = {
  buffer: Buffer;
  mimeType: string;
  fileName?: string;
  metadata?: Record<string, unknown>;
};

export type ImageGenerationRequest = {
  provider: string;
  model: string;
  prompt: string;
  cfg: Record<string, unknown>;
  agentDir?: string;
  timeoutMs?: number;
  count?: number;
  size?: string;
  aspectRatio?: string;
  resolution?: ImageGenerationResolution;
  inputImages?: ImageGenerationSourceImage[];
};

export type ImageGenerationResult = {
  images: GeneratedImageAsset[];
  model?: string;
  metadata?: Record<string, unknown>;
};

export type ImageGenerationProviderCapabilities = {
  generate: {
    maxCount?: number;
    supportsSize?: boolean;
    supportsAspectRatio?: boolean;
    supportsResolution?: boolean;
  };
  edit: {
    enabled: boolean;
    maxInputImages?: number;
    maxCount?: number;
    supportsSize?: boolean;
  };
  geometry?: {
    sizes?: string[];
    resolutions?: ImageGenerationResolution[];
  };
};

export type ImageGenerationProviderPlugin = {
  id: string;
  aliases?: string[];
  label?: string;
  defaultModel?: string;
  models?: string[];
  capabilities: ImageGenerationProviderCapabilities;
  isConfigured?: (ctx: { cfg?: Record<string, unknown> }) => boolean;
  generateImage: (req: ImageGenerationRequest) => Promise<ImageGenerationResult>;
};

// --- Music generation provider types ---

export type MusicGenerationOutputFormat = "mp3" | "wav";

export type GeneratedMusicAsset = {
  buffer: Buffer;
  mimeType: string;
  fileName?: string;
  metadata?: Record<string, unknown>;
};

export type MusicGenerationRequest = {
  provider: string;
  model: string;
  prompt: string;
  cfg: Record<string, unknown>;
  agentDir?: string;
  timeoutMs?: number;
  lyrics?: string;
  instrumental?: boolean;
  durationSeconds?: number;
  format?: MusicGenerationOutputFormat;
};

export type MusicGenerationResult = {
  tracks: GeneratedMusicAsset[];
  model?: string;
  lyrics?: string[];
  metadata?: Record<string, unknown>;
};

export type MusicGenerationProviderCapabilities = {
  maxTracks?: number;
  maxDurationSeconds?: number;
  supportsLyrics?: boolean;
  supportsInstrumental?: boolean;
  supportsDuration?: boolean;
  supportsFormat?: boolean;
  supportedFormats?: readonly MusicGenerationOutputFormat[];
};

export type MusicGenerationProviderPlugin = {
  id: string;
  aliases?: string[];
  label?: string;
  defaultModel?: string;
  models?: string[];
  capabilities: MusicGenerationProviderCapabilities;
  isConfigured?: (ctx: { cfg?: Record<string, unknown> }) => boolean;
  generateMusic: (req: MusicGenerationRequest) => Promise<MusicGenerationResult>;
};

export type OpenClawPluginApi = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  source: string;
  config: Record<string, unknown> & {
    models?: { providers?: Record<string, ModelProviderConfig> };
    agents?: Record<string, unknown>;
  };
  pluginConfig?: Record<string, unknown>;
  logger: PluginLogger;
  registerProvider: (provider: ProviderPlugin) => void;
  registerImageGenerationProvider: (provider: ImageGenerationProviderPlugin) => void;
  registerMusicGenerationProvider: (provider: MusicGenerationProviderPlugin) => void;
  registerVideoGenerationProvider?: (provider: unknown) => void;
  registerTool: (tool: unknown, opts?: unknown) => void;
  registerHook: (events: string | string[], handler: unknown, opts?: unknown) => void;
  registerHttpRoute: (params: { path: string; handler: unknown }) => void;
  registerService: (service: OpenClawPluginService) => void;
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
  deactivate?: (api: OpenClawPluginApi) => void | Promise<void>;
};

// Command types for registerCommand
export type PluginCommandContext = {
  senderId?: string;
  channel: string;
  isAuthorizedSender: boolean;
  args?: string;
  commandBody: string;
  config: Record<string, unknown>;
};

export type PluginCommandResult = {
  text?: string;
  isError?: boolean;
};

export type PluginCommandHandler = (
  ctx: PluginCommandContext,
) => PluginCommandResult | Promise<PluginCommandResult>;

export type OpenClawPluginCommandDefinition = {
  name: string;
  description: string;
  acceptsArgs?: boolean;
  requireAuth?: boolean;
  handler: PluginCommandHandler;
};
