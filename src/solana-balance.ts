/**
 * Solana USDC Balance Monitor
 *
 * Checks USDC balance on Solana mainnet with caching.
 * Absorbed from @blockrun/clawwallet's solana-adapter.ts (balance portion only).
 */

import { address as solAddress, createSolanaRpc } from "@solana/kit";

const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOLANA_DEFAULT_RPC = "https://api.mainnet-beta.solana.com";
const BALANCE_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 30_000;

export type SolanaBalanceInfo = {
  balance: bigint;
  balanceUSD: string;
  isLow: boolean;
  isEmpty: boolean;
  walletAddress: string;
};

export class SolanaBalanceMonitor {
  private readonly rpc: ReturnType<typeof createSolanaRpc>;
  private readonly walletAddress: string;
  private cachedBalance: bigint | null = null;
  private cachedAt = 0;

  constructor(walletAddress: string, rpcUrl?: string) {
    this.walletAddress = walletAddress;
    const url = rpcUrl || process["env"].CLAWROUTER_SOLANA_RPC_URL || SOLANA_DEFAULT_RPC;
    this.rpc = createSolanaRpc(url);
  }

  async checkBalance(): Promise<SolanaBalanceInfo> {
    const now = Date.now();
    if (this.cachedBalance !== null && now - this.cachedAt < CACHE_TTL_MS) {
      return this.buildInfo(this.cachedBalance);
    }
    const balance = await this.fetchBalance();
    this.cachedBalance = balance;
    this.cachedAt = now;
    return this.buildInfo(balance);
  }

  deductEstimated(amountMicros: bigint): void {
    if (this.cachedBalance !== null && this.cachedBalance >= amountMicros) {
      this.cachedBalance -= amountMicros;
    }
  }

  invalidate(): void {
    this.cachedBalance = null;
    this.cachedAt = 0;
  }

  async refresh(): Promise<SolanaBalanceInfo> {
    this.invalidate();
    return this.checkBalance();
  }

  getWalletAddress(): string {
    return this.walletAddress;
  }

  private async fetchBalance(): Promise<bigint> {
    const owner = solAddress(this.walletAddress);
    const mint = solAddress(SOLANA_USDC_MINT);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BALANCE_TIMEOUT_MS);

    try {
      const response = await this.rpc
        .getTokenAccountsByOwner(owner, { mint }, { encoding: "jsonParsed" })
        .send({ abortSignal: controller.signal });

      if (response.value.length === 0) return 0n;

      let total = 0n;
      for (const account of response.value) {
        const parsed = account.account.data as { parsed: { info: { tokenAmount: { amount: string } } } };
        total += BigInt(parsed.parsed.info.tokenAmount.amount);
      }
      return total;
    } catch (err) {
      throw new Error(`Failed to fetch Solana USDC balance: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private buildInfo(balance: bigint): SolanaBalanceInfo {
    const dollars = Number(balance) / 1_000_000;
    return {
      balance,
      balanceUSD: `$${dollars.toFixed(2)}`,
      isLow: balance < 1_000_000n,
      isEmpty: balance < 100n,
      walletAddress: this.walletAddress,
    };
  }
}
