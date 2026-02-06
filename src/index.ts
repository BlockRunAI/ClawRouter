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
 *   openclaw config set model blockrun/auto
 *
 *   # Or use any specific BlockRun model
 *   openclaw config set model openai/gpt-5.2
 */

import type { OpenClawPluginDefinition, OpenClawPluginApi } from "./types.js";
import { blockrunProvider, setActiveProxy } from "./provider.js";
import { startProxy } from "./proxy.js";
import { resolveOrGenerateWalletKey } from "./auth.js";
import type { RoutingConfig } from "./router/index.js";
import { BalanceMonitor } from "./balance.js";

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
      api.logger.warn(`[!] Low balance: ${startupBalance.balanceUSD} remaining. Fund wallet: ${address}`);
    } else {
      api.logger.info(`Wallet balance: ${startupBalance.balanceUSD}`);
    }
  } catch (err) {
    api.logger.warn(`Could not check wallet balance: ${err instanceof Error ? err.message : String(err)}`);
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
      api.logger.error(`[!] Insufficient funds. Balance: ${info.balanceUSD}, Needed: ${info.requiredUSD}. Fund wallet: ${info.walletAddress}`);
    },
  });

  setActiveProxy(proxy);
  api.logger.info(`BlockRun provider active — ${proxy.baseUrl}/v1 (smart routing enabled)`);
}

const plugin: OpenClawPluginDefinition = {
  id: "clawrouter",
  name: "ClawRouter",
  description: "Smart LLM router — 30+ models, x402 micropayments, 78% cost savings",
  version: "0.3.2",

  register(api: OpenClawPluginApi) {
    // Register BlockRun as a provider (sync — available immediately)
    api.registerProvider(blockrunProvider);
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
export { InsufficientFundsError, EmptyWalletError, RpcError, isInsufficientFundsError, isEmptyWalletError, isBalanceError, isRpcError } from "./errors.js";
export { fetchWithRetry, isRetryable, DEFAULT_RETRY_CONFIG } from "./retry.js";
export type { RetryConfig } from "./retry.js";
