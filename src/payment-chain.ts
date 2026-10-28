/**
 * The x402 payment chains ClawRouter can pay on, and the per-chain facts every
 * surface (CLI, OpenClaw command, proxy, balance, doctor) needs to agree on.
 *
 *   base    Base mainnet (eip155:8453)  → https://blockrun.ai/api
 *   solana  Solana mainnet              → https://sol.blockrun.ai/api
 *   arc     Circle's Arc (eip155:5042)  → https://arc.blockrun.ai/api
 *
 * Base and Arc are both EVM and share ONE key: the same address holds USDC on
 * each, and the 402's `network` decides which chain's USDC gets signed for.
 * Arc's gateway serves the same routes, prices and $0.001 per-call fee as
 * Base; it differs only in the chain it settles on. Solana has its own key.
 *
 * Leaf module on purpose — no imports — so auth.ts, proxy.ts and balance.ts
 * can all depend on it without a cycle.
 */

export type PaymentChain = "base" | "solana" | "arc";

/**
 * Every selectable chain, in display order (Desktop's chain selector renders
 * this list as-is). Also imported by apps/desktop, so adding a chain here is
 * what puts it in front of a Desktop user.
 */
export const PAYMENT_CHAINS: readonly PaymentChain[] = ["base", "solana", "arc"];

export function isPaymentChain(value: unknown): value is PaymentChain {
  return typeof value === "string" && (PAYMENT_CHAINS as readonly string[]).includes(value);
}

/** True for the chains paid from the EVM wallet key (Base, Arc). */
export function isEvmPaymentChain(chain: PaymentChain): chain is "base" | "arc" {
  return chain !== "solana";
}

/** Display name, for copy that names the chain a payment settles on. */
export const PAYMENT_CHAIN_LABELS: Readonly<Record<PaymentChain, string>> = {
  base: "Base",
  solana: "Solana",
  arc: "Arc",
};

/** The x402 gateway each chain's payments are made against. */
export const PAYMENT_CHAIN_GATEWAYS: Readonly<Record<PaymentChain, string>> = {
  base: "https://blockrun.ai/api",
  solana: "https://sol.blockrun.ai/api",
  arc: "https://arc.blockrun.ai/api",
};

/** Arc mainnet, as carried on x402 `selectedRequirements.network`. */
export const CAIP2_ARC = "eip155:5042";
/** Arc chain id. */
export const ARC_CHAIN_ID = 5042;
/**
 * USDC on Arc: the chain's native token exposed as an ERC-20 (6 decimals).
 * Its EIP-712 domain is name "USDC", version "2" — not Base's "USD Coin". The
 * exact-EVM signer takes name/version from the 402's `extra` and the chain id
 * from its `network`, so no Arc-specific signing code is needed here.
 */
export const USDC_ARC = "0x3600000000000000000000000000000000000000" as const;

/**
 * Where a user can look up their address on each chain's explorer, or
 * undefined where ClawRouter does not link one (Arc: no explorer it can rely on).
 */
export function explorerAddressUrl(chain: PaymentChain, address: string): string | undefined {
  if (chain === "base") return `https://basescan.org/address/${address}`;
  if (chain === "solana") return `https://solscan.io/account/${address}`;
  return undefined;
}
