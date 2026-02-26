/**
 * WalletSigner — abstract signing interface for x402 payments.
 *
 * Decouples x402.ts from the underlying key management strategy.
 * Two implementations:
 *   - PrivateKeyWalletSigner  — raw 0x private key (existing behavior)
 *   - CdpWalletSigner         — Coinbase Developer Platform MPC wallet
 */

export interface TypedDataDomain {
  name?: string;
  version?: string;
  chainId?: number;
  verifyingContract?: `0x${string}`;
}

export interface TypedDataParams {
  domain: TypedDataDomain;
  // Accept both mutable and readonly typed data arrays (viem as const compatibility)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  types: Record<string, any>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface WalletSigner {
  /** EVM address (checksummed 0x...) */
  address: `0x${string}`;
  /** Sign EIP-712 typed data and return hex signature */
  signTypedData(params: TypedDataParams): Promise<`0x${string}`>;
}
