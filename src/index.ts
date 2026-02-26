/**
 * @blockrun/clawrouter
 *
 * Smart LLM router for OpenClaw — 30+ models, x402 micropayments, 78% cost savings.
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
 *   openclaw models set openai/gpt-5.2
 */

import type {
  OpenClawPluginDefinition,
  OpenClawPluginApi,
  PluginCommandContext,
  OpenClawPluginCommandDefinition,
} from "./types.js";
import { blockrunProvider, setActiveProxy } from "./provider.js";
import { startProxy, getProxyPort } from "./proxy.js";
import { resolveOrGenerateWalletKey, setupSolana, WALLET_FILE, MNEMONIC_FILE } from "./auth.js";
import type { RoutingConfig } from "./router/index.js";
import { BalanceMonitor } from "./balance.js";

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
import { join } from "node:path";
import { VERSION } from "./version.js";
import { privateKeyToAccount } from "viem/accounts";
import { getStats, formatStatsAscii } from "./stats.js";

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
  if (!defaults.model) {
    defaults.model = {};
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

  // Add key model aliases to allowlist for /model picker visibility
  // Only add essential aliases, not all 50+ models to avoid config pollution
  const KEY_MODEL_ALIASES = [
    { id: "auto", alias: "auto" },
    { id: "eco", alias: "eco" },
    { id: "premium", alias: "premium" },
    { id: "free", alias: "free" },
    { id: "sonnet", alias: "sonnet-4.6" },
    { id: "opus", alias: "opus" },
    { id: "haiku", alias: "haiku" },
    { id: "gpt5", alias: "gpt5" },
    { id: "codex", alias: "codex" },
    { id: "grok-fast", alias: "grok-fast" },
    { id: "grok-code", alias: "grok-code" },
    { id: "deepseek", alias: "deepseek" },
    { id: "reasoner", alias: "reasoner" },
    { id: "kimi", alias: "kimi" },
    { id: "minimax", alias: "minimax" },
    { id: "gemini", alias: "gemini" },
  ];

  // Deprecated aliases to remove from config (cleaned up from picker)
  const DEPRECATED_ALIASES = [
    "blockrun/nvidia",
    "blockrun/gpt",
    "blockrun/o3",
    "blockrun/grok",
    "blockrun/mini",
    "blockrun/flash", // removed from picker - use gemini instead
  ];

  if (!defaults.models) {
    defaults.models = {};
    needsWrite = true;
  }

  const allowlist = defaults.models as Record<string, unknown>;

  // Remove deprecated aliases from config
  for (const deprecated of DEPRECATED_ALIASES) {
    if (allowlist[deprecated]) {
      delete allowlist[deprecated];
      logger.info(`Removed deprecated model alias: ${deprecated}`);
      needsWrite = true;
    }
  }

  // Add current aliases (and update stale aliases)
  for (const m of KEY_MODEL_ALIASES) {
    const fullId = `blockrun/${m.id}`;
    const existing = allowlist[fullId] as Record<string, unknown> | undefined;
    if (!existing) {
      allowlist[fullId] = { alias: m.alias };
      needsWrite = true;
    } else if (existing.alias !== m.alias) {
      existing.alias = m.alias;
      needsWrite = true;
    }
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
  // Resolve wallet key: saved file → env var → auto-generate
  const wallet = await resolveOrGenerateWalletKey();

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
  } else {
    api.logger.info(`Using wallet from BLOCKRUN_WALLET_KEY: ${wallet.address}`);
  }

  // Resolve routing config overrides from plugin config
  const routingConfig = api.pluginConfig?.routing as Partial<RoutingConfig> | undefined;

  const proxy = await startProxy({
    wallet,
    routingConfig,
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

  api.logger.info(`ClawRouter ready — smart routing enabled`);
  api.logger.info(`Pricing: Simple ~$0.001 | Code ~$0.01 | Complex ~$0.05 | Free: $0`);

  // Non-blocking balance check AFTER proxy is ready (won't hang startup)
  const startupMonitor = new BalanceMonitor(wallet.address);
  startupMonitor
    .checkBalance()
    .then((balance) => {
      if (balance.isEmpty) {
        api.logger.info(`Wallet: ${wallet.address} | Balance: $0.00`);
        api.logger.info(`Using FREE model. Fund wallet for premium models.`);
      } else if (balance.isLow) {
        api.logger.info(`Wallet: ${wallet.address} | Balance: ${balance.balanceUSD} (low)`);
      } else {
        api.logger.info(`Wallet: ${wallet.address} | Balance: ${balance.balanceUSD}`);
      }
    })
    .catch(() => {
      // Silently continue - balance will be checked per-request anyway
      api.logger.info(`Wallet: ${wallet.address} | Balance: (checking...)`);
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
 * /wallet command handler for ClawRouter.
 * - /wallet or /wallet status: Show wallet address, balance, and key file location
 * - /wallet export: Show private key for backup (with security warning)
 */
async function createWalletCommand(): Promise<OpenClawPluginCommandDefinition> {
  return {
    name: "wallet",
    description: "Show BlockRun wallet info or export private key for backup",
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

      if (subcommand === "setup-solana") {
        // Set up Solana wallet for existing EVM-only users
        try {
          const { solanaPrivateKeyBytes } = await setupSolana();
          // Derive Solana address for display
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
              "Restart the gateway to enable Solana payments.",
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

      // Default: show wallet status
      let evmBalanceText = "Balance: (checking...)";
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
              `  Fund: https://solscan.io/account/${solAddr}`,
            ].join("\n");
          }
        }
      } catch {
        // No Solana wallet - that's fine
      }

      return {
        text: [
          "**ClawRouter Wallet**",
          "",
          "**Base (EVM):**",
          `  Address: \`${address}\``,
          `  ${evmBalanceText}`,
          `  Fund: https://basescan.org/address/${address}`,
          solanaSection,
          "",
          `**Key File:** \`${WALLET_FILE}\``,
          "",
          "**Commands:**",
          "• `/wallet` - Show this status",
          "• `/wallet export` - Export private key for backup",
          !solanaSection ? "• `/wallet setup-solana` - Enable Solana payments" : "",
        ].filter(Boolean).join("\n"),
      };
    },
  };
}

const plugin: OpenClawPluginDefinition = {
  id: "clawrouter",
  name: "ClawRouter",
  description: "Smart LLM router — 30+ models, x402 micropayments, 78% cost savings",
  version: VERSION,

  async register(api: OpenClawPluginApi) {
    // Check if ClawRouter is disabled via environment variable
    // Usage: CLAWROUTER_DISABLED=true openclaw gateway start
    const isDisabled =
      process["env"].CLAWROUTER_DISABLED === "true" || process["env"].CLAWROUTER_DISABLED === "1";
    if (isDisabled) {
      api.logger.info("ClawRouter disabled (CLAWROUTER_DISABLED=true). Using default routing.");
      return;
    }

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

    api.logger.info("BlockRun provider registered (30+ models via x402)");

    // Register partner API tools (Twitter/X lookup, etc.)
    try {
      const { buildPartnerTools, PARTNER_SERVICES } = await import("./partners/index.js");
      const proxyBaseUrl = `http://127.0.0.1:${runtimePort}`;
      const partnerTools = buildPartnerTools(proxyBaseUrl);
      for (const tool of partnerTools) {
        api.registerTool(tool);
      }
      if (partnerTools.length > 0) {
        api.logger.info(`Registered ${partnerTools.length} partner tool(s): ${partnerTools.map((t) => t.name).join(", ")}`);
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

          const lines = [
            "**Partner APIs** (paid via your ClawRouter wallet)",
            "",
          ];

          for (const svc of PARTNER_SERVICES) {
            lines.push(`**${svc.name}** (${svc.partner})`);
            lines.push(`  ${svc.description}`);
            lines.push(`  Tool: \`${`blockrun_${svc.id}`}\``);
            lines.push(`  Pricing: ${svc.pricing.perUnit} per ${svc.pricing.unit} (min ${svc.pricing.minimum}, max ${svc.pricing.maximum})`);
            lines.push(`  **How to use:** Ask "Look up Twitter user @elonmusk" or "Get info on these X accounts: @naval, @balajis"`);
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

    // Register /wallet command for wallet management
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
export type { ProxyOptions, ProxyHandle, WalletConfig, LowBalanceInfo, InsufficientFundsInfo } from "./proxy.js";
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
export { setupSolana } from "./auth.js";
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
export { getStats, formatStatsAscii } from "./stats.js";
export type { DailyStats, AggregatedStats } from "./stats.js";
export { SessionStore, getSessionId, DEFAULT_SESSION_CONFIG } from "./session.js";
export type { SessionEntry, SessionConfig } from "./session.js";
export { ResponseCache } from "./response-cache.js";
export type { CachedLLMResponse, ResponseCacheConfig } from "./response-cache.js";
export { PARTNER_SERVICES, getPartnerService, buildPartnerTools } from "./partners/index.js";
export type { PartnerServiceDefinition, PartnerToolDefinition } from "./partners/index.js";
