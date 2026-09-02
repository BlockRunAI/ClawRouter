/**
 * BlockRun ProviderPlugin for OpenClaw
 *
 * Registers BlockRun as an LLM provider in OpenClaw.
 * Uses a local x402 proxy to handle micropayments transparently —
 * pi-ai sees a standard OpenAI-compatible API at localhost.
 */

import type { ProviderPlugin } from "./types.js";
import { buildProviderModels } from "./models.js";
import type { ProxyHandle } from "./proxy.js";
import { getProxyPort } from "./proxy.js";

/**
 * State for the running proxy (set when the plugin activates).
 */
let activeProxy: ProxyHandle | null = null;

/**
 * Update the proxy handle (called from index.ts when the proxy starts).
 */
export function setActiveProxy(proxy: ProxyHandle | null): void {
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
  docsPath: "https://blockrun.ai/docs",
  aliases: ["br"],
  envVars: ["BLOCKRUN_WALLET_KEY"],

  // Model definitions — always point to local proxy URL.
  // Even before the proxy starts, we return the local URL so that OpenClaw's
  // async config persistence writes the correct baseUrl to openclaw.json.
  get models() {
    if (activeProxy) {
      return buildProviderModels(activeProxy.baseUrl);
    }
    // Proxy not started yet — use the configured port so OpenClaw persists
    // the correct local URL, not the remote blockrun.ai fallback.
    const port = getProxyPort();
    return buildProviderModels(`http://127.0.0.1:${port}/v1`);
  },

  // No auth required — the x402 proxy handles wallet-based payments internally.
  // The proxy uses the shared BlockRun Core wallet under ~/.blockrun, with
  // automatic non-destructive migration from older ClawRouter wallet files.
  auth: [],
};
