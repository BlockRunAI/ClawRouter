/**
 * @blockrun/xclawrouter
 *
 * Smart LLM router for OpenClaw — 55+ models, x402 micropayments, 78% cost savings.
 * Routes each request to the cheapest model that can handle it.
 *
 * Usage:
 *   # Install the plugin
 *   openclaw plugins install @blockrun/xclawrouter
 *
 *   # Fund your wallet with USDC on Base (address printed on install)
 *
 *   # Use smart routing (auto-picks cheapest model)
 *   openclaw models set blockrun/auto
 *
 *   # Or use any specific BlockRun model
 *   openclaw models set openai/gpt-5.3
 */

import type {
  OpenClawPluginDefinition,
  OpenClawPluginApi,
  OpenClawConfig,
  PluginCommandContext,
  OpenClawPluginCommandDefinition,
  ImageGenerationProviderPlugin,
  ImageGenerationRequest,
  MusicGenerationProviderPlugin,
  MusicGenerationRequest,
  VideoGenerationProviderPlugin,
  VideoGenerationRequest,
} from "./types.js";
import { blockrunProvider, setActiveProxy } from "./provider.js";
import { startProxy, getProxyPort } from "./proxy.js";
import { BLOCKRUN_EXA_PROVIDER_ID, blockrunExaWebSearchProvider } from "./web-search-provider.js";
import {
  resolveOrGenerateWalletKey,
  setupSolana,
  savePaymentChain,
  resolvePaymentChain,
  WALLET_FILE,
  MNEMONIC_FILE,
} from "./auth.js";
import type { WalletResolution } from "./auth.js";
import type { RoutingConfig } from "./router/index.js";
import { BalanceMonitor } from "./balance.js";
import { loadExcludeList } from "./exclude-models.js";

/**
 * Wait for proxy health check to pass (quick check, not RPC).
 * Returns true if healthy within timeout, false otherwise.
 */
