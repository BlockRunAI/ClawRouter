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
      transport: http(),
    });
  }

  /**
   * Check current USDC balance.
   * Uses cache if valid, otherwise fetches from RPC.
   */
  async checkBalance(): Promise<BalanceInfo> {
    const now = Date.now();

    // Use cache if valid
    if (this.cachedBalance !== null && now - this.cachedAt < CACHE_TTL_MS) {
      return this.buildInfo(this.cachedBalance);
    }

    // Fetch from RPC
    const balance = await this.fetchBalance();
    this.cachedBalance = balance;
    this.cachedAt = now;

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
      throw new RpcError(
        error instanceof Error ? error.message : "Unknown error",
        error,
      );
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
