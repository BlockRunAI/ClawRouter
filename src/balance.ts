/**
 * Balance Monitor for ClawRouter
 *
 * Monitors USDC balance on Base network with intelligent caching.
 * Provides pre-request balance checks to prevent failed payments.
 *
 * Caching Strategy:
 *   - TTL: 30 seconds (balance is cached to avoid excessive RPC calls)
 *   - Optimistic deduction: after successful payment, subtract estimated cost from cache
 *   - Invalidation: on payment failure, immediately refresh from RPC
 */

import { createPublicClient, http, erc20Abi } from "viem";
import { base } from "viem/chains";
import { RpcError } from "./errors.js";

/** USDC contract address on Base mainnet */
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

/** Cache TTL in milliseconds (30 seconds) */
const CACHE_TTL_MS = 30_000;

/** Balance thresholds in USDC smallest unit (6 decimals) */
export const BALANCE_THRESHOLDS = {
  /** Low balance warning threshold: $1.00 */
  LOW_BALANCE_MICROS: 1_000_000n,
  /** Effectively zero threshold: $0.0001 (covers dust/rounding) */
  ZERO_THRESHOLD: 100n,
} as const;

/** Balance information returned by checkBalance() */
export type BalanceInfo = {
  /** Raw balance in USDC smallest unit (6 decimals) */
  balance: bigint;
  /** Formatted balance as "$X.XX" */
  balanceUSD: string;
  /** True if balance < $1.00 */
  isLow: boolean;
  /** True if balance < $0.0001 (effectively zero) */
  isEmpty: boolean;
  /** Wallet address for funding instructions */
  walletAddress: string;
};

/** Result from checkSufficient() */
export type SufficiencyResult = {
  /** True if balance >= estimated cost */
  sufficient: boolean;
  /** Current balance info */
  info: BalanceInfo;
  /** If insufficient, the shortfall as "$X.XX" */
  shortfall?: string;
};

/**
 * Monitors USDC balance on Base network.
 *
 * Usage:
 *   const monitor = new BalanceMonitor("0x...");
 *   const info = await monitor.checkBalance();
 *   if (info.isLow) console.warn("Low balance!");
 */
export class BalanceMonitor {
  private readonly client;
  private readonly walletAddress: `0x${string}`;

  /** Cached balance (null = not yet fetched) */
  private cachedBalance: bigint | null = null;
  /** Timestamp when cache was last updated */
  private cachedAt = 0;

  constructor(walletAddress: string) {
    this.walletAddress = walletAddress as `0x${string}`;
    this.client = createPublicClient({
      chain: base,
      transport: http(undefined, {
        timeout: 10_000, // 10 second timeout to prevent hanging on slow RPC
      }),
    });
  }

  /**
   * Check current USDC balance.
   * Uses cache if valid, otherwise fetches from RPC.
   */
  async checkBalance(): Promise<BalanceInfo> {
    const now = Date.now();

    // Use cache only when balance is positive and still fresh.
    // Zero balance is never cached — always re-fetch so a funded wallet is
    // detected on the next request without waiting for cache expiry.
    if (
      this.cachedBalance !== null &&
      this.cachedBalance > 0n &&
      now - this.cachedAt < CACHE_TTL_MS
    ) {
      return this.buildInfo(this.cachedBalance);
    }

    // Fetch from RPC
    const balance = await this.fetchBalance();
    if (balance > 0n) {
      this.cachedBalance = balance;
      this.cachedAt = now;
    }

    return this.buildInfo(balance);
  }

  /**
   * Check if balance is sufficient for an estimated cost.
   *
   * @param estimatedCostMicros - Estimated cost in USDC smallest unit (6 decimals)
   */
  async checkSufficient(estimatedCostMicros: bigint): Promise<SufficiencyResult> {
    const info = await this.checkBalance();

    if (info.balance >= estimatedCostMicros) {
      return { sufficient: true, info };
    }

    const shortfall = estimatedCostMicros - info.balance;
    return {
      sufficient: false,
      info,
      shortfall: this.formatUSDC(shortfall),
    };
  }

