/**
 * Spend Control - Time-windowed spending limits
 *
 * Absorbed from @blockrun/clawwallet. Chain-agnostic (works for both EVM and Solana).
 *
 * Features:
 * - Per-request limits (e.g., max $0.10 per call)
 * - Hourly limits (e.g., max $3.00 per hour)
 * - Daily limits (e.g., max $20.00 per day)
 * - Session limits (e.g., max $5.00 per session)
 * - Rolling windows (last 1h, last 24h)
 * - Persistent storage (~/.openclaw/blockrun/spending.json)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { readTextFileSync } from "./fs-read.js";

const WALLET_DIR = path.join(homedir(), ".openclaw", "blockrun");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export type SpendWindow = "perRequest" | "hourly" | "daily" | "session";

/**
 * Counterparty/network/asset allow-or-deny lists. Default-off: a list only
 * takes effect once configured via setPolicy(). `allowedPayees`/`blockedPayees`
 * are both supported (block always wins if both are set); network and asset
 * are allowlist-only, matching what a caller can realistically enumerate.
 */
export type PolicyList = "allowedPayees" | "blockedPayees" | "allowedNetworks" | "allowedAssets";

/** Base mainnet, as carried on x402 `selectedRequirements.network`. */
export const CAIP2_BASE = "eip155:8453";
/** Solana mainnet genesis, as carried on x402 `selectedRequirements.network`. */
export const CAIP2_SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

const POLICY_LISTS: readonly PolicyList[] = [
  "allowedPayees",
  "blockedPayees",
  "allowedNetworks",
  "allowedAssets",
];
const PAYEE_LISTS = ["allowedPayees", "blockedPayees"] as const;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Lowercase a 20-byte EVM address; leave Solana base58 and other strings alone. */
export function normalizePayee(value: string): string {
  return EVM_ADDRESS.test(value) ? value.toLowerCase() : value;
}

function isPolicyList(value: string): value is PolicyList {
  return (POLICY_LISTS as readonly string[]).includes(value);
}

export interface SpendLimits {
  perRequest?: number;
  hourly?: number;
  daily?: number;
  session?: number;
  allowedPayees?: string[];
  blockedPayees?: string[];
  /**
   * CAIP-2 identifiers matching x402 `selectedRequirements.network`
   * (e.g. `eip155:8453`, `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`).
   * Nicknames such as `base` or `solana` do not match and fail closed.
   */
  allowedNetworks?: string[];
  allowedAssets?: string[];
}

/** Defensive copy: the four policy fields are arrays, so a shallow `{...limits}` still shares them by reference. */
function cloneLimits(limits: SpendLimits): SpendLimits {
  const clone: SpendLimits = { ...limits };
  for (const key of POLICY_LISTS) {
    const val = limits[key];
    if (val !== undefined) {
      clone[key] = [...val];
    }
  }
  return clone;
}

/**
 * Counterparty details for a pending payment, passed to check() alongside
 * the estimated cost. EVM `payTo` values matching `0x` + 40 hex are compared
 * case-insensitively; anything else (including Solana base58) is exact-match.
 */
export interface CounterpartyInfo {
  payTo?: string;
  network?: string;
  asset?: string;
}

export interface SpendRecord {
  timestamp: number;
  amount: number;
  model?: string;
  action?: string;
}

export interface SpendingStatus {
  limits: SpendLimits;
  spending: {
    hourly: number;
    daily: number;
    session: number;
  };
  remaining: {
    hourly: number | null;
    daily: number | null;
    session: number | null;
  };
  calls: number;
}

export interface CheckResult {
  allowed: boolean;
  blockedBy?: SpendWindow;
  blockedByPolicy?: PolicyList;
  remaining?: number;
  reason?: string;
  resetIn?: number;
}

export interface SpendControlStorage {
  load(): { limits: SpendLimits; history: SpendRecord[] } | null;
  save(data: { limits: SpendLimits; history: SpendRecord[] }): void;
}

export class FileSpendControlStorage implements SpendControlStorage {
  private readonly spendingFile: string;

  constructor() {
    this.spendingFile = path.join(WALLET_DIR, "spending.json");
  }

