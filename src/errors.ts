/**
 * Typed Error Classes for ClawRouter
 *
 * Provides structured errors for balance-related failures with
 * all necessary information for user-friendly error messages.
 */

/**
 * Thrown when wallet has insufficient USDC balance for a request.
 */
export class InsufficientFundsError extends Error {
  readonly code = "INSUFFICIENT_FUNDS" as const;
  readonly currentBalanceUSD: string;
  readonly requiredUSD: string;
  readonly walletAddress: string;

  constructor(opts: { currentBalanceUSD: string; requiredUSD: string; walletAddress: string }) {
    super(
      `Insufficient USDC balance. Current: ${opts.currentBalanceUSD}, Required: ${opts.requiredUSD}. Fund wallet: ${opts.walletAddress}`,
    );
    this.name = "InsufficientFundsError";
    this.currentBalanceUSD = opts.currentBalanceUSD;
    this.requiredUSD = opts.requiredUSD;
    this.walletAddress = opts.walletAddress;
  }
}

/**
 * Thrown when wallet has no USDC balance (or effectively zero).
 */
export class EmptyWalletError extends Error {
  readonly code = "EMPTY_WALLET" as const;
  readonly walletAddress: string;

  constructor(walletAddress: string) {
    super(`No USDC balance. Fund wallet to use ClawRouter: ${walletAddress}`);
    this.name = "EmptyWalletError";
    this.walletAddress = walletAddress;
  }
}

/**
 * Type guard to check if an error is InsufficientFundsError.
 */
export function isInsufficientFundsError(error: unknown): error is InsufficientFundsError {
  return error instanceof Error && (error as InsufficientFundsError).code === "INSUFFICIENT_FUNDS";
}

/**
 * Type guard to check if an error is EmptyWalletError.
 */
export function isEmptyWalletError(error: unknown): error is EmptyWalletError {
  return error instanceof Error && (error as EmptyWalletError).code === "EMPTY_WALLET";
}

/**
 * Type guard to check if an error is a balance-related error.
 */
export function isBalanceError(error: unknown): error is InsufficientFundsError | EmptyWalletError {
  return isInsufficientFundsError(error) || isEmptyWalletError(error);
}

/**
 * Thrown when RPC call fails (network error, node down, etc).
 * Distinguishes infrastructure failures from actual empty wallets.
 */
export class RpcError extends Error {
  readonly code = "RPC_ERROR" as const;
  readonly originalError: unknown;

  constructor(message: string, originalError?: unknown) {
    super(`RPC error: ${message}. Check network connectivity.`);
    this.name = "RpcError";
    this.originalError = originalError;
  }
}

/**
 * Type guard to check if an error is RpcError.
 */
export function isRpcError(error: unknown): error is RpcError {
  return error instanceof Error && (error as RpcError).code === "RPC_ERROR";
}