async function waitForProxyHealth(port: number, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return true;
    } catch {
      // Proxy not ready yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
import { OPENCLAW_MODELS } from "./models.js";
import {
  writeFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  copyFileSync,
  renameSync,
} from "node:fs";
import { readFile as readFileAsync } from "node:fs/promises";
import { readTextFileSync } from "./fs-read.js";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "./version.js";
import { privateKeyToAccount } from "viem/accounts";
import { getStats } from "./stats.js";
import { buildPartnerTools, PARTNER_SERVICES } from "./partners/index.js";
import { createStatsCommand } from "./commands/stats.js";
import { createExcludeCommand } from "./commands/exclude.js";
import { BLOCKRUN_MCP_SERVER_NAME, removeManagedBlockrunMcpServerConfig } from "./mcp-config.js";

function getPackageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * Install XClawRouter skills into OpenClaw's workspace skills directory.
 *
 * OpenClaw agents discover skills by scanning {workspaceDir}/skills/ for SKILL.md
 * files. While the plugin manifest (`openclaw.plugin.json`) exposes skills for
 * OpenClaw's internal registry, agents often try to read skills from the workspace
 * path directly. This copies our bundled skills so they're always resolvable.
 *
 * Workspace path follows OpenClaw's convention:
 *   - Default: ~/.openclaw/workspace/skills/
 *   - With profile: ~/.openclaw/workspace-{profile}/skills/
 *
 * Only copies if the skill is missing or the content has changed.
 */
function installSkillsToWorkspace(logger: {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}) {
  try {
    // Resolve the package root: dist/index.js -> package root
    const packageRoot = getPackageRoot();
    const bundledSkillsDir = join(packageRoot, "skills");

    if (!existsSync(bundledSkillsDir)) {
      // Skills directory not bundled (dev mode or stripped package)
      return;
    }

    // Match OpenClaw's workspace resolution: ~/.openclaw/workspace[-{profile}]/
    const profile = (process["env"].OPENCLAW_PROFILE ?? "").trim().toLowerCase();
    const workspaceDirName =
      profile && profile !== "default" ? `workspace-${profile}` : "workspace";
    const workspaceSkillsDir = join(homedir(), ".openclaw", workspaceDirName, "skills");
    mkdirSync(workspaceSkillsDir, { recursive: true });

    // Scan bundled skills: each subdirectory contains a SKILL.md
    // Skip internal-only skills (release is for XClawRouter maintainers, not end users)
    const INTERNAL_SKILLS = new Set(["release"]);
    const entries = readdirSync(bundledSkillsDir, { withFileTypes: true });
    let installed = 0;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillName = entry.name;
      if (INTERNAL_SKILLS.has(skillName)) continue;
      const srcSkillFile = join(bundledSkillsDir, skillName, "SKILL.md");
      if (!existsSync(srcSkillFile)) continue;

      // Use original skill name as folder (matches what agents expect)
      const destDir = join(workspaceSkillsDir, skillName);
      const destSkillFile = join(destDir, "SKILL.md");

      // Check if update needed: compare content
      let needsUpdate = true;
      if (existsSync(destSkillFile)) {
        try {
          const srcContent = readTextFileSync(srcSkillFile);
          const destContent = readTextFileSync(destSkillFile);
          if (srcContent === destContent) needsUpdate = false;
        } catch {
          // Can't read — overwrite
        }
      }

      if (needsUpdate) {
        mkdirSync(destDir, { recursive: true });
        copyFileSync(srcSkillFile, destSkillFile);
        installed++;
      }
    }

    if (installed > 0) {
      logger.info(`Installed ${installed} skill(s) to ${workspaceSkillsDir}`);
    }
  } catch (err) {
    logger.warn(`Failed to install skills: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Detect if we're running in shell completion mode.
 * When `openclaw completion --shell zsh` runs, it loads plugins but only needs
 * the completion script output - any stdout logging pollutes the script and
 * causes zsh to interpret colored text like `[plugins]` as glob patterns.
 */
function isCompletionMode(): boolean {
  const args = process.argv;
  // Check for: openclaw completion --shell <shell>
  // argv[0] = node/bun, argv[1] = openclaw, argv[2] = completion
  return args.some((arg, i) => arg === "completion" && i >= 1 && i <= 3);
}

/**
 * Detect if we're running in gateway mode.
 * The proxy should ONLY start when the gateway is running.
 * During CLI commands (plugins, models, etc), the proxy keeps the process alive.
 */
function isGatewayMode(): boolean {
  const args = process.argv;
  // Gateway mode is: openclaw gateway start/restart/stop
  return args.includes("gateway");
}

/**
 * Inject BlockRun models config into OpenClaw config file.
 * This is required because registerProvider() alone doesn't make models available.
 *
 * CRITICAL: This function must be idempotent and handle ALL edge cases:
 * - Config file doesn't exist (create it)
 * - Config file exists but is empty/invalid (reinitialize)
 * - blockrun provider exists but has undefined fields (fix them)
 * - Config exists but uses old port/models (update them)
 *
 * This function is called on EVERY plugin load to ensure config is always correct.
 *
 * Also strips any previously managed `mcp.servers.blockrun` entry we wrote in
 * older releases — ClawRouter no longer bundles the MCP bridge (the npx-spawned
 * grandchildren were leaking). The scrub only removes entries matching the
 * managed shape; user-defined `blockrun` MCP servers are left alone.
 */
function injectModelsConfig(logger: { info: (msg: string) => void }): void {
  const configDir = join(homedir(), ".openclaw");
  const configPath = join(configDir, "openclaw.json");

  let config: OpenClawConfig = {};
  let needsWrite = false;

  // Create config directory if it doesn't exist
  if (!existsSync(configDir)) {
    try {
      mkdirSync(configDir, { recursive: true });
      logger.info("Created OpenClaw config directory");
    } catch (err) {
      logger.info(
        `Failed to create config dir: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
  }

  // Load existing config or create new one
  // IMPORTANT: On parse failure, we backup and skip writing to avoid clobbering
  // other plugins' config (e.g. Telegram channels). This prevents a race condition
  // where a partial/corrupt config file causes us to overwrite everything with
  // only our models+agents sections.
  if (existsSync(configPath)) {
    try {
      const content = readTextFileSync(configPath).trim();
      if (content) {
        config = JSON.parse(content);
      } else {
        logger.info("OpenClaw config is empty, initializing");
        needsWrite = true;
      }
    } catch (err) {
      // Config file exists but is corrupt/invalid JSON — likely a partial write
      // from another plugin or a race condition during gateway restart.
      // Backup the corrupt file and SKIP writing to avoid losing other config.
      const backupPath = `${configPath}.backup.${Date.now()}`;
      try {
        copyFileSync(configPath, backupPath);
        logger.info(`Config parse failed, backed up to ${backupPath}`);
      } catch {
        logger.info("Config parse failed, could not create backup");
      }
      logger.info(
        `Skipping config injection (corrupt file): ${err instanceof Error ? err.message : String(err)}`,
      );
      return; // Don't write — we'd lose other plugins' config
    }
  } else {
    logger.info("OpenClaw config not found, creating");
    needsWrite = true;
  }

  // Initialize config structure
  if (!config.models) {
    config.models = {};
    needsWrite = true;
  }
  const models = config.models as Record<string, unknown>;
  if (!models.providers) {
    models.providers = {};
    needsWrite = true;
  }

  const proxyPort = getProxyPort();
  const expectedBaseUrl = `http://127.0.0.1:${proxyPort}/v1`;

  const providers = models.providers as Record<string, unknown>;

  if (!providers.blockrun) {
    // Create new blockrun provider config
    providers.blockrun = {
      baseUrl: expectedBaseUrl,
      api: "openai-completions",
      // apiKey is required by pi-coding-agent's ModelRegistry for providers with models.
      // We use a placeholder since the proxy handles real x402 auth internally.
      apiKey: "x402-proxy-handles-auth",
      models: OPENCLAW_MODELS,
    };
    logger.info("Injected BlockRun provider config");
    needsWrite = true;
  } else {
    // Validate and fix existing blockrun config
    const blockrun = providers.blockrun as Record<string, unknown>;
    let fixed = false;

    // Fix: explicitly check for undefined/missing fields
    if (!blockrun.baseUrl || blockrun.baseUrl !== expectedBaseUrl) {
      blockrun.baseUrl = expectedBaseUrl;
      fixed = true;
    }
    // Ensure api field is present
    if (!blockrun.api) {
      blockrun.api = "openai-completions";
      fixed = true;
    }
    // Ensure apiKey is present (required by ModelRegistry for /model picker)
    if (!blockrun.apiKey) {
      blockrun.apiKey = "x402-proxy-handles-auth";
      fixed = true;
    }
    // Always refresh models list (ensures new models/aliases are available)
    // Check both length AND content - new models may be added without changing count
    const currentModels = blockrun.models as Array<{ id?: string }>;
    const currentModelIds = new Set(
      Array.isArray(currentModels) ? currentModels.map((m) => m?.id).filter(Boolean) : [],
    );
    const expectedModelIds = OPENCLAW_MODELS.map((m) => m.id);
    const needsModelUpdate =
      !currentModels ||
      !Array.isArray(currentModels) ||
      currentModels.length !== OPENCLAW_MODELS.length ||
      expectedModelIds.some((id) => !currentModelIds.has(id));

    if (needsModelUpdate) {
      blockrun.models = OPENCLAW_MODELS;
      fixed = true;
      logger.info(`Updated models list (${OPENCLAW_MODELS.length} models)`);
    }

    if (fixed) {
      logger.info("Fixed incomplete BlockRun provider config");
      needsWrite = true;
    }
  }

  // Set blockrun/auto as default model ONLY on first install (not every load!)
  // This respects user's model selection and prevents hijacking their choice.
  if (!config.agents) {
    config.agents = {};
    needsWrite = true;
  }
  const agents = config.agents as Record<string, unknown>;
  if (!agents.defaults) {
    agents.defaults = {};
    needsWrite = true;
  }
  const defaults = agents.defaults as Record<string, unknown>;
  if (!defaults.model || typeof defaults.model !== "object" || Array.isArray(defaults.model)) {
    // Convert plain string "blockrun/auto" → { primary: "blockrun/auto" }
    // Also handles number, boolean, array, or any other non-object type
    const prev = typeof defaults.model === "string" ? defaults.model : undefined;
    defaults.model = prev ? { primary: prev } : {};
    needsWrite = true;
  }
  const model = defaults.model as Record<string, unknown>;

  // ONLY set default if no primary model exists (first install)
  // Do NOT override user's selection on subsequent loads
  if (!model.primary) {
    model.primary = "blockrun/auto";
    logger.info("Set default model to blockrun/auto (first install)");
    needsWrite = true;
  }

  // Populate agents.defaults.models (the allowlist) with top BlockRun models.
  // OpenClaw uses this as a whitelist — only listed models appear in the /model picker.
  // Existing non-blockrun entries are preserved (e.g. from other providers).
  const TOP_MODELS = [
    "auto",
    "free",
    "eco",
    "premium",
    "anthropic/claude-sonnet-4.6",
    "anthropic/claude-opus-4.7",
    "anthropic/claude-opus-4.6",
    "anthropic/claude-haiku-4.5",
    "openai/gpt-5.4",
    "openai/gpt-5.3",
    "openai/gpt-5.3-codex",
    "openai/gpt-4o",
    "openai/o3",
    "google/gemini-3.1-pro",
    "google/gemini-3-flash-preview",
    "deepseek/deepseek-chat",
    "moonshot/kimi-k2.5",
    "xai/grok-3",
    "minimax/minimax-m2.5",
    // Free models (free/ prefix so users see "free" in picker)
    "free/gpt-oss-120b",
    "free/gpt-oss-20b",
    "free/nemotron-ultra-253b",
    "free/deepseek-v3.2",
    "free/mistral-large-3-675b",
    "free/qwen3-coder-480b",
    "free/devstral-2-123b",
    "free/llama-4-maverick",
    "free/nemotron-3-super-120b",
    "free/nemotron-super-49b",
    "free/glm-4.7",
    "zai/glm-5",
    "zai/glm-5.1",
    "zai/glm-5-turbo",
  ];
  if (!defaults.models || typeof defaults.models !== "object" || Array.isArray(defaults.models)) {
    defaults.models = {};
    needsWrite = true;
  }
  const allowlist = defaults.models as Record<string, unknown>;
  const DEPRECATED_BLOCKRUN_MODELS = ["blockrun/xai/grok-code-fast-1"];
  let removedDeprecatedCount = 0;
  for (const key of DEPRECATED_BLOCKRUN_MODELS) {
    if (allowlist[key]) {
      delete allowlist[key];
      removedDeprecatedCount++;
    }
  }
  if (removedDeprecatedCount > 0) {
    needsWrite = true;
    logger.info(`Removed ${removedDeprecatedCount} deprecated model entries from allowlist`);
  }
  // Additive-only: add TOP_MODELS entries if missing, never delete user-defined entries.
  // Preserves any blockrun/* IDs the user has manually added outside this curated list.
  let addedCount = 0;
  for (const id of TOP_MODELS) {
    const key = `blockrun/${id}`;
    if (!allowlist[key]) {
      allowlist[key] = {};
      addedCount++;
    }
  }
  if (addedCount > 0) {
    needsWrite = true;
    logger.info(`Added ${addedCount} models to allowlist (${TOP_MODELS.length} total)`);
  }

  // Force web_search onto BlockRun Exa so OpenClaw never silently falls back
  // to a native provider that expects the user's own Exa API key.
  if (!config.tools || typeof config.tools !== "object" || Array.isArray(config.tools)) {
    config.tools = {};
    needsWrite = true;
  }
  const tools = config.tools as Record<string, unknown>;
  if (!tools.web || typeof tools.web !== "object" || Array.isArray(tools.web)) {
    tools.web = {};
    needsWrite = true;
  }
  const web = tools.web as Record<string, unknown>;
  if (!web.search || typeof web.search !== "object" || Array.isArray(web.search)) {
    web.search = {};
    needsWrite = true;
  }
  const search = web.search as Record<string, unknown>;
  if (search.provider !== BLOCKRUN_EXA_PROVIDER_ID) {
    search.provider = BLOCKRUN_EXA_PROVIDER_ID;
    logger.info(`Forced web_search provider to ${BLOCKRUN_EXA_PROVIDER_ID}`);
    needsWrite = true;
  }
  if (search.enabled !== true) {
    search.enabled = true;
    needsWrite = true;
  }

  if (removeManagedBlockrunMcpServerConfig(config)) {
    needsWrite = true;
    logger.info(
      `Removed bundled BlockRun MCP server config (${BLOCKRUN_MCP_SERVER_NAME}) — restart the gateway to free any leaked processes`,
    );
  }

  // Write config file if any changes were made
  // Use atomic write (temp file + rename) to prevent partial writes that could
  // corrupt the config and cause other plugins to lose their settings on next load.
  if (needsWrite) {
    try {
      const tmpPath = `${configPath}.tmp.${process.pid}`;
      writeFileSync(tmpPath, JSON.stringify(config, null, 2));
      renameSync(tmpPath, configPath);
      logger.info("Smart routing enabled (blockrun/auto)");
    } catch (err) {
      logger.info(`Failed to write config: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Inject dummy auth profile for BlockRun into agent auth stores.
 * OpenClaw's agent system looks for auth credentials even if provider has auth: [].
 * We inject a placeholder so the lookup succeeds (proxy handles real auth internally).
 */
function injectAuthProfile(logger: { info: (msg: string) => void }): void {
  const agentsDir = join(homedir(), ".openclaw", "agents");

  // Create agents directory if it doesn't exist
  if (!existsSync(agentsDir)) {
    try {
      mkdirSync(agentsDir, { recursive: true });
    } catch (err) {
      logger.info(
        `Could not create agents dir: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
  }

  try {
    // Find all agent directories
    let agents = readdirSync(agentsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    // Always ensure "main" agent has auth (most common agent)
    if (!agents.includes("main")) {
      agents = ["main", ...agents];
    }

    for (const agentId of agents) {
      const authDir = join(agentsDir, agentId, "agent");
      const authPath = join(authDir, "auth-profiles.json");

      // Create agent dir if needed
      if (!existsSync(authDir)) {
        try {
          mkdirSync(authDir, { recursive: true });
        } catch {
          continue; // Skip if we can't create the dir
        }
      }

      // Load or create auth-profiles.json with correct OpenClaw format
      // Format: { version: 1, profiles: { "provider:profileId": { type, provider, key } } }
      let store: { version: number; profiles: Record<string, unknown> } = {
        version: 1,
        profiles: {},
      };
      if (existsSync(authPath)) {
        try {
          const existing = JSON.parse(readTextFileSync(authPath));
          // Check if valid OpenClaw format (has version and profiles)
          if (existing.version && existing.profiles) {
            store = existing;
          }
          // Old format without version/profiles is discarded and recreated
        } catch {
          // Invalid JSON, use fresh store
        }
      }

      // Check if blockrun auth already exists (OpenClaw format: profiles["provider:profileId"])
      const profileKey = "blockrun:default";
      if (store.profiles[profileKey]) {
        continue; // Already configured
      }

      // Inject placeholder auth for blockrun (OpenClaw format)
      // The proxy handles real x402 auth internally, this just satisfies OpenClaw's lookup
      store.profiles[profileKey] = {
        type: "api_key",
        provider: "blockrun",
        key: "x402-proxy-handles-auth",
      };

      try {
        writeFileSync(authPath, JSON.stringify(store, null, 2));
        logger.info(`Injected BlockRun auth profile for agent: ${agentId}`);
      } catch (err) {
        logger.info(
          `Could not inject auth for ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err) {
    logger.info(`Auth injection failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Store active proxy handle for cleanup on gateway_stop
let activeProxyHandle: Awaited<ReturnType<typeof startProxy>> | null = null;
let pendingConfiguredStartupApi: OpenClawPluginApi | null = null;
type ProcessWithClawRouterState = NodeJS.Process & {
  __clawrouterProxyStarted?: boolean;
  __clawrouterDeferredStartTimer?: ReturnType<typeof setTimeout>;
  __clawrouterStartupGeneration?: number;
  __clawrouterStartedWithEmptyConfig?: boolean;
  __clawrouterStartupPhase?: "idle" | "probing" | "starting" | "running";
  /** Suppress verbose registration logs on repeat register() calls. */
  __clawrouterRegistrationLogged?: boolean;
};

function clearDeferredProxyStartTimer(
  proc: ProcessWithClawRouterState = process as ProcessWithClawRouterState,
): boolean {
  if (!proc.__clawrouterDeferredStartTimer) return false;
  clearTimeout(proc.__clawrouterDeferredStartTimer);
  proc.__clawrouterDeferredStartTimer = undefined;
  return true;
}

function beginProxyStartupAttempt(
  proc: ProcessWithClawRouterState = process as ProcessWithClawRouterState,
  startedWithEmptyConfig = false,
): number {
  const generation = (proc.__clawrouterStartupGeneration ?? 0) + 1;
  proc.__clawrouterStartupGeneration = generation;
  proc.__clawrouterProxyStarted = true;
  proc.__clawrouterStartedWithEmptyConfig = startedWithEmptyConfig;
  proc.__clawrouterStartupPhase = "probing";
  return generation;
}

function isProxyStartupCurrent(
  generation: number,
  proc: ProcessWithClawRouterState = process as ProcessWithClawRouterState,
): boolean {
  return (
    proc.__clawrouterStartupGeneration === generation && proc.__clawrouterProxyStarted === true
  );
}

function resetProxyStartupState(): void {
  const proc = process as ProcessWithClawRouterState;
  clearDeferredProxyStartTimer(proc);
  pendingConfiguredStartupApi = null;
  proc.__clawrouterStartupGeneration = (proc.__clawrouterStartupGeneration ?? 0) + 1;
  proc.__clawrouterProxyStarted = false;
  proc.__clawrouterStartedWithEmptyConfig = false;
  proc.__clawrouterStartupPhase = "idle";
  setActiveProxy(null);
}

function startPendingConfiguredProxyIfQueued(
  proc: ProcessWithClawRouterState = process as ProcessWithClawRouterState,
): boolean {
  if (!pendingConfiguredStartupApi) return false;
  if (proc.__clawrouterProxyStarted || activeProxyHandle) {
    pendingConfiguredStartupApi = null;
    return false;
  }
  const api = pendingConfiguredStartupApi;
  pendingConfiguredStartupApi = null;
  const generation = beginProxyStartupAttempt(proc, false);
  api.logger.info("Starting proxy with populated pluginConfig");
  startProxyAfterPortProbe(api, generation);
  return true;
}

function resumePendingConfiguredProxyAfterStaleFailure(
  proc: ProcessWithClawRouterState = process as ProcessWithClawRouterState,
): boolean {
  if (!pendingConfiguredStartupApi) return false;
  if (proc.__clawrouterProxyStarted || activeProxyHandle) return false;
  proc.__clawrouterStartupPhase = "idle";
  return startPendingConfiguredProxyIfQueued(proc);
}

function supersedeEmptyConfigStartup(api: OpenClawPluginApi): void {
  const proc = process as ProcessWithClawRouterState;
  pendingConfiguredStartupApi = api;
  proc.__clawrouterStartupGeneration = (proc.__clawrouterStartupGeneration ?? 0) + 1;
  proc.__clawrouterProxyStarted = false;
  proc.__clawrouterStartedWithEmptyConfig = false;

  if (activeProxyHandle) {
    const oldHandle = activeProxyHandle;
    activeProxyHandle = null;
    setActiveProxy(null);
    proc.__clawrouterStartupPhase = "idle";
    void oldHandle
      .close()
      .catch(() => {})
      .finally(() => {
        startPendingConfiguredProxyIfQueued(proc);
      });
    return;
  }

  if (proc.__clawrouterStartupPhase === "starting") {
    api.logger.info(
      "Populated pluginConfig arrived during provisional startup — queued restart with current config",
    );
    return;
  }

  proc.__clawrouterStartupPhase = "idle";
  startPendingConfiguredProxyIfQueued(proc);
}

/**
 * Start the x402 proxy in the background.
 * Called from register() because OpenClaw's loader only invokes register(),
 * treating activate() as an alias (def.register ?? def.activate).
 */
async function startProxyInBackground(
  api: OpenClawPluginApi,
  startupGeneration?: number,
): Promise<boolean> {
  const proc = process as ProcessWithClawRouterState;
  if (startupGeneration !== undefined && isProxyStartupCurrent(startupGeneration, proc)) {
    proc.__clawrouterStartupPhase = "starting";
  }

  // Resolve wallet key: plugin config → saved file → env var → auto-generate.
  // pluginConfig.walletKey is declared in openclaw.plugin.json configSchema but
  // was previously never read here — that was a bug.
  const configKey = api.pluginConfig?.walletKey as string | undefined;
  let wallet: WalletResolution;

  if (typeof configKey === "string" && /^0x[0-9a-fA-F]{64}$/.test(configKey)) {
    const account = privateKeyToAccount(configKey as `0x${string}`);
    wallet = { key: configKey, address: account.address, source: "config" };
  } else {
    if (configKey !== undefined) {
      api.logger.warn(
        `pluginConfig.walletKey is set but invalid (expected 0x + 64 hex chars) — falling back to saved wallet`,
      );
    }
    wallet = await resolveOrGenerateWalletKey();
  }

  // Log wallet source
  if (wallet.source === "okx") {
    api.logger.info(
      `Using OKX onchainos wallet: ${wallet.address}${wallet.email ? ` (${wallet.email})` : ""}`,
    );
  } else if (wallet.source === "generated") {
    api.logger.warn(`════════════════════════════════════════════════`);
    api.logger.warn(`  NEW WALLET GENERATED — BACK UP YOUR KEY NOW!`);
    api.logger.warn(`  Address : ${wallet.address}`);
    api.logger.warn(`  Run /wallet export to get your private key`);
    api.logger.warn(`  Losing this key = losing your USDC funds`);
    api.logger.warn(`  Or install OKX onchainos to use your OKX wallet:`);
    api.logger.warn(`     https://web3.okx.com/onchainos`);
    api.logger.warn(`════════════════════════════════════════════════`);
  } else if (wallet.source === "saved") {
    api.logger.info(`Using saved wallet: ${wallet.address}`);
  } else if (wallet.source === "config") {
    api.logger.info(`Using wallet from plugin config: ${wallet.address}`);
  } else {
    api.logger.info(`Using wallet from BLOCKRUN_WALLET_KEY: ${wallet.address}`);
  }

  // Resolve routing config overrides from plugin config
  const routingConfig = api.pluginConfig?.routing as Partial<RoutingConfig> | undefined;

  const maxCostPerRunUsd =
    typeof api.pluginConfig?.maxCostPerRun === "number"
      ? (api.pluginConfig.maxCostPerRun as number)
      : undefined;

  const maxCostPerRunMode: "graceful" | "strict" =
    api.pluginConfig?.maxCostPerRunMode === "strict" ? "strict" : "graceful";

  if (maxCostPerRunUsd !== undefined) {
    api.logger.info(
      `Cost cap: $${maxCostPerRunUsd.toFixed(2)} per session (mode: ${maxCostPerRunMode})`,
    );
  }

  const proxy = await startProxy({
    wallet,
    routingConfig,
    maxCostPerRunUsd,
    maxCostPerRunMode,
    onReady: (port) => {
      api.logger.info(`BlockRun x402 proxy listening on port ${port}`);
    },
    onError: (error) => {
      api.logger.error(`BlockRun proxy error: ${error.message}`);
    },
    onRouted: (decision) => {
      const cost = decision.costEstimate.toFixed(4);
      const saved = (decision.savings * 100).toFixed(0);
      api.logger.info(
        `[${decision.tier}] ${decision.model} $${cost} (saved ${saved}%) | ${decision.reasoning}`,
      );
    },
    onLowBalance: (info) => {
      api.logger.warn(`[!] Low balance: ${info.balanceUSD}. Fund wallet: ${info.walletAddress}`);
    },
    onInsufficientFunds: (info) => {
      api.logger.error(
        `[!] Insufficient funds. Balance: ${info.balanceUSD}, Needed: ${info.requiredUSD}. Fund wallet: ${info.walletAddress}`,
      );
    },
  });

  if (startupGeneration !== undefined && !isProxyStartupCurrent(startupGeneration)) {
    try {
      await proxy.close();
    } catch {
      // Best-effort cleanup for stale startup attempts
    }
    proc.__clawrouterStartupPhase = "idle";
    startPendingConfiguredProxyIfQueued(proc);
    return false;
  }

  setActiveProxy(proxy);
  activeProxyHandle = proxy;
  proc.__clawrouterStartupPhase = "running";

  const startupExclusions = loadExcludeList();
  if (startupExclusions.size > 0) {
    api.logger.info(
      `Model exclusions active (${startupExclusions.size}): ${[...startupExclusions].join(", ")}`,
    );
  }

  api.logger.info(`XClawRouter ready — smart routing enabled`);
  api.logger.info(`Pricing: Simple ~$0.001 | Code ~$0.01 | Complex ~$0.05 | Free: $0`);

  // Non-blocking balance check AFTER proxy is ready (won't hang startup)
  // Uses the proxy's chain-aware balance monitor and matching active-chain address.
  const currentChain = await resolvePaymentChain();
  const displayAddress =
    currentChain === "solana" && proxy.solanaAddress ? proxy.solanaAddress : wallet.address;
  const network = currentChain === "solana" ? "Solana" : "Base";
  proxy.balanceMonitor
    .checkBalance()
    .then(async (balance) => {
      if (balance.isEmpty) {
        api.logger.info(`Wallet (${network}): ${displayAddress}`);
        api.logger.info(
          `Balance: $0.00 — send USDC on ${network} to the address above to unlock paid models.`,
        );
      } else if (balance.isLow) {
        api.logger.info(
          `Wallet (${network}): ${displayAddress} | Balance: ${balance.balanceUSD} (low — top up soon)`,
        );
      } else {
        api.logger.info(`Wallet (${network}): ${displayAddress} | Balance: ${balance.balanceUSD}`);
      }
      // On Solana, if USDC is low/empty, check for SOL and suggest swap
      if (currentChain === "solana" && (balance.isEmpty || balance.isLow)) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const solLamports: bigint = await (proxy.balanceMonitor as any).checkSolBalance();
          // Only suggest if they have meaningful SOL (> 0.01 SOL = 10M lamports)
          if (solLamports > 10_000_000n) {
            const sol = Number(solLamports) / 1_000_000_000;
            api.logger.info(
              `You have ${sol.toFixed(2)} SOL — swap to USDC: https://jup.ag/swap/SOL-USDC`,
            );
          }
        } catch {
          // SOL check is best-effort, don't block startup
        }
      }
    })
    .catch(() => {
      api.logger.info(`Wallet (${network}): ${displayAddress} | Balance: (checking...)`);
    });
  return true;
}

/**
 * Probe the proxy port and start the proxy in the background if free.
 * Extracted so the deferred-startup timer (#147 fix) can call it too.
 */
function startProxyAfterPortProbe(api: OpenClawPluginApi, startupGeneration: number): void {
  const proxyPort = getProxyPort();
  const portProbe = import("node:net").then(
    (net) =>
      new Promise<boolean>((resolve) => {
        const sock = net.connect({ host: "127.0.0.1", port: proxyPort }, () => {
          sock.destroy();
          resolve(true); // port is already in use
        });
        sock.on("error", () => resolve(false)); // port is free
        sock.setTimeout(500, () => {
          sock.destroy();
          resolve(false);
        });
      }),
  );
  portProbe
    .then((portInUse) => {
      if (!isProxyStartupCurrent(startupGeneration)) {
        return;
      }
      if (portInUse) {
        resetProxyStartupState();
        api.logger.info(
          `Port ${proxyPort} already in use — skipping proxy startup (another instance running)`,
        );
        return;
      }
      return startProxyInBackground(api, startupGeneration).then(async (started) => {
        if (!started || !isProxyStartupCurrent(startupGeneration)) {
          return;
        }
        const port = getProxyPort();
        const healthy = await waitForProxyHealth(port, 15000);
        if (!healthy && isProxyStartupCurrent(startupGeneration)) {
          api.logger.warn(`Proxy health check timed out, commands may not work immediately`);
        }
      });
    })
    .catch((err) => {
      if (isProxyStartupCurrent(startupGeneration)) {
        resetProxyStartupState();
      } else {
        resumePendingConfiguredProxyAfterStaleFailure();
      }
      api.logger.error(
        `Failed to start BlockRun proxy: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
}

// createStatsCommand moved to src/commands/stats.ts

// createExcludeCommand moved to src/commands/exclude.ts

/**
 * /wallet command handler for XClawRouter.
 * - /wallet or /wallet status: Show wallet address, balance, usage, and key file location
 * - /wallet export: Show private key for backup (with security warning)
 */

// Local directories where the proxy saves media files
const IMAGE_DIR = join(homedir(), ".openclaw", "blockrun", "images");
const AUDIO_DIR = join(homedir(), ".openclaw", "blockrun", "audio");

/**
 * Build the ImageGenerationProvider that registers BlockRun image models
 * with OpenClaw's native image generation UI.
 * Delegates to the local proxy (which handles x402 payment).
 */
function buildImageGenerationProvider(): ImageGenerationProviderPlugin {
  return {
    id: "blockrun",
    label: "BlockRun",
    defaultModel: "openai/gpt-image-1",
    models: [
      "openai/gpt-image-1",
      "openai/dall-e-3",
      "google/nano-banana",
      "google/nano-banana-pro",
    ],
    capabilities: {
      generate: {
        maxCount: 1,
        supportsSize: true,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
      edit: { enabled: false },
      geometry: {
        sizes: [
          "1024x1024",
          "1536x1024",
          "1024x1536",
          "1792x1024",
          "1024x1792",
          "2048x2048",
          "4096x4096",
        ],
      },
    },
    isConfigured: () => existsSync(WALLET_FILE),
    generateImage: async (req: ImageGenerationRequest) => {
      const port = getProxyPort();
      const body = JSON.stringify({
        model: req.model,
        prompt: req.prompt,
        size: req.size ?? "1024x1024",
        n: req.count ?? 1,
      });
      const resp = await fetch(`http://127.0.0.1:${port}/v1/images/generations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: req.timeoutMs ? AbortSignal.timeout(req.timeoutMs) : undefined,
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        throw new Error(`BlockRun image generation failed (${resp.status}): ${errText}`);
      }
      const result = (await resp.json()) as {
        data?: Array<{ url?: string; revised_prompt?: string }>;
        model?: string;
      };
      const images = await Promise.all(
        (result.data ?? []).map(async (img) => {
          // URL format: http://localhost:PORT/images/FILENAME
          const filename = img.url?.split("/images/").pop();
          if (!filename) throw new Error(`Unexpected image URL format: ${img.url}`);
          const filePath = join(IMAGE_DIR, filename);
          const buffer = await readFileAsync(filePath);
          const ext = filename.split(".").pop()?.toLowerCase() ?? "png";
          const mimeType =
            ext === "jpg" || ext === "jpeg"
              ? "image/jpeg"
              : ext === "webp"
                ? "image/webp"
                : "image/png";
          return { buffer, mimeType, fileName: filename, revisedPrompt: img.revised_prompt };
        }),
      );
      return { images, model: result.model ?? req.model };
    },
  };
}

/**
 * Build the MusicGenerationProvider that registers BlockRun music models
 * with OpenClaw's native music generation UI.
 * Delegates to the local proxy (which handles x402 payment).
 */
function buildMusicGenerationProvider(): MusicGenerationProviderPlugin {
  return {
    id: "blockrun",
    label: "BlockRun",
    defaultModel: "minimax/music-2.5+",
    models: ["minimax/music-2.5+", "minimax/music-2.5"],
    capabilities: {
      maxTracks: 1,
      maxDurationSeconds: 240,
      supportsLyrics: true,
      supportsInstrumental: true,
      supportsDuration: true,
      supportsFormat: true,
      supportedFormats: ["mp3"],
    },
    isConfigured: () => existsSync(WALLET_FILE),
    generateMusic: async (req: MusicGenerationRequest) => {
      const port = getProxyPort();
      const body = JSON.stringify({
        model: req.model,
        prompt: req.prompt,
        ...(req.lyrics ? { lyrics: req.lyrics } : {}),
        ...(req.instrumental !== undefined ? { instrumental: req.instrumental } : {}),
        ...(req.durationSeconds ? { duration_seconds: req.durationSeconds } : {}),
      });
      // Music generation can take up to 3 minutes
      const timeoutMs = req.timeoutMs ?? 200_000;
      const resp = await fetch(`http://127.0.0.1:${port}/v1/audio/generations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        throw new Error(`BlockRun music generation failed (${resp.status}): ${errText}`);
      }
      const result = (await resp.json()) as {
        data?: Array<{ url?: string; duration_seconds?: number; lyrics?: string }>;
        model?: string;
      };
      const tracks = await Promise.all(
        (result.data ?? []).map(async (track) => {
          // URL format: http://localhost:PORT/audio/FILENAME
          const filename = track.url?.split("/audio/").pop();
          if (!filename) throw new Error(`Unexpected audio URL format: ${track.url}`);
          const filePath = join(AUDIO_DIR, filename);
          const buffer = await readFileAsync(filePath);
          const ext = filename.split(".").pop()?.toLowerCase() ?? "mp3";
          const mimeType = ext === "wav" ? "audio/wav" : "audio/mpeg";
          return {
            buffer,
            mimeType,
            fileName: filename,
            metadata: {
              ...(track.duration_seconds ? { duration_seconds: track.duration_seconds } : {}),
              ...(track.lyrics ? { lyrics: track.lyrics } : {}),
            },
          };
        }),
      );
      const allLyrics = (result.data ?? [])
        .map((t) => t.lyrics)
        .filter((l): l is string => Boolean(l));
      return {
        tracks,
        model: result.model ?? req.model,
        lyrics: allLyrics.length ? allLyrics : undefined,
      };
    },
  };
}

const VIDEO_DIR = join(homedir(), ".openclaw", "blockrun", "videos");

/**
 * Build the VideoGenerationProvider that registers BlockRun video models
 * with OpenClaw's native video generation UI.
 * Delegates to the local proxy (which handles x402 payment + polling).
 */
function buildVideoGenerationProvider(): VideoGenerationProviderPlugin {
  return {
    id: "blockrun",
    label: "BlockRun",
    defaultModel: "xai/grok-imagine-video",
    models: [
      "xai/grok-imagine-video",
      "bytedance/seedance-1.5-pro",
      "bytedance/seedance-2.0-fast",
      "bytedance/seedance-2.0",
    ],
    capabilities: {
      maxVideos: 1,
      maxInputImages: 1,
      maxDurationSeconds: 10,
      supportedDurationSeconds: [5, 8, 10],
      supportsAudio: false,
      imageToVideo: {
        enabled: true,
        maxInputImages: 1,
        maxDurationSeconds: 10,
        supportedDurationSeconds: [5, 8, 10],
      },
    },
    isConfigured: () => existsSync(WALLET_FILE),
    generateVideo: async (req: VideoGenerationRequest) => {
      const port = getProxyPort();
      const imageUrl = req.inputImages?.[0]?.url;
      const body = JSON.stringify({
        model: req.model,
        prompt: req.prompt,
        ...(imageUrl ? { image_url: imageUrl } : {}),
        ...(req.durationSeconds ? { duration_seconds: req.durationSeconds } : {}),
      });
      // Video generation can take 30-120s (upstream polling), allow 3 minutes
      const timeoutMs = req.timeoutMs ?? 200_000;
      const resp = await fetch(`http://127.0.0.1:${port}/v1/videos/generations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        throw new Error(`BlockRun video generation failed (${resp.status}): ${errText}`);
      }
      const result = (await resp.json()) as {
        data?: Array<{ url?: string; duration_seconds?: number }>;
        model?: string;
      };
      const videos = await Promise.all(
        (result.data ?? []).map(async (clip) => {
          // URL format: http://localhost:PORT/videos/FILENAME
          const filename = clip.url?.split("/videos/").pop();
          if (!filename) throw new Error(`Unexpected video URL format: ${clip.url}`);
          const filePath = join(VIDEO_DIR, filename);
          const buffer = await readFileAsync(filePath);
          const ext = filename.split(".").pop()?.toLowerCase() ?? "mp4";
          const mimeType =
            ext === "webm" ? "video/webm" : ext === "mov" ? "video/quicktime" : "video/mp4";
          return {
            buffer,
            mimeType,
            fileName: filename,
            metadata: {
              ...(clip.duration_seconds ? { duration_seconds: clip.duration_seconds } : {}),
            },
          };
        }),
      );
      return {
        videos,
        model: result.model ?? req.model,
      };
    },
  };
}

/**
 * Restart the proxy in-place after a chain switch.
 * Closes the running proxy (freeing port 8402) and starts a fresh one
 * that reads the newly persisted payment-chain preference from disk.
 * Fire-and-forget — the wallet command returns immediately with a status message.
 */
function restartProxyForChainSwitch(api: OpenClawPluginApi): void {
  const oldHandle = activeProxyHandle;
  activeProxyHandle = null;
  const restartGeneration = beginProxyStartupAttempt();
  const doRestart = async () => {
    if (oldHandle) {
      try {
        await oldHandle.close();
      } catch {
        // Ignore close errors — port may already be free
      }
    }
    // Brief pause so the OS releases the port before we re-bind
    await new Promise((r) => setTimeout(r, 300));
    if (!isProxyStartupCurrent(restartGeneration)) return;
    await startProxyInBackground(api, restartGeneration);
  };
  doRestart().catch((err) => {
    if (isProxyStartupCurrent(restartGeneration)) {
      resetProxyStartupState();
    }
    api.logger.error(
      `Failed to restart proxy after chain switch: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

function createWalletCommand(api?: OpenClawPluginApi): OpenClawPluginCommandDefinition {
  return {
    name: "wallet",
    description: "Show BlockRun wallet info, balance, chain, or export key",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: PluginCommandContext) => {
      const subcommand = ctx.args?.trim().toLowerCase() || "status";

      // Read wallet key if it exists
      let walletKey: string | undefined;
      let address: string | undefined;
      try {
        if (existsSync(WALLET_FILE)) {
          walletKey = readTextFileSync(WALLET_FILE).trim();
          if (walletKey.startsWith("0x") && walletKey.length === 66) {
            const account = privateKeyToAccount(walletKey as `0x${string}`);
            address = account.address;
          }
        }
      } catch {
        // Wallet file doesn't exist or is invalid
      }

      if (!walletKey || !address) {
        return {
          text: `No XClawRouter wallet found.\n\nRun \`openclaw plugins install @blockrun/xclawrouter\` to generate a wallet.`,
          isError: true,
        };
      }

      if (subcommand === "export") {
        // Export private key + mnemonic for backup
        const lines = [
          "**XClawRouter Wallet Export**",
          "",
          "**SECURITY WARNING**: Your private key and mnemonic control your wallet funds.",
          "Never share these. Anyone with them can spend your USDC.",
          "",
          "**EVM (Base):**",
          `  Address: \`${address}\``,
          `  Private Key: \`${walletKey}\``,
        ];

        // Include mnemonic if it exists (Solana wallet derived from it)
        let hasMnemonic = false;
        try {
          if (existsSync(MNEMONIC_FILE)) {
            const mnemonic = readTextFileSync(MNEMONIC_FILE).trim();
            if (mnemonic) {
              hasMnemonic = true;
              // Derive Solana address for display
              const { deriveSolanaKeyBytes } = await import("./wallet.js");
              const solKeyBytes = deriveSolanaKeyBytes(mnemonic);
              const { createKeyPairSignerFromPrivateKeyBytes } = await import("@solana/kit");
              const signer = await createKeyPairSignerFromPrivateKeyBytes(solKeyBytes);

              lines.push(
                "",
                "**Solana:**",
                `  Address: \`${signer.address}\``,
                `  (Derived from mnemonic below)`,
                "",
                "**Mnemonic (24 words):**",
                `\`${mnemonic}\``,
                "",
                "CRITICAL: Back up this mnemonic. It is the ONLY way to recover your Solana wallet.",
              );
            }
          }
        } catch {
          // No mnemonic - EVM-only wallet
        }

        lines.push(
          "",
          "**To restore on a new machine:**",
          "1. Set the environment variable before running OpenClaw:",
          `   \`export BLOCKRUN_WALLET_KEY=${walletKey}\``,
          "2. Or save to file:",
          `   \`mkdir -p ~/.openclaw/blockrun && echo "${walletKey}" > ~/.openclaw/blockrun/wallet.key && chmod 600 ~/.openclaw/blockrun/wallet.key\``,
        );

        if (hasMnemonic) {
          lines.push(
            "3. Restore the mnemonic for Solana:",
            `   \`echo "<your mnemonic>" > ~/.openclaw/blockrun/mnemonic && chmod 600 ~/.openclaw/blockrun/mnemonic\``,
          );
        }

        return { text: lines.join("\n") };
      }

      if (subcommand === "solana") {
        // Switch to Solana chain. If mnemonic already exists, just persist the selection.
        // If no mnemonic, set up Solana wallet first.
        try {
          let solanaAddr: string | undefined;

          // Check if Solana wallet is already set up (mnemonic exists)
          if (existsSync(MNEMONIC_FILE)) {
            const existingMnemonic = readTextFileSync(MNEMONIC_FILE).trim();
            if (existingMnemonic) {
              // Already set up — switch chain and restart proxy in-place
              await savePaymentChain("solana");
              const { deriveSolanaKeyBytes } = await import("./wallet.js");
              const solKeyBytes = deriveSolanaKeyBytes(existingMnemonic);
              const { createKeyPairSignerFromPrivateKeyBytes } = await import("@solana/kit");
              const signer = await createKeyPairSignerFromPrivateKeyBytes(solKeyBytes);
              solanaAddr = signer.address;
              if (api) restartProxyForChainSwitch(api);
              return {
                text: [
                  "✓ Payment chain switched to **Solana**.",
                  api ? "Proxy restarting in background (~2s)." : "Restart the gateway to apply.",
                  "",
                  `**Solana Address:** \`${solanaAddr}\``,
                  `**Fund with USDC on Solana:** https://solscan.io/account/${solanaAddr}`,
                ].join("\n"),
              };
            }
          }

          // No mnemonic — first-time Solana setup
          const { solanaPrivateKeyBytes } = await setupSolana();
          await savePaymentChain("solana");
          const { createKeyPairSignerFromPrivateKeyBytes } = await import("@solana/kit");
          const signer = await createKeyPairSignerFromPrivateKeyBytes(solanaPrivateKeyBytes);
          if (api) restartProxyForChainSwitch(api);
          return {
            text: [
              "**Solana Wallet Set Up**",
              "",
              `**Solana Address:** \`${signer.address}\``,
              `**Mnemonic File:** \`${MNEMONIC_FILE}\``,
              "",
              "Your existing EVM wallet is unchanged.",
              api
                ? "✓ Payment chain switched to Solana. Proxy restarting in background (~2s)."
                : "Payment chain set to Solana. Restart the gateway to apply.",
              "",
              `**Fund with USDC on Solana:** https://solscan.io/account/${signer.address}`,
            ].join("\n"),
          };
        } catch (err) {
          return {
            text: `Failed to set up Solana: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      }

      if (subcommand === "base") {
        // Switch back to Base (EVM) payment chain
        try {
          await savePaymentChain("base");
          if (api) restartProxyForChainSwitch(api);
          return {
            text: api
              ? "✓ Payment chain switched to **Base (EVM)**. Proxy restarting in background (~2s)."
              : "Payment chain set to Base (EVM). Restart the gateway to apply.",
          };
        } catch (err) {
          return {
            text: `Failed to set payment chain: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      }

      // Default: show wallet status — run all checks in parallel for speed
      const evmBalancePromise = (async () => {
        try {
          const monitor = new BalanceMonitor(address!);
          const balance = await monitor.checkBalance();
          return `Balance: ${balance.balanceUSD}`;
        } catch {
          return "Balance: (could not check)";
        }
      })();

      const solanaPromise = (async () => {
        try {
          if (!existsSync(MNEMONIC_FILE)) return "";
          const { deriveSolanaKeyBytes } = await import("./wallet.js");
          const mnemonic = readTextFileSync(MNEMONIC_FILE).trim();
          if (!mnemonic) return "";
          const solKeyBytes = deriveSolanaKeyBytes(mnemonic);
          const { createKeyPairSignerFromPrivateKeyBytes } = await import("@solana/kit");
          const signer = await createKeyPairSignerFromPrivateKeyBytes(solKeyBytes);
          const solAddr = signer.address;

          let solBalanceText = "Balance: (could not check)";
          try {
            const { SolanaBalanceMonitor } = await import("./solana-balance.js");
            const solMonitor = new SolanaBalanceMonitor(solAddr);
            const solBalance = await solMonitor.checkBalance();
            solBalanceText = `Balance: ${solBalance.balanceUSD}`;
          } catch {
            // keep default
          }

          return [
            "",
            "**Solana:**",
            `  Address: \`${solAddr}\``,
            `  ${solBalanceText}`,
            `  Fund (USDC only): https://solscan.io/account/${solAddr}`,
          ].join("\n");
        } catch {
          return "";
        }
      })();

      const chainPromise = resolvePaymentChain();

      const usagePromise = (async () => {
        try {
          const stats = await getStats(7);
          if (stats.totalRequests === 0) return "";
          const modelLines = Object.entries(stats.byModel)
            .sort((a, b) => b[1].count - a[1].count)
            .slice(0, 8)
            .map(
              ([model, data]) =>
                `  ${model.length > 30 ? model.slice(0, 27) + "..." : model}  ${data.count} reqs  $${data.cost.toFixed(4)}`,
            );
          return [
            "",
            `**Usage (${stats.period}):**`,
            `  Total: ${stats.totalRequests} requests, $${stats.totalCost.toFixed(4)} spent`,
            stats.totalSavings > 0
              ? `  Saved: $${stats.totalSavings.toFixed(4)} (${stats.savingsPercentage.toFixed(0)}% vs Opus baseline)`
              : "",
            "",
            "**Top Models:**",
            ...modelLines,
          ]
            .filter(Boolean)
            .join("\n");
        } catch {
          return "";
        }
      })();

      const [evmBalanceText, solanaSection, currentChain, usageSection] = await Promise.all([
        evmBalancePromise,
        solanaPromise,
        chainPromise,
        usagePromise,
      ]);

      return {
        text: [
          "**XClawRouter Wallet**",
          "",
          `**Payment Chain:** ${currentChain === "solana" ? "Solana" : "Base (EVM)"}`,
          "",
          "**Base (EVM):**",
          `  Address: \`${address}\``,
          `  ${evmBalanceText}`,
          `  Fund (USDC only): https://basescan.org/address/${address}`,
          solanaSection,
          usageSection,
          "",
          `**Key File:** \`${WALLET_FILE}\``,
          "",
          "**Commands:**",
          "• `/wallet` - Show this status",
          "• `/wallet export` - Export private key for backup",
          "• `/stats` - Detailed usage breakdown",
          !solanaSection ? "• `/wallet solana` - Enable Solana payments" : "",
          solanaSection ? "• `/wallet base` - Switch to Base (EVM)" : "",
          solanaSection ? "• `/wallet solana` - Switch to Solana" : "",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    },
  };
}

const plugin: OpenClawPluginDefinition = {
  id: "clawrouter",
  name: "XClawRouter",
  description: "Smart LLM router — 55+ models, x402 micropayments, 78% cost savings",
  version: VERSION,

  register(api: OpenClawPluginApi) {
    // Check if XClawRouter is disabled via environment variable
    // Usage: CLAWROUTER_DISABLED=true openclaw gateway start
    const isDisabled =
      process["env"].CLAWROUTER_DISABLED === "true" || process["env"].CLAWROUTER_DISABLED === "1";
    if (isDisabled) {
      api.logger.info("XClawRouter disabled (CLAWROUTER_DISABLED=true). Using default routing.");
      return;
    }

    // Install skills into OpenClaw workspace so agents can discover them
    // Must run before completion short-circuit so skills are available even on first install
    installSkillsToWorkspace(api.logger);

    // Guard against repeated proxy startup within the same process.
    // OpenClaw calls register() multiple times (discovery, activation, per-session)
    // AND may load duplicate plugin instances from stale install-stage directories.
    // Provider/command/tool registration is idempotent — safe to repeat so the
    // LAST loaded plugin (the correct one) wins.  Only proxy startup must be guarded
    // to avoid EADDRINUSE.
    const proc = process as ProcessWithClawRouterState;
    const proxyAlreadyStarted = !!proc.__clawrouterProxyStarted;

    // Skip heavy initialization in completion mode — only completion script is needed
    // Logging to stdout during completion pollutes the script and causes zsh errors
    if (isCompletionMode()) {
      api.registerProvider(blockrunProvider);
      return;
    }

    // Register BlockRun as a provider (sync — available immediately)
    api.registerProvider(blockrunProvider);

    // Register native image and music generation providers so BlockRun models
    // appear in OpenClaw's /imagine and music generation UIs.
    api.registerImageGenerationProvider(buildImageGenerationProvider());
    api.registerMusicGenerationProvider(buildMusicGenerationProvider());
    if (typeof api.registerVideoGenerationProvider === "function") {
      api.registerVideoGenerationProvider(buildVideoGenerationProvider());
    } else {
      api.logger.warn(
        "OpenClaw runtime does not expose registerVideoGenerationProvider(); BlockRun video models unavailable on this version.",
      );
    }
    if (typeof api.registerWebSearchProvider === "function") {
      api.registerWebSearchProvider(blockrunExaWebSearchProvider);
    } else {
      api.logger.warn(
        "OpenClaw runtime does not expose registerWebSearchProvider(); blockrun-exa search is unavailable on this version.",
      );
    }

    // Inject models config into OpenClaw config file
    // This persists the config so models are recognized on restart
    injectModelsConfig(api.logger);

    // Inject dummy auth profiles into agent auth stores
    // OpenClaw's agent system looks for auth even if provider has auth: []
    injectAuthProfile(api.logger);

    // Also set runtime config for immediate availability
    const runtimePort = getProxyPort();
    if (!api.config.models) {
      api.config.models = { providers: {} };
    }
    if (!api.config.models.providers) {
      api.config.models.providers = {};
    }
    api.config.models.providers.blockrun = {
      baseUrl: `http://127.0.0.1:${runtimePort}/v1`,
      api: "openai-completions",
      // apiKey is required by pi-coding-agent's ModelRegistry for providers with models.
      apiKey: "x402-proxy-handles-auth",
      models: OPENCLAW_MODELS,
    };
    if (!api.config.tools) {
      api.config.tools = {};
    }
    if (!api.config.tools.web) {
      api.config.tools.web = {};
    }
    if (!api.config.tools.web.search) {
      api.config.tools.web.search = {};
    }
    api.config.tools.web.search.provider = BLOCKRUN_EXA_PROVIDER_ID;
    api.config.tools.web.search.enabled = true;
    const runtimeMcpRemoved = removeManagedBlockrunMcpServerConfig(api.config);

    // Only log provider/tool registration on the first register() call.
    // OpenClaw calls register() 4+ times per gateway startup; logging every
    // time produces 24+ identical lines that obscure useful output.
    // Registration itself is idempotent (last wins), so always runs — just
    // the log is suppressed on repeat calls.
    const shouldLogRegistration = !proc.__clawrouterRegistrationLogged;
    proc.__clawrouterRegistrationLogged = true;

    if (shouldLogRegistration) {
      api.logger.info("BlockRun provider registered (55+ models via x402)");
      if (typeof api.registerWebSearchProvider === "function") {
        api.logger.info(`Registered BlockRun web_search provider (${BLOCKRUN_EXA_PROVIDER_ID})`);
      }
      if (runtimeMcpRemoved) {
        api.logger.info(
          `Removed bundled BlockRun MCP server config (${BLOCKRUN_MCP_SERVER_NAME}) — restart the gateway to free any leaked processes`,
        );
      }
    }

    // Register partner API tools (Twitter/X lookup, etc.)
    try {
      const proxyBaseUrl = `http://127.0.0.1:${runtimePort}`;
      const partnerTools = buildPartnerTools(proxyBaseUrl);
      for (const tool of partnerTools) {
        api.registerTool(tool);
      }
      if (partnerTools.length > 0 && shouldLogRegistration) {
        api.logger.info(
          `Registered ${partnerTools.length} partner tool(s): ${partnerTools.map((t) => t.name).join(", ")}`,
        );
      }
    } catch (err) {
      api.logger.warn(
        `Failed to register partner tools: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Register commands
    api.registerCommand({
      name: "partners",
      description: "List available partner APIs and pricing",
      acceptsArgs: false,
      requireAuth: false,
      handler: async () => {
        if (PARTNER_SERVICES.length === 0) {
          return { text: "No partner APIs available." };
        }

        const lines = ["**Partner APIs** (paid via your XClawRouter wallet)", ""];

        for (const svc of PARTNER_SERVICES) {
          lines.push(`**${svc.name}** (${svc.partner})`);
          lines.push(`  ${svc.description}`);
          lines.push(`  Tool: \`${`blockrun_${svc.id}`}\``);
          lines.push(
            `  Pricing: ${svc.pricing.perUnit} per ${svc.pricing.unit} (min ${svc.pricing.minimum}, max ${svc.pricing.maximum})`,
          );
          lines.push(
            `  **How to use:** Ask "Look up Twitter user @elonmusk" or "Get info on these X accounts: @naval, @balajis"`,
          );
          lines.push("");
        }

        return { text: lines.join("\n") };
      },
    });

    // Register commands synchronously so OpenClaw sees them during the register() call.
    // These factories are plain functions (no top-level await) — marking them async
    // caused .then() callbacks to fire after register() returned, making OpenClaw miss them.
    // Primary: /wallet (original name, lobster.cash removed by update script)
    api.registerCommand(createWalletCommand(api));
    // Alias: /blockrun (guaranteed unique fallback)
    try {
      const blockrunAlias = createWalletCommand(api);
      blockrunAlias.name = "blockrun";
      api.registerCommand(blockrunAlias);
    } catch {
      // Silently ignored if "blockrun" is already claimed
    }
    api.registerCommand(createStatsCommand());
    api.registerCommand(createExcludeCommand());
    if (shouldLogRegistration) {
      api.logger.info("Commands registered: /wallet, /blockrun, /stats, /exclude");
    }

    // Register a service with stop() for cleanup on gateway shutdown
    // This prevents EADDRINUSE when the gateway restarts
    api.registerService({
      id: "clawrouter-proxy",
      start: () => {
        // No-op: proxy is started below in non-blocking mode
      },
      stop: async () => {
        // Close proxy on gateway shutdown to release port 8402
        if (activeProxyHandle) {
          try {
            await activeProxyHandle.close();
            api.logger.info("BlockRun proxy closed");
          } catch (err) {
            api.logger.warn(
              `Failed to close proxy: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          activeProxyHandle = null;
        }
        resetProxyStartupState();
      },
    });

    // Skip proxy startup unless we're in gateway mode
    // The proxy keeps the Node.js event loop alive, preventing CLI commands from exiting
    // The proxy will start automatically when the gateway runs
    if (!isGatewayMode()) {
      if (shouldLogRegistration) {
        // Generate wallet on first install (even outside gateway mode)
        // This ensures users can see their wallet address immediately after install
        resolveOrGenerateWalletKey()
          .then(({ address, source, email }) => {
            if (source === "okx") {
              api.logger.info(
                `Using OKX onchainos wallet: ${address}${email ? ` (${email})` : ""}`,
              );
            } else if (source === "generated") {
              api.logger.warn(`════════════════════════════════════════════════`);
              api.logger.warn(`  NEW WALLET GENERATED — BACK UP YOUR KEY NOW!`);
              api.logger.warn(`  Address : ${address}`);
              api.logger.warn(`  Run /wallet export to get your private key`);
              api.logger.warn(`  Losing this key = losing your USDC funds`);
              api.logger.warn(`  Or install OKX onchainos to use your OKX wallet:`);
              api.logger.warn(`     https://web3.okx.com/onchainos`);
              api.logger.warn(`════════════════════════════════════════════════`);
            } else if (source === "saved") {
              api.logger.info(`Using saved wallet: ${address}`);
            } else if (source === "config") {
              api.logger.info(`Using wallet from plugin config: ${address}`);
            } else {
              api.logger.info(`Using wallet from BLOCKRUN_WALLET_KEY: ${address}`);
            }
          })
          .catch((err) => {
            api.logger.warn(
              `Failed to initialize wallet: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        api.logger.info("Not in gateway mode — proxy will start when gateway runs");
      }
      return;
    }

    // Start x402 proxy in background WITHOUT blocking register()
    // CRITICAL: Do NOT await here - this was blocking model selection UI for 3+ seconds
    // causing Chandler's "infinite loop" issue where model selection never finishes
    // Note: startProxyInBackground calls resolveOrGenerateWalletKey internally
    //
    // Guard: only start proxy once per process. When OpenClaw loads duplicate plugin
    // instances (stale install-stage dirs), each calls register() — provider/command
    // registration above is idempotent, but proxy startup must happen exactly once.
    //
    // Defer startup to handle multi-phase register() (#147): OpenClaw calls
    // register() twice during gateway startup. The first call happens before
    // openclaw.json has been parsed, so api.pluginConfig is empty. If we start
    // the proxy synchronously on that first call, the second call (which has
    // the user's routing config) gets blocked by the proxyAlreadyStarted guard
    // and the user's custom routing/wallet config is silently ignored.
    //
    // Strategy: when pluginConfig is empty, mark this register() call as a
    // pending "deferred start". A short timer schedules the actual startup.
    // If a second register() call arrives BEFORE the timer fires (the normal
    // case — OpenClaw calls them back-to-back), it cancels the deferred start
    // and starts the proxy immediately with the now-populated pluginConfig.
    // If only ever one call happens (rare — user with no plugin config and
    // single-phase gateway), the timer fires and starts the proxy with empty
    // config (defaults) so we don't deadlock.
    const pluginConfigEmpty =
      !api.pluginConfig ||
      typeof api.pluginConfig !== "object" ||
      Object.keys(api.pluginConfig).length === 0;

    // If we have a pending deferred start from a prior call, cancel it — this
    // call (with potentially populated pluginConfig) takes over.
    if (clearDeferredProxyStartTimer(proc)) {
      api.logger.info("Superseding earlier deferred proxy start — using current pluginConfig");
    }

    if (proxyAlreadyStarted) {
      if (!pluginConfigEmpty && proc.__clawrouterStartedWithEmptyConfig) {
        api.logger.info(
          "Populated pluginConfig arrived after provisional default startup — switching proxy to current config",
        );
        supersedeEmptyConfigStartup(api);
      } else if (shouldLogRegistration) {
        api.logger.info("Proxy already started by earlier register() call — skipping");
      }
      return;
    }

    if (pluginConfigEmpty) {
      // Defer 250ms so OpenClaw's second register() call (with populated
      // pluginConfig) has a chance to supersede this one.
      if (shouldLogRegistration) {
        api.logger.info(
          "pluginConfig empty — deferring proxy startup 250ms in case a populated config arrives",
        );
      }
      proc.__clawrouterDeferredStartTimer = setTimeout(() => {
        proc.__clawrouterDeferredStartTimer = undefined;
        if (proc.__clawrouterProxyStarted) return;
        const startupGeneration = beginProxyStartupAttempt(proc, true);
        api.logger.info("Deferred timer fired — starting proxy with default config");
        startProxyAfterPortProbe(api, startupGeneration);
      }, 250);
      return;
    }

    if (pendingConfiguredStartupApi) {
      pendingConfiguredStartupApi = null;
      api.logger.info("Discarding older queued populated pluginConfig — using newest config");
    }

    const startupGeneration = beginProxyStartupAttempt(proc, false);
    startProxyAfterPortProbe(api, startupGeneration);
  },

  /**
   * Cleanup hook called when plugin is uninstalled via `openclaw plugins uninstall`.
   * Removes blockrun provider config, plugin entries, model allowlist entries,
   * and auth profiles from openclaw.json so no residual config causes errors.
   */
  deactivate(api: OpenClawPluginApi) {
    // 1. Stop proxy
    if (activeProxyHandle) {
      activeProxyHandle.close().catch(() => {});
      activeProxyHandle = null;
    }
    resetProxyStartupState();

    // 2. Clean openclaw.json — remove provider, plugin entries, model allowlist
    try {
      const configPath = join(homedir(), ".openclaw", "openclaw.json");
      if (existsSync(configPath)) {
        const config = JSON.parse(readTextFileSync(configPath));

        // Remove blockrun provider
        if (config.models?.providers?.blockrun) {
          delete config.models.providers.blockrun;
        }

        // Remove managed BlockRun MCP server config, but preserve any user-managed override.
        removeManagedBlockrunMcpServerConfig(config as OpenClawConfig);

        // Remove plugin entries (all case variants)
        for (const key of ["clawrouter", "XClawRouter", "@blockrun/xclawrouter"]) {
          if (config.plugins?.entries?.[key]) delete config.plugins.entries[key];
          if (config.plugins?.installs?.[key]) delete config.plugins.installs[key];
        }

        // Remove from plugins.allow
        if (Array.isArray(config.plugins?.allow)) {
          config.plugins.allow = config.plugins.allow.filter(
            (p: string) =>
              p !== "clawrouter" && p !== "XClawRouter" && p !== "@blockrun/xclawrouter",
          );
        }

        // Remove blockrun models from allowlist
        if (config.agents?.defaults?.models) {
          for (const key of Object.keys(config.agents.defaults.models)) {
            if (key.startsWith("blockrun/")) delete config.agents.defaults.models[key];
          }
        }

        // Reset default model if it's blockrun
        if (config.agents?.defaults?.model?.primary?.startsWith("blockrun/")) {
          delete config.agents.defaults.model.primary;
        }

        if (config.tools?.web?.search?.provider === BLOCKRUN_EXA_PROVIDER_ID) {
          delete config.tools.web.search.provider;
        }

        // Atomic write
        const tmpPath = `${configPath}.tmp.${process.pid}`;
        writeFileSync(tmpPath, JSON.stringify(config, null, 2));
        renameSync(tmpPath, configPath);
        api.logger.info("XClawRouter config cleaned up");
      }
    } catch (err) {
      api.logger.warn(`Config cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 3. Clean auth profiles
    try {
      const agentsDir = join(homedir(), ".openclaw", "agents");
      if (existsSync(agentsDir)) {
        for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const authPath = join(agentsDir, entry.name, "agent", "auth-profiles.json");
          if (!existsSync(authPath)) continue;
          try {
            const store = JSON.parse(readTextFileSync(authPath));
            if (store.profiles?.["blockrun:default"]) {
              delete store.profiles["blockrun:default"];
              writeFileSync(authPath, JSON.stringify(store, null, 2));
            }
          } catch {
            // Skip corrupt auth files
          }
        }
      }
    } catch {
      // Best-effort cleanup
    }

    api.logger.info("XClawRouter deactivated — restart gateway to complete uninstall");
  },
};

export default plugin;

// Re-export for programmatic use
export { startProxy, getProxyPort } from "./proxy.js";
export type {
  ProxyOptions,
  ProxyHandle,
  WalletConfig,
  PaymentChain,
  LowBalanceInfo,
  InsufficientFundsInfo,
} from "./proxy.js";
export type { WalletResolution } from "./auth.js";
export { blockrunProvider } from "./provider.js";
export {
  OPENCLAW_MODELS,
  BLOCKRUN_MODELS,
  buildProviderModels,
  MODEL_ALIASES,
  resolveModelAlias,
  isAgenticModel,
  getAgenticModels,
  getModelContextWindow,
} from "./models.js";
export {
  route,
  DEFAULT_ROUTING_CONFIG,
  getFallbackChain,
  getFallbackChainFiltered,
  calculateModelCost,
} from "./router/index.js";
export type { RoutingDecision, RoutingConfig, Tier } from "./router/index.js";
export { logUsage } from "./logger.js";
export type { UsageEntry } from "./logger.js";
export { RequestDeduplicator } from "./dedup.js";
export type { CachedResponse } from "./dedup.js";
export { BalanceMonitor, BALANCE_THRESHOLDS } from "./balance.js";
export type { BalanceInfo, SufficiencyResult } from "./balance.js";
export { SolanaBalanceMonitor } from "./solana-balance.js";
export type { SolanaBalanceInfo } from "./solana-balance.js";
export {
  SpendControl,
  FileSpendControlStorage,
  InMemorySpendControlStorage,
  formatDuration,
} from "./spend-control.js";
export type {
  SpendWindow,
  SpendLimits,
  SpendRecord,
  SpendingStatus,
  CheckResult,
  SpendControlStorage,
  SpendControlOptions,
} from "./spend-control.js";
export {
  generateWalletMnemonic,
  isValidMnemonic,
  deriveEvmKey,
  deriveSolanaKeyBytes,
  deriveAllKeys,
} from "./wallet.js";
export type { DerivedKeys } from "./wallet.js";
export { setupSolana, savePaymentChain, loadPaymentChain, resolvePaymentChain } from "./auth.js";
export {
  InsufficientFundsError,
  EmptyWalletError,
  RpcError,
  isInsufficientFundsError,
  isEmptyWalletError,
  isBalanceError,
  isRpcError,
} from "./errors.js";
export { fetchWithRetry, isRetryable, DEFAULT_RETRY_CONFIG } from "./retry.js";
export type { RetryConfig } from "./retry.js";
export { getStats, formatStatsAscii, clearStats } from "./stats.js";
export type { DailyStats, AggregatedStats } from "./stats.js";
export {
  SessionStore,
  getSessionId,
  hashRequestContent,
  DEFAULT_SESSION_CONFIG,
} from "./session.js";
export type { SessionEntry, SessionConfig } from "./session.js";
export { ResponseCache } from "./response-cache.js";
export type { CachedLLMResponse, ResponseCacheConfig } from "./response-cache.js";
export { PARTNER_SERVICES, getPartnerService, buildPartnerTools } from "./partners/index.js";
export type { PartnerServiceDefinition, PartnerToolDefinition } from "./partners/index.js";
