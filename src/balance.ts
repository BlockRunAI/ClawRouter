/**
 * Balance Monitor for ClawRouter
 *
 * Monitors stablecoin balance on Base network with intelligent caching.
 * Supports any EIP-3009 stablecoin (USDC, fxUSD, EURC, etc.) with
 * automatic normalization from native decimals to USD micros (6 decimals).
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
import { DEFAULT_BASE_PAYMENT_ASSET, type BasePaymentAsset } from "./payment-asset.js";

/** Cache TTL in milliseconds (30 seconds) */
const CACHE_TTL_MS = 30_000;

/** Balance thresholds in USD micros (6 decimals, normalized from any stablecoin) */
export const BALANCE_THRESHOLDS = {
  /** Low balance warning threshold: $1.00 */
  LOW_BALANCE_MICROS: 1_000_000n,
  /** Effectively zero threshold: $0.0001 (covers dust/rounding) */
  ZERO_THRESHOLD: 100n,
} as const;

/** Balance information returned by checkBalance() */
export type BalanceInfo = {
  /** Raw balance normalized to USD micros (6 decimals, regardless of the underlying asset's native decimals) */
  balance: bigint;
  /** Formatted balance as "$X.XX" */
  balanceUSD: string;
  /** Symbol of the active Base payment asset */
  assetSymbol: string;
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
 * Monitors stablecoin balance on Base network.
 *
 * Usage:
 *   const monitor = new BalanceMonitor("0x...");
 *   const info = await monitor.checkBalance();
 *   if (info.isLow) console.warn("Low balance!");
 */
export class BalanceMonitor {
  private readonly client;
  private readonly walletAddress: `0x${string}`;
  private readonly assetMonitors = new Map<string, BalanceMonitor>();
  private state: {
    asset: BasePaymentAsset;
    cachedBalance: bigint | null;
    cachedAt: number;
  };

  constructor(walletAddress: string, asset: BasePaymentAsset = DEFAULT_BASE_PAYMENT_ASSET) {
    this.walletAddress = walletAddress as `0x${string}`;
    this.state = {
      asset,
      cachedBalance: null,
      cachedAt: 0,
    };
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
    const state = this.state;
    const now = Date.now();

    // Use cache only when balance is positive and still fresh.
    // Zero balance is never cached — always re-fetch so a funded wallet is
    // detected on the next request without waiting for cache expiry.
    if (
      state.cachedBalance !== null &&
      state.cachedBalance > 0n &&
      now - state.cachedAt < CACHE_TTL_MS
    ) {
      return this.buildInfo(state.cachedBalance, state.asset);
    }

    // Fetch from RPC
    const balance = await this.fetchBalance(state.asset);
    if (balance > 0n) {
      state.cachedBalance = balance;
      state.cachedAt = now;
    }

    return this.buildInfo(balance, state.asset);
  }

  /**
   * Check if balance is sufficient for an estimated cost.
   *
   * @param estimatedCostMicros - Estimated cost in USD micros (6 decimals)
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
      shortfall: this.formatUSD(shortfall),
    };
  }

  private get cachedBalance(): bigint | null {
    return this.state.cachedBalance;
  }

  private set cachedBalance(value: bigint | null) {
    this.state.cachedBalance = value;
  }

  private get cachedAt(): number {
    return this.state.cachedAt;
  }

  private set cachedAt(value: number) {
    this.state.cachedAt = value;
  }

  /**
   * Optimistically deduct estimated cost from cached balance.
   * Call this after a successful payment to keep cache accurate.
   *
   * @param amountMicros - Amount to deduct in USD micros
   */
  deductEstimated(amountMicros: bigint): void {
    const state = this.state;
    if (state.cachedBalance !== null && state.cachedBalance >= amountMicros) {
      state.cachedBalance -= amountMicros;
    }
  }

  /**
   * Invalidate cache, forcing next checkBalance() to fetch from RPC.
   * Call this after a payment failure to get accurate balance.
   */
  invalidate(): void {
    const state = this.state;
    state.cachedBalance = null;
    state.cachedAt = 0;
  }

  /**
   * Force refresh balance from RPC (ignores cache).
   */
  async refresh(): Promise<BalanceInfo> {
    this.invalidate();
    return this.checkBalance();
  }

  setAsset(asset: BasePaymentAsset): void {
    const currentAsset = this.state.asset;
    if (
      currentAsset.asset.toLowerCase() !== asset.asset.toLowerCase() ||
      currentAsset.symbol !== asset.symbol ||
      currentAsset.decimals !== asset.decimals
    ) {
      this.state = this.getSharedMonitorForAsset(asset).state;
    }
  }

  getAsset(): BasePaymentAsset {
    return this.state.asset;
  }

  /**
   * Format a stablecoin amount (normalized to USD micros) as "$X.XX".
   */
  formatUSD(amountMicros: bigint): string {
    const dollars = Number(amountMicros) / 1_000_000;
    return `$${dollars.toFixed(2)}`;
  }

  formatUSDC(amountMicros: bigint): string {
    return this.formatUSD(amountMicros);
  }

  /**
   * Get the wallet address being monitored.
   */
  getWalletAddress(): string {
    return this.walletAddress;
  }

  getAssetSymbol(): string {
    return this.state.asset.symbol;
  }

  getSharedMonitorForAsset(asset: BasePaymentAsset): BalanceMonitor {
    if (
      this.state.asset.asset.toLowerCase() === asset.asset.toLowerCase() &&
      this.state.asset.symbol === asset.symbol &&
      this.state.asset.decimals === asset.decimals
    ) {
      return this;
    }

    const key = `${asset.asset.toLowerCase()}:${asset.symbol}:${asset.decimals}`;
    const existing = this.assetMonitors.get(key);
    if (existing) return existing;

    const monitor = new BalanceMonitor(this.walletAddress, asset);
    this.assetMonitors.set(key, monitor);
    return monitor;
  }

  /** Fetch balance from RPC */
  private async fetchBalance(asset: BasePaymentAsset): Promise<bigint> {
    try {
      const balance = await this.client.readContract({
        address: asset.asset,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [this.walletAddress],
      });
      return this.toUsdMicros(balance, asset);
    } catch (error) {
      // Throw typed error instead of silently returning 0
      // This allows callers to distinguish "node down" from "wallet empty"
      throw new RpcError(error instanceof Error ? error.message : "Unknown error", error);
    }
  }

  /** Build BalanceInfo from raw balance */
  private buildInfo(balance: bigint, asset: BasePaymentAsset): BalanceInfo {
    return {
      balance,
      balanceUSD: this.formatUSD(balance),
      assetSymbol: asset.symbol,
      isLow: balance < BALANCE_THRESHOLDS.LOW_BALANCE_MICROS,
      isEmpty: balance < BALANCE_THRESHOLDS.ZERO_THRESHOLD,
      walletAddress: this.walletAddress,
    };
  }

  private toUsdMicros(rawAmount: bigint, asset: BasePaymentAsset): bigint {
    if (asset.decimals === 6) return rawAmount;
    if (asset.decimals > 6) {
      return rawAmount / 10n ** BigInt(asset.decimals - 6);
    }
    return rawAmount * 10n ** BigInt(6 - asset.decimals);
  }
}