  load(): { limits: SpendLimits; history: SpendRecord[] } | null {
    try {
      if (fs.existsSync(this.spendingFile)) {
        const data = JSON.parse(readTextFileSync(this.spendingFile));
        const rawLimits = data.limits ?? {};
        const rawHistory = data.history ?? [];

        const limits: SpendLimits = {};
        for (const key of ["perRequest", "hourly", "daily", "session"] as const) {
          const val = rawLimits[key];
          if (typeof val === "number" && val > 0 && Number.isFinite(val)) {
            limits[key] = val;
          }
        }
        for (const key of POLICY_LISTS) {
          if (!Object.prototype.hasOwnProperty.call(rawLimits, key)) continue;
          const val = rawLimits[key];
          if (
            !Array.isArray(val) ||
            val.length === 0 ||
            val.some((v) => typeof v !== "string" || v.length === 0)
          ) {
            throw new Error(
              `[ClawRouter] refusing to load spending.json: ${key} is malformed; a corrupted policy file must not widen what the agent may pay`,
            );
          }
          limits[key] = PAYEE_LISTS.includes(key as (typeof PAYEE_LISTS)[number])
            ? val.map(normalizePayee)
            : [...val];
        }

        const history: SpendRecord[] = [];
        if (Array.isArray(rawHistory)) {
          for (const r of rawHistory) {
            if (
              typeof r?.timestamp === "number" &&
              typeof r?.amount === "number" &&
              Number.isFinite(r.timestamp) &&
              Number.isFinite(r.amount) &&
              r.amount >= 0
            ) {
              history.push({
                timestamp: r.timestamp,
                amount: r.amount,
                model: typeof r.model === "string" ? r.model : undefined,
                action: typeof r.action === "string" ? r.action : undefined,
              });
            }
          }
        }

        return { limits, history };
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("refusing to load spending.json")) {
        throw err;
      }
      console.error(`[ClawRouter] Failed to load spending data, starting fresh: ${err}`);
    }
    return null;
  }

  save(data: { limits: SpendLimits; history: SpendRecord[] }): void {
    try {
      if (!fs.existsSync(WALLET_DIR)) {
        fs.mkdirSync(WALLET_DIR, { recursive: true, mode: 0o700 });
      }
      fs.writeFileSync(this.spendingFile, JSON.stringify(data, null, 2), {
        mode: 0o600,
      });
    } catch (err) {
      console.error(`[ClawRouter] Failed to save spending data: ${err}`);
    }
  }
}

export class InMemorySpendControlStorage implements SpendControlStorage {
  private data: { limits: SpendLimits; history: SpendRecord[] } | null = null;

  load(): { limits: SpendLimits; history: SpendRecord[] } | null {
    return this.data
      ? {
          limits: cloneLimits(this.data.limits),
          history: this.data.history.map((r) => ({ ...r })),
        }
      : null;
  }

  save(data: { limits: SpendLimits; history: SpendRecord[] }): void {
    this.data = {
      limits: cloneLimits(data.limits),
      history: data.history.map((r) => ({ ...r })),
    };
  }
}

export interface SpendControlOptions {
  storage?: SpendControlStorage;
  now?: () => number;
}

export class SpendControl {
  private limits: SpendLimits = {};
  private history: SpendRecord[] = [];
  private sessionSpent: number = 0;
  private sessionCalls: number = 0;
  private readonly storage: SpendControlStorage;
  private readonly now: () => number;

  constructor(options?: SpendControlOptions) {
    this.storage = options?.storage ?? new FileSpendControlStorage();
    this.now = options?.now ?? (() => Date.now());
    this.load();
  }

