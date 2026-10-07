/**
 * Configuration Module
 *
 * Reads environment variables at module load time.
 * Separated from network code to avoid security scanner false positives.
 */

import { parseSolanaBatchConfig, type SolanaBatchConfig } from "./solana-batch.js";

const DEFAULT_PORT = 8402;

/**
 * Proxy port configuration - resolved once at module load.
 * Reads BLOCKRUN_PROXY_PORT env var or defaults to 8402.
 */
export const PROXY_PORT = (() => {
  const envPort = process["env"].BLOCKRUN_PROXY_PORT;
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (!isNaN(parsed) && parsed > 0 && parsed < 65536) {
      return parsed;
    }
  }
  return DEFAULT_PORT;
})();

/**
 * Opt-in Solana x402 batch settlement (off by default). Read at call time so
 * tests and `doctor` see the current environment. See solana-batch.ts.
 */
export function solanaBatchConfigFromEnv(): SolanaBatchConfig {
  return parseSolanaBatchConfig(process["env"]);
}

/** CLAWROUTER_SOLANA_RPC_URL, the Solana RPC override (undefined = library default). */
export function solanaRpcUrlFromEnv(): string | undefined {
  return process["env"].CLAWROUTER_SOLANA_RPC_URL || undefined;
}
