/**
 * @blockrun/clawrouter
 *
 * Smart LLM router for OpenClaw — 30+ models, x402 micropayments, 78% cost savings.
 * Routes each request to the cheapest model that can handle it.
 *
 * Usage:
 *   # Install the plugin
 *   openclaw plugin install @blockrun/clawrouter
 *
 *   # Fund your wallet with USDC on Base (address printed on install)
 *
 *   # Use smart routing (auto-picks cheapest model)
 *   openclaw models set blockrun/auto
 *
 *   # Or use any specific BlockRun model
 *   openclaw models set openai/gpt-5.2
 */

import type { OpenClawPluginDefinition, OpenClawPluginApi } from "./types.js";
import { blockrunProvider, setActiveProxy } from "./provider.js";
import { startProxy } from "./proxy.js";
import { resolveOrGenerateWalletKey } from "./auth.js";
import type { RoutingConfig } from "./router/index.js";
import { BalanceMonitor } from "./balance.js";
import { OPENCLAW_MODELS } from "./models.js";
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Inject BlockRun models config into OpenClaw config file.
 * This is required because registerProvider() alone doesn't make models available.
 */
function injectModelsConfig(logger: { info: (msg: string) => void }): void {
  const configPath = join(homedir(), ".openclaw", "openclaw.json");
  if (!existsSync(configPath)) {
    logger.info("OpenClaw config not found, skipping models injection");
    return;
  }

  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));

    // Check if already configured
    if (config.models?.providers?.blockrun) {
      return; // Already configured
    }

    // Inject models config
    if (!config.models) config.models = {};
    if (!config.models.providers) config.models.providers = {};

    config.models.providers.blockrun = {
      baseUrl: "http://127.0.0.1:8402/v1",
      api: "openai-completions",
      models: OPENCLAW_MODELS,
    };

    writeFileSync(configPath, JSON.stringify(config, null, 2));
    logger.info("Injected BlockRun models into OpenClaw config");
  } catch {
    // Silently fail — config injection is best-effort
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
      logger.info(`Could not create agents dir: ${err instanceof Error ? err.message : String(err)}`);
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

      // Load or create auth-profiles.json
      let authProfiles: Record<string, unknown> = {};
      if (existsSync(authPath)) {
        try {
          authProfiles = JSON.parse(readFileSync(authPath, "utf-8"));
        } catch {
          authProfiles = {};
        }
      }

      // Check if blockrun auth already exists
      if (authProfiles.blockrun) {
        continue; // Already configured
      }

      // Inject placeholder auth for blockrun
      // The proxy handles real x402 auth internally, this just satisfies OpenClaw's lookup
      authProfiles.blockrun = {
        profileId: "default",
        credential: {
          apiKey: "x402-proxy-handles-auth",
        },
      };

      try {
        writeFileSync(authPath, JSON.stringify(authProfiles, null, 2));
        logger.info(`Injected BlockRun auth profile for agent: ${agentId}`);
      } catch (err) {
        logger.info(`Could not inject auth for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    logger.info(`Auth injection failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Start the x402 proxy in the background.
 * Called from register() because OpenClaw's loader only invokes register(),
 * treating activate() as an alias (def.register ?? def.activate).
 */
async function startProxyInBackground(api: OpenClawPluginApi): Promise<void> {
  // Resolve wallet key: saved file → env var → auto-generate
  const { key: walletKey, address, source } = await resolveOrGenerateWalletKey();

  // Log wallet source
  if (source === "generated") {
    api.logger.info(`Generated new wallet: ${address}`);
    api.logger.info(`Fund with USDC on Base to start using ClawRouter.`);
  } else if (source === "saved") {
    api.logger.info(`Using saved wallet: ${address}`);
  } else {
    api.logger.info(`Using wallet from BLOCKRUN_WALLET_KEY: ${address}`);
  }

  // --- Startup balance check ---
  const startupMonitor = new BalanceMonitor(address);
  try {
    const startupBalance = await startupMonitor.checkBalance();
    if (startupBalance.isEmpty) {
      api.logger.warn(`[!] No USDC balance. Fund wallet to use ClawRouter: ${address}`);
    } else if (startupBalance.isLow) {
      api.logger.warn(
        `[!] Low balance: ${startupBalance.balanceUSD} remaining. Fund wallet: ${address}`,
      );
    } else {
      api.logger.info(`Wallet balance: ${startupBalance.balanceUSD}`);
    }
  } catch (err) {
    api.logger.warn(
      `Could not check wallet balance: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Resolve routing config overrides from plugin config
  const routingConfig = api.pluginConfig?.routing as Partial<RoutingConfig> | undefined;

  const proxy = await startProxy({
    walletKey,
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
      api.logger.info(`${decision.model} $${cost} (saved ${saved}%)`);
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
  api.logger.info(`BlockRun provider active — ${proxy.baseUrl}/v1 (smart routing enabled)`);
}

const plugin: OpenClawPluginDefinition = {
  id: "clawrouter",
  name: "ClawRouter",
  description: "Smart LLM router — 30+ models, x402 micropayments, 78% cost savings",
  version: "0.3.11",

  register(api: OpenClawPluginApi) {
    // Register BlockRun as a provider (sync — available immediately)
    api.registerProvider(blockrunProvider);

    // Inject models config into OpenClaw config file
    // This persists the config so models are recognized on restart
    injectModelsConfig(api.logger);

    // Inject dummy auth profiles into agent auth stores
    // OpenClaw's agent system looks for auth even if provider has auth: []
    injectAuthProfile(api.logger);

    // Also set runtime config for immediate availability
    if (!api.config.models) {
      api.config.models = { providers: {} };
    }
    if (!api.config.models.providers) {
      api.config.models.providers = {};
    }
    api.config.models.providers.blockrun = {
      baseUrl: "http://127.0.0.1:8402/v1",
      api: "openai-completions",
      models: OPENCLAW_MODELS,
    };

    api.logger.info("BlockRun provider registered (30+ models via x402)");

    // Start x402 proxy in background (fire-and-forget)
    // OpenClaw only calls register(), not activate() — so all init goes here.
    // The loader ignores async returns, but the proxy starts in the background
    // and setActiveProxy() makes it available to the provider once ready.
    startProxyInBackground(api).catch((err) => {
      api.logger.error(
        `Failed to start BlockRun proxy: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  },
};

export default plugin;

// Re-export for programmatic use
export { startProxy } from "./proxy.js";
export type { ProxyOptions, ProxyHandle, LowBalanceInfo, InsufficientFundsInfo } from "./proxy.js";
export { blockrunProvider } from "./provider.js";
export { OPENCLAW_MODELS, BLOCKRUN_MODELS, buildProviderModels } from "./models.js";
export { route, DEFAULT_ROUTING_CONFIG } from "./router/index.js";
export type { RoutingDecision, RoutingConfig, Tier } from "./router/index.js";
export { logUsage } from "./logger.js";
export type { UsageEntry } from "./logger.js";
export { RequestDeduplicator } from "./dedup.js";
export type { CachedResponse } from "./dedup.js";
export { PaymentCache } from "./payment-cache.js";
export type { CachedPaymentParams } from "./payment-cache.js";
export { createPaymentFetch } from "./x402.js";
export type { PreAuthParams, PaymentFetchResult } from "./x402.js";
export { BalanceMonitor, BALANCE_THRESHOLDS } from "./balance.js";
export type { BalanceInfo, SufficiencyResult } from "./balance.js";
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