  setLimit(window: SpendWindow, amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error("Limit must be a finite positive number");
    }
    this.limits[window] = amount;
    this.save();
  }

  clearLimit(window: SpendWindow): void {
    delete this.limits[window];
    this.save();
  }

  setPolicy(list: PolicyList, values: string[]): void {
    if (!isPolicyList(list)) {
      throw new Error(`Unknown policy list: ${String(list)}`);
    }
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      values.some((v) => typeof v !== "string" || v.length === 0)
    ) {
      throw new Error("Policy list must be a non-empty array of non-empty strings");
    }
    this.limits[list] = PAYEE_LISTS.includes(list as (typeof PAYEE_LISTS)[number])
      ? values.map(normalizePayee)
      : [...values];
    this.save();
  }

  clearPolicy(list: PolicyList): void {
    if (!isPolicyList(list)) {
      throw new Error(`Unknown policy list: ${String(list)}`);
    }
    delete this.limits[list];
    this.save();
  }

  getLimits(): SpendLimits {
    return cloneLimits(this.limits);
  }

  check(estimatedCost: number, counterparty?: CounterpartyInfo): CheckResult {
    const payeePolicySet =
      (this.limits.blockedPayees && this.limits.blockedPayees.length > 0) ||
      (this.limits.allowedPayees && this.limits.allowedPayees.length > 0);
    if (payeePolicySet) {
      if (counterparty?.payTo === undefined) {
        return {
          allowed: false,
          blockedByPolicy: this.limits.blockedPayees?.length ? "blockedPayees" : "allowedPayees",
          reason: "Payee policy is configured but no payTo was provided to check()",
        };
      }
      const payTo = normalizePayee(counterparty.payTo);
      if (this.limits.blockedPayees?.includes(payTo)) {
        return {
          allowed: false,
          blockedByPolicy: "blockedPayees",
          reason: `Payee is blocked by policy: ${counterparty.payTo}`,
        };
      }
      if (
        this.limits.allowedPayees &&
        this.limits.allowedPayees.length > 0 &&
        !this.limits.allowedPayees.includes(payTo)
      ) {
        return {
          allowed: false,
          blockedByPolicy: "allowedPayees",
          reason: `Payee is not in the configured allowlist: ${counterparty.payTo}`,
        };
      }
    }

    if (this.limits.allowedNetworks && this.limits.allowedNetworks.length > 0) {
      if (counterparty?.network === undefined) {
        return {
          allowed: false,
          blockedByPolicy: "allowedNetworks",
          reason: "Network policy is configured but no network was provided to check()",
        };
      }
      if (!this.limits.allowedNetworks.includes(counterparty.network)) {
        return {
          allowed: false,
          blockedByPolicy: "allowedNetworks",
          reason: `Network is not in the configured allowlist: ${counterparty.network}`,
        };
      }
    }

    if (this.limits.allowedAssets && this.limits.allowedAssets.length > 0) {
      if (counterparty?.asset === undefined) {
        return {
          allowed: false,
          blockedByPolicy: "allowedAssets",
          reason: "Asset policy is configured but no asset was provided to check()",
        };
      }
      if (!this.limits.allowedAssets.includes(counterparty.asset)) {
        return {
          allowed: false,
          blockedByPolicy: "allowedAssets",
          reason: `Asset is not in the configured allowlist: ${counterparty.asset}`,
        };
      }
    }

    const now = this.now();

    if (this.limits.perRequest !== undefined) {
      if (estimatedCost > this.limits.perRequest) {
        return {
          allowed: false,
          blockedBy: "perRequest",
          remaining: this.limits.perRequest,
          reason: `Per-request limit exceeded: $${estimatedCost.toFixed(4)} > $${this.limits.perRequest.toFixed(2)} max`,
        };
      }
    }

    if (this.limits.hourly !== undefined) {
      const hourlySpent = this.getSpendingInWindow(now - HOUR_MS, now);
      const remaining = this.limits.hourly - hourlySpent;
      if (estimatedCost > remaining) {
        const oldestInWindow = this.history.find((r) => r.timestamp >= now - HOUR_MS);
        const resetIn = oldestInWindow
          ? Math.ceil((oldestInWindow.timestamp + HOUR_MS - now) / 1000)
          : 0;
        return {
          allowed: false,
          blockedBy: "hourly",
          remaining,
          reason: `Hourly limit exceeded: $${(hourlySpent + estimatedCost).toFixed(2)} > $${this.limits.hourly.toFixed(2)} max`,
          resetIn,
        };
      }
    }

    if (this.limits.daily !== undefined) {
      const dailySpent = this.getSpendingInWindow(now - DAY_MS, now);
      const remaining = this.limits.daily - dailySpent;
      if (estimatedCost > remaining) {
        const oldestInWindow = this.history.find((r) => r.timestamp >= now - DAY_MS);
        const resetIn = oldestInWindow
          ? Math.ceil((oldestInWindow.timestamp + DAY_MS - now) / 1000)
          : 0;
        return {
          allowed: false,
          blockedBy: "daily",
          remaining,
          reason: `Daily limit exceeded: $${(dailySpent + estimatedCost).toFixed(2)} > $${this.limits.daily.toFixed(2)} max`,
          resetIn,
        };
      }
    }

    if (this.limits.session !== undefined) {
      const remaining = this.limits.session - this.sessionSpent;
      if (estimatedCost > remaining) {
        return {
          allowed: false,
          blockedBy: "session",
          remaining,
          reason: `Session limit exceeded: $${(this.sessionSpent + estimatedCost).toFixed(2)} > $${this.limits.session.toFixed(2)} max`,
        };
      }
    }

    return { allowed: true };
  }

  record(amount: number, metadata?: { model?: string; action?: string }): void {
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error("Record amount must be a non-negative finite number");
    }
    const record: SpendRecord = {
      timestamp: this.now(),
      amount,
      model: metadata?.model,
      action: metadata?.action,
    };

    this.history.push(record);
    this.sessionSpent += amount;
    this.sessionCalls += 1;

    this.cleanup();
    this.save();
  }

  private getSpendingInWindow(from: number, to: number): number {
    return this.history
      .filter((r) => r.timestamp >= from && r.timestamp <= to)
      .reduce((sum, r) => sum + r.amount, 0);
  }

  getSpending(window: "hourly" | "daily" | "session"): number {
    const now = this.now();
    switch (window) {
      case "hourly":
        return this.getSpendingInWindow(now - HOUR_MS, now);
      case "daily":
        return this.getSpendingInWindow(now - DAY_MS, now);
      case "session":
        return this.sessionSpent;
    }
  }

  getRemaining(window: "hourly" | "daily" | "session"): number | null {
    const limit = this.limits[window];
    if (limit === undefined) return null;
    return Math.max(0, limit - this.getSpending(window));
  }

  getStatus(): SpendingStatus {
    const now = this.now();
    const hourlySpent = this.getSpendingInWindow(now - HOUR_MS, now);
    const dailySpent = this.getSpendingInWindow(now - DAY_MS, now);

    return {
      limits: cloneLimits(this.limits),
      spending: {
        hourly: hourlySpent,
        daily: dailySpent,
        session: this.sessionSpent,
      },
      remaining: {
        hourly: this.limits.hourly !== undefined ? this.limits.hourly - hourlySpent : null,
        daily: this.limits.daily !== undefined ? this.limits.daily - dailySpent : null,
        session: this.limits.session !== undefined ? this.limits.session - this.sessionSpent : null,
      },
      calls: this.sessionCalls,
    };
  }

  getHistory(limit?: number): SpendRecord[] {
    const records = [...this.history].reverse();
    return limit ? records.slice(0, limit) : records;
  }

  resetSession(): void {
    this.sessionSpent = 0;
    this.sessionCalls = 0;
  }

  private cleanup(): void {
    const cutoff = this.now() - DAY_MS;
    this.history = this.history.filter((r) => r.timestamp >= cutoff);
  }

  private save(): void {
    this.storage.save({
      limits: cloneLimits(this.limits),
      history: [...this.history],
    });
  }

  private load(): void {
    const data = this.storage.load();
    if (data) {
      this.limits = cloneLimits(data.limits);
      this.history = data.history;
      this.cleanup();
    }
  }
}

