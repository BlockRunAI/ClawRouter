/**
 * MPP (Machine Payments Protocol) payment rails for ClawRouter.
 *
 *   import { startProxy } from "@twzrd1111/clawrouter";
 *   import { createMppFetch } from "@twzrd1111/clawrouter-mpp";
 *   await startProxy({ ..., payFetch: createMppFetch(account, fetch, { spend }) });
 *
 * Two rails: Tempo (`createMppFetch`, needs `mppx`) and Solana (`createSolanaMppFetch`, needs
 * `@solana/mpp`). Both are optional peer dependencies; Tempo loads on first use,
 * Solana loads when its asynchronous factory is called.
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
export {
  MppPaidNoCompletionError,
  creditPaidNoCompletion,
  readCredits,
} from "./mpp-paid-failure.js";
export { CreditLedger } from "./credit-record.js";
export type { CreditEntry } from "./credit-record.js";
export { SpentProofLedger, ReplayRejectedError, fulfillPaidProof } from "./spent-proof.js";
