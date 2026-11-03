/**
 * MPP (Machine Payments Protocol) payment rails for ClawRouter.
 *
 *   import { startProxy } from "@blockrun/clawrouter";
 *   import { createMppFetch } from "@twzrd/clawrouter-mpp";
 *   await startProxy({ ..., payFetch: createMppFetch(account, fetch, { spend }) });
 *
 * Two rails: Tempo (`createMppFetch`, needs `mppx`) and Solana (`createSolanaMppFetch`, needs
 * `@solana/pay-kit`). Both are optional peer dependencies, loaded on the first paid call.
 */
export {
  createMppFetch,
  DEFAULT_TEMPO_USD_ASSETS,
  guardMethod,
  quoteFromChallenge,
} from "./mpp-fetch.js";
export type { MppFetchOptions, PayFetch } from "./mpp-fetch.js";
export { createSolanaMppFetch, DEFAULT_SOLANA_USD_MINTS } from "./mpp-solana-fetch.js";
export type { SolanaMppFetchOptions } from "./mpp-solana-fetch.js";
export { MppPaidNoCompletionError } from "./mpp-paid-failure.js";
