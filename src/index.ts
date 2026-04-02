/**
 * @blockrun/clawrouter
 *
 * Smart LLM router for OpenClaw — 55+ models, x402 micropayments, 78% cost savings.
 * Routes each request to the cheapest model that can handle it.
 *
 * Usage:
 *   # Install the plugin
 *   openclaw plugins install @blockrun/clawrouter
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
  PluginCommandContext,
  OpenClawPluginCommandDefinition,
} from "./types.js";
import { blockrunProvider, setActiveProxy } from "./provider.js";
import { startProxy, getProxyPort } from "./proxy.js";
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
import {
  loadExcludeList,
  addExclusion,
  removeExclusion,
  clearExclusions,
} from "./exclude-models.js";

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
import { readTextFileSync } from "./fs-read.js";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "./version.js";
import { privateKeyToAccount } from "viem/accounts";
import { getStats, formatStatsAscii, clearStats } from "./stats.js";
import { buildPartnerTools, PARTNER_SERVICES } from "./partners/index.js";

/**
 * Install ClawRouter skills into OpenClaw's workspace skills directory.
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
    const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
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
    // Skip internal-only skills (release is for ClawRouter maintainers, not end users)
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
 */
function injectModelsConfig(logger: { info: (msg: string) => void }): void {
  const configDir = join(homedir(), ".openclaw");
  const configPath = join(configDir, "openclaw.json");

  let config: Record<string, unknown> = {};
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

/**
 * Start the x402 proxy in the background.
 * Called from register() because OpenClaw's loader only invokes register(),
 * treating activate() as an alias (def.register ?? def.activate).
 */
async function startProxyInBackground(api: OpenClawPluginApi): Promise<void> {
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
  if (wallet.source === "generated") {
    api.logger.warn(`════════════════════════════════════════════════`);
    api.logger.warn(`  NEW WALLET GENERATED — BACK UP YOUR KEY NOW!`);
    api.logger.warn(`  Address : ${wallet.address}`);
    api.logger.warn(`  Run /wallet export to get your private key`);
    api.logger.warn(`  Losing this key = losing your USDC funds`);
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

  setActiveProxy(proxy);
  activeProxyHandle = proxy;

  const startupExclusions = loadExcludeList();
  if (startupExclusions.size > 0) {
    api.logger.info(
      `Model exclusions active (${startupExclusions.size}): ${[...startupExclusions].join(", ")}`,
    );
  }

  api.logger.info(`ClawRouter ready — smart routing enabled`);
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
}

/**
 * /stats command handler for ClawRouter.
 * Shows usage statistics and cost savings.
 */
async function createStatsCommand(): Promise<OpenClawPluginCommandDefinition> {
  return {
    name: "stats",
    description: "Show ClawRouter usage statistics and cost savings",
    acceptsArgs: true,
    requireAuth: false,
    handler: async (ctx: PluginCommandContext) => {
      const arg = ctx.args?.trim().toLowerCase() || "7";

      if (arg === "clear" || arg === "reset") {
        try {
          const { deletedFiles } = await clearStats();
          return {
            text: `Stats cleared — ${deletedFiles} log file(s) deleted. Fresh start!`,
          };
        } catch (err) {
          return {
            text: `Failed to clear stats: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      }

      const days = parseInt(arg, 10) || 7;

      try {
        const stats = await getStats(Math.min(days, 30)); // Cap at 30 days
        const ascii = formatStatsAscii(stats);

        return {
          text: ["```", ascii, "```"].join("\n"),
        };
      } catch (err) {
        return {
          text: `Failed to load stats: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}

/**
 * /exclude command handler for ClawRouter.
 * Manages excluded models — /exclude add|remove|clear <model>
 */
async function createExcludeCommand(): Promise<OpenClawPluginCommandDefinition> {
  return {
    name: "exclude",
    description: "Manage excluded models — /exclude add|remove|clear <model>",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: PluginCommandContext) => {
      const args = ctx.args?.trim() || "";
      const parts = args.split(/\s+/);
      const subcommand = parts[0]?.toLowerCase() || "";
      const modelArg = parts.slice(1).join(" ").trim();

      // /exclude (no args) — show current list
      if (!subcommand) {
        const list = loadExcludeList();
        if (list.size === 0) {
          return {
            text: "No models excluded.\n\nUsage:\n  /exclude add <model>  — block a model\n  /exclude remove <model> — unblock\n  /exclude clear — remove all",
          };
        }
        const models = [...list]
          .sort()
          .map((m) => `  • ${m}`)
          .join("\n");
        return {
          text: `Excluded models (${list.size}):\n${models}\n\nUse /exclude remove <model> to unblock.`,
        };
      }

      // /exclude add <model>
      if (subcommand === "add") {
        if (!modelArg) {
          return {
            text: "Usage: /exclude add <model>\nExample: /exclude add nvidia/gpt-oss-120b",
            isError: true,
          };
        }
        const resolved = addExclusion(modelArg);
        const list = loadExcludeList();
        return {
          text: `Excluded: ${resolved}\n\nActive exclusions (${list.size}):\n${[...list]
            .sort()
            .map((m) => `  • ${m}`)
            .join("\n")}`,
        };
      }

      // /exclude remove <model>
      if (subcommand === "remove") {
        if (!modelArg) {
          return { text: "Usage: /exclude remove <model>", isError: true };
        }
        const removed = removeExclusion(modelArg);
        if (!removed) {
          return { text: `Model "${modelArg}" was not in the exclude list.` };
        }
        const list = loadExcludeList();
        return {
          text: `Unblocked: ${modelArg}\n\nActive exclusions (${list.size}):\n${
            list.size > 0
              ? [...list]
                  .sort()
                  .map((m) => `  • ${m}`)
                  .join("\n")
              : "  (none)"
          }`,
        };
      }

      // /exclude clear
      if (subcommand === "clear") {
        clearExclusions();
        return { text: "All model exclusions cleared." };
      }

      return {
        text: `Unknown subcommand: ${subcommand}\n\nUsage:\n  /exclude — show list\n  /exclude add <model>\n  /exclude remove <model>\n  /exclude clear`,
        isError: true,
      };
    },
  };
}

/**
 * /wallet command handler for ClawRouter.
 * - /wallet or /wallet status: Show wallet address, balance, usage, and key file location
 * - /wallet export: Show private key for backup (with security warning)
 */
async function createWalletCommand(): Promise<OpenClawPluginCommandDefinition> {
  return {
    name: "wallet",
    description: "Show BlockRun wallet info, usage stats, or export private key",
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
          text: `No ClawRouter wallet found.\n\nRun \`openclaw plugins install @blockrun/clawrouter\` to generate a wallet.`,
          isError: true,
        };
      }

      if (subcommand === "export") {
        // Export private key + mnemonic for backup
        const lines = [
          "**ClawRouter Wallet Export**",
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
              // Already set up — just switch chain
              await savePaymentChain("solana");
              const { deriveSolanaKeyBytes } = await import("./wallet.js");
              const solKeyBytes = deriveSolanaKeyBytes(existingMnemonic);
              const { createKeyPairSignerFromPrivateKeyBytes } = await import("@solana/kit");
              const signer = await createKeyPairSignerFromPrivateKeyBytes(solKeyBytes);
              solanaAddr = signer.address;
              return {
                text: [
                  "Payment chain set to Solana. Restart the gateway to apply.",
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
          return {
            text: [
              "**Solana Wallet Set Up**",
              "",
              `**Solana Address:** \`${signer.address}\``,
              `**Mnemonic File:** \`${MNEMONIC_FILE}\``,
              "",
              "Your existing EVM wallet is unchanged.",
              "Payment chain set to Solana. Restart the gateway to apply.",
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
          return {
            text: "Payment chain set to Base (EVM). Restart the gateway to apply.",
          };
        } catch (err) {
          return {
            text: `Failed to set payment chain: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      }

      // Default: show wallet status
      let evmBalanceText: string;
      try {
        const monitor = new BalanceMonitor(address);
        const balance = await monitor.checkBalance();
        evmBalanceText = `Balance: ${balance.balanceUSD}`;
      } catch {
        evmBalanceText = "Balance: (could not check)";
      }

      // Check for Solana wallet
      let solanaSection = "";
      try {
        if (existsSync(MNEMONIC_FILE)) {
          const { deriveSolanaKeyBytes } = await import("./wallet.js");
          const mnemonic = readTextFileSync(MNEMONIC_FILE).trim();
          if (mnemonic) {
            const solKeyBytes = deriveSolanaKeyBytes(mnemonic);
            const { createKeyPairSignerFromPrivateKeyBytes } = await import("@solana/kit");
            const signer = await createKeyPairSignerFromPrivateKeyBytes(solKeyBytes);
            const solAddr = signer.address;

            let solBalanceText = "Balance: (checking...)";
            try {
              const { SolanaBalanceMonitor } = await import("./solana-balance.js");
              const solMonitor = new SolanaBalanceMonitor(solAddr);
              const solBalance = await solMonitor.checkBalance();
              solBalanceText = `Balance: ${solBalance.balanceUSD}`;
            } catch {
              solBalanceText = "Balance: (could not check)";
            }

            solanaSection = [
              "",
              "**Solana:**",
              `  Address: \`${solAddr}\``,
              `  ${solBalanceText}`,
              `  Fund (USDC only): https://solscan.io/account/${solAddr}`,
            ].join("\n");
          }
        }
      } catch {
        // No Solana wallet - that's fine
      }

      // Show current chain selection
      const currentChain = await resolvePaymentChain();

      // Usage summary (last 7 days) — shows all models including openai/, anthropic/, etc.
      let usageSection = "";
      try {
        const stats = await getStats(7);
        if (stats.totalRequests > 0) {
          const modelLines = Object.entries(stats.byModel)
            .sort((a, b) => b[1].count - a[1].count)
            .slice(0, 8)
            .map(
              ([model, data]) =>
                `  ${model.length > 30 ? model.slice(0, 27) + "..." : model}  ${data.count} reqs  $${data.cost.toFixed(4)}`,
            );

          usageSection = [
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
        }
      } catch {
        // Stats not available — skip
      }

      return {
        text: [
          "**ClawRouter Wallet**",
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
  name: "ClawRouter",
  description: "Smart LLM router — 55+ models, x402 micropayments, 78% cost savings",
  version: VERSION,

  register(api: OpenClawPluginApi) {
    // Check if ClawRouter is disabled via environment variable
    // Usage: CLAWROUTER_DISABLED=true openclaw gateway start
    const isDisabled =
      process["env"].CLAWROUTER_DISABLED === "true" || process["env"].CLAWROUTER_DISABLED === "1";
    if (isDisabled) {
      api.logger.info("ClawRouter disabled (CLAWROUTER_DISABLED=true). Using default routing.");
      return;
    }

    // Install skills into OpenClaw workspace so agents can discover them
    // Must run before completion short-circuit so skills are available even on first install
    installSkillsToWorkspace(api.logger);

    // Skip heavy initialization in completion mode — only completion script is needed
    // Logging to stdout during completion pollutes the script and causes zsh errors
    if (isCompletionMode()) {
      api.registerProvider(blockrunProvider);
      return;
    }

    // Register BlockRun as a provider (sync — available immediately)
    api.registerProvider(blockrunProvider);

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

    api.logger.info("BlockRun provider registered (55+ models via x402)");

    // Register partner API tools (Twitter/X lookup, etc.)
    try {
      const proxyBaseUrl = `http://127.0.0.1:${runtimePort}`;
      const partnerTools = buildPartnerTools(proxyBaseUrl);
      for (const tool of partnerTools) {
        api.registerTool(tool);
      }
      if (partnerTools.length > 0) {
        api.logger.info(
          `Registered ${partnerTools.length} partner tool(s): ${partnerTools.map((t) => t.name).join(", ")}`,
        );
      }

      // Register /partners command
      api.registerCommand({
        name: "partners",
        description: "List available partner APIs and pricing",
        acceptsArgs: false,
        requireAuth: false,
        handler: async () => {
          if (PARTNER_SERVICES.length === 0) {
            return { text: "No partner APIs available." };
          }

          const lines = ["**Partner APIs** (paid via your ClawRouter wallet)", ""];

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
    } catch (err) {
      api.logger.warn(
        `Failed to register partner tools: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Register /wallet command — shows wallet info + per-model usage stats
    createWalletCommand()
      .then((walletCommand) => {
        api.registerCommand(walletCommand);
      })
      .catch((err) => {
        api.logger.warn(
          `Failed to register /wallet command: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

    // Register /stats command for usage statistics
    createStatsCommand()
      .then((statsCommand) => {
        api.registerCommand(statsCommand);
      })
      .catch((err) => {
        api.logger.warn(
          `Failed to register /stats command: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

    // Register /exclude command for model exclusion management
    createExcludeCommand()
      .then((excludeCommand) => {
        api.registerCommand(excludeCommand);
      })
      .catch((err) => {
        api.logger.warn(
          `Failed to register /exclude command: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

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
      },
    });

    // Skip proxy startup unless we're in gateway mode
    // The proxy keeps the Node.js event loop alive, preventing CLI commands from exiting
    // The proxy will start automatically when the gateway runs
    if (!isGatewayMode()) {
      // Generate wallet on first install (even outside gateway mode)
      // This ensures users can see their wallet address immediately after install
      resolveOrGenerateWalletKey()
        .then(({ address, source }) => {
          if (source === "generated") {
            api.logger.warn(`════════════════════════════════════════════════`);
            api.logger.warn(`  NEW WALLET GENERATED — BACK UP YOUR KEY NOW!`);
            api.logger.warn(`  Address : ${address}`);
            api.logger.warn(`  Run /wallet export to get your private key`);
            api.logger.warn(`  Losing this key = losing your USDC funds`);
            api.logger.warn(`════════════════════════════════════════════════`);
          } else if (source === "saved") {
            api.logger.info(`Using saved wallet: ${address}`);
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
      return;
    }

    // Start x402 proxy in background WITHOUT blocking register()
    // CRITICAL: Do NOT await here - this was blocking model selection UI for 3+ seconds
    // causing Chandler's "infinite loop" issue where model selection never finishes
    // Note: startProxyInBackground calls resolveOrGenerateWalletKey internally
    startProxyInBackground(api)
      .then(async () => {
        // Proxy started successfully - verify health
        const port = getProxyPort();
        const healthy = await waitForProxyHealth(port, 5000);
        if (!healthy) {
          api.logger.warn(`Proxy health check timed out, commands may not work immediately`);
        }
      })
      .catch((err) => {
        api.logger.error(
          `Failed to start BlockRun proxy: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
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