  /**
   * Optimistically deduct estimated cost from cached balance.
   * Call this after a successful payment to keep cache accurate.
   *
   * @param amountMicros - Amount to deduct in USDC smallest unit
   */
  deductEstimated(amountMicros: bigint): void {
    if (this.cachedBalance !== null && this.cachedBalance >= amountMicros) {
      this.cachedBalance -= amountMicros;
    }
  }

  /**
   * Invalidate cache, forcing next checkBalance() to fetch from RPC.
   * Call this after a payment failure to get accurate balance.
   */
  invalidate(): void {
    this.cachedBalance = null;
    this.cachedAt = 0;
  }

  /**
   * Force refresh balance from RPC (ignores cache).
   */
  async refresh(): Promise<BalanceInfo> {
    this.invalidate();
    return this.checkBalance();
  }

  /**
   * Format USDC amount (in micros) as "$X.XX".
   */
  formatUSDC(amountMicros: bigint): string {
    // USDC has 6 decimals
    const dollars = Number(amountMicros) / 1_000_000;
    return `$${dollars.toFixed(2)}`;
  }

  /**
   * Get the wallet address being monitored.
   */
  getWalletAddress(): string {
    return this.walletAddress;
  }

  /** Fetch balance from RPC */
  private async fetchBalance(): Promise<bigint> {
    try {
      const balance = await this.client.readContract({
        address: USDC_BASE,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [this.walletAddress],
      });
      return balance;
    } catch (error) {
      // Throw typed error instead of silently returning 0
      // This allows callers to distinguish "node down" from "wallet empty"
      throw new RpcError(error instanceof Error ? error.message : "Unknown error", error);
    }
  }

  /** Build BalanceInfo from raw balance */
  private buildInfo(balance: bigint): BalanceInfo {
    return {
      balance,
      balanceUSD: this.formatUSDC(balance),
      isLow: balance < BALANCE_THRESHOLDS.LOW_BALANCE_MICROS,
      isEmpty: balance < BALANCE_THRESHOLDS.ZERO_THRESHOLD,
      walletAddress: this.walletAddress,
    };
  }
}

/**
 * The balance monitor for API-key mode.
 *
 * There is no wallet to read. Credit lives in the customer's BlockRun account
 * and the gateway is its own authority on it: a call that outruns the balance
 * comes back as HTTP 402 `insufficient_quota`, with a message pointing at the
 * top-up page. api.blockrun.ai publishes no key-authenticated balance endpoint,
 * so ClawRouter cannot poll one, and inventing a number here would be worse
 * than having none — the free-model fallback downgrades a request the moment
 * the monitor reports empty, and a guessed zero would silently move a paying
 * customer onto the free tier.
 *
 * So this reports "always sufficient" and lets the server refuse. That is not
 * a bypass of the spend gate: the gate it satisfies is the local *wallet*
 * check, which exists because an x402 payment that fails after the stream
 * opens is unrecoverable. An API-key call is refused before a single token is
 * generated, which is the stronger guarantee, and it is enforced server-side
 * where the actual balance is.
 */
export class ApiKeyBalanceMonitor {
  /** Large enough that every `balance >= estimatedCost` comparison passes. */
  private static readonly UNMETERED = BigInt(Number.MAX_SAFE_INTEGER);

  async checkBalance(): Promise<BalanceInfo> {
    return {
      balance: ApiKeyBalanceMonitor.UNMETERED,
      // Never a dollar figure: no caller may print this as if it were one.
      balanceUSD: "account credit",
      isLow: false,
      isEmpty: false,
      walletAddress: "",
    };
  }

  async checkSufficient(): Promise<SufficiencyResult> {
    return { sufficient: true, info: await this.checkBalance() };
  }

  /** No local cache to adjust — the server keeps the books. */
  deductEstimated(): void {}
  invalidate(): void {}

  async refresh(): Promise<BalanceInfo> {
    return this.checkBalance();
  }

  formatUSDC(amountMicros: bigint): string {
    return `$${(Number(amountMicros) / 1_000_000).toFixed(2)}`;
  }

  /** No wallet in this mode; callers render the account instead. */
  getWalletAddress(): string {
    return "";
  }
}
