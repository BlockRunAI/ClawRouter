/**
 * Desktop's view of the payment chains. The chain list, labels and type are
 * NOT redefined here: they come from ClawRouter's own table
 * (src/payment-chain.ts), the same one the CLI and proxy use, so a chain the
 * proxy can pay on cannot be missing from Desktop. Imported by both the
 * Electron main process and the renderer; keep it free of Node imports.
 */
import {
  PAYMENT_CHAINS,
  PAYMENT_CHAIN_LABELS,
  isPaymentChain,
  type PaymentChain,
} from "../../../../src/payment-chain.js";

export { PAYMENT_CHAINS, PAYMENT_CHAIN_LABELS, isPaymentChain };
export type { PaymentChain };

/**
 * Which Core wallet pays on a chain. Base and Arc are both EVM and share ONE
 * key (~/.blockrun/.session) and address; Solana has its own
 * (~/.blockrun/.solana-session).
 */
export type WalletKind = "evm" | "solana";

export function walletKindOf(chain: PaymentChain): WalletKind {
  return chain === "solana" ? "solana" : "evm";
}

/** The Core wallet file a chain's key lives in. */
export function coreWalletFileOf(chain: PaymentChain): ".session" | ".solana-session" {
  return walletKindOf(chain) === "evm" ? ".session" : ".solana-session";
}

export function chainLabel(chain: PaymentChain): string {
  return PAYMENT_CHAIN_LABELS[chain];
}

/** A chain from /health or a chain file; anything unrecognised is undefined, not Base. */
export function paymentChainOrUndefined(value: unknown): PaymentChain | undefined {
  return isPaymentChain(value) ? value : undefined;
}