export type SpendPolicyAbort = { abort: true; reason: string };

/**
 * Return an x402 `onBeforePaymentCreation` abort when policy or amount
 * windows refuse. Aggregate-window amounts are reserved synchronously before
 * the scheme signer runs so concurrent requests cannot all pass against the
 * same remaining budget. The conservative reservation remains if a later
 * signer or transport step fails.
 */
export function abortIfSpendPolicyBlocks(
  control: SpendControl,
  selected: { payTo?: string; network?: string; asset?: string; amount?: string },
): SpendPolicyAbort | undefined {
  const micros = Number.parseInt(selected.amount ?? "0", 10);
  const estimatedCost = Number.isFinite(micros) ? micros / 1_000_000 : 0;
  const result = control.check(estimatedCost, {
    payTo: selected.payTo,
    network: selected.network,
    asset: selected.asset,
  });
  if (!result.allowed) {
    return { abort: true, reason: result.reason ?? "blocked by spend policy" };
  }
  const limits = control.getLimits();
  if (limits.hourly !== undefined || limits.daily !== undefined || limits.session !== undefined) {
    control.record(estimatedCost, { action: "x402 pre-sign reservation" });
  }
  return undefined;
}

/** Register the fail-closed spend-policy hook on an x402 client. */
export function registerSpendPolicyHook(
  x402: {
    onBeforePaymentCreation(
      hook: (ctx: {
        selectedRequirements: {
          payTo?: string;
          network?: string;
          asset?: string;
          amount?: string;
        };
      }) => Promise<void | SpendPolicyAbort>,
    ): unknown;
  },
  control: SpendControl,
): void {
  x402.onBeforePaymentCreation(async (ctx) =>
    abortIfSpendPolicyBlocks(control, ctx.selectedRequirements),
  );
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  } else if (seconds < 3600) {
    const mins = Math.ceil(seconds / 60);
    return `${mins} min`;
  } else {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.ceil((seconds % 3600) / 60);
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }
}
