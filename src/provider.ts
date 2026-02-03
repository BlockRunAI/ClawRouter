/**
 * BlockRun ProviderPlugin for OpenClaw
 *
 * Registers BlockRun as an LLM provider in OpenClaw.
 * Uses a local x402 proxy to handle micropayments transparently —
 * pi-ai sees a standard OpenAI-compatible API at localhost.
 */

import type { ProviderPlugin, AuthProfileCredential } from "./types.js";
import { walletKeyAuth, envKeyAuth } from "./auth.js";
import { buildProviderModels } from "./models.js";
import type { ProxyHandle } from "./proxy.js";

/**
 * State for the running proxy (set when the plugin activates).
 */
let activeProxy: ProxyHandle | null = null;

/**
 * Update the proxy handle (called from index.ts when the proxy starts).
 */
export function setActiveProxy(proxy: ProxyHandle): void {
  activeProxy = proxy;
}

export function getActiveProxy(): ProxyHandle | null {
  return activeProxy;
}

/**
 * BlockRun provider plugin definition.
 */
export const blockrunProvider: ProviderPlugin = {
  id: "blockrun",
  label: "BlockRun",
  docsPath: "https://docs.blockrun.ai",
  aliases: ["br"],
  envVars: ["BLOCKRUN_WALLET_KEY"],

  // Model definitions — dynamically set to proxy URL
  get models() {
    if (!activeProxy) {
      // Fallback: point to BlockRun API directly (won't handle x402, but
      // allows config loading before proxy starts)
      return buildProviderModels("https://api.blockrun.ai/api");
    }
    return buildProviderModels(activeProxy.baseUrl);
  },

  // Auth methods
  auth: [envKeyAuth, walletKeyAuth],

  // Format the stored credential as the wallet key
  formatApiKey: (cred: AuthProfileCredential): string => {
    if ("apiKey" in cred && typeof cred.apiKey === "string") {
      return cred.apiKey;
    }
    throw new Error("BlockRun credential must contain an apiKey (wallet private key)");
  },
};
