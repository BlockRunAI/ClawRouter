/**
 * Spend Control - Time-windowed spending limits and counterparty policy
 *
 * Absorbed from @blockrun/clawwallet. Chain-agnostic (works for both EVM and Solana).
 *
 * Features:
 * - Per-request limits (e.g., max $0.10 per call)
 * - Hourly limits (e.g., max $3.00 per hour)
 * - Daily limits (e.g., max $20.00 per day)
 * - Session limits (e.g., max $5.00 per session)
 * - Rolling windows (last 1h, last 24h)
 * - Counterparty policy: payee allow/deny, network and asset allowlists
 * - Fail-closed enforcement before the signer, via the x402 pre-sign hook
 * - Persistent storage (~/.openclaw/blockrun/spending.json)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import type { x402Client } from "@x402/fetch";
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

/**
 * Every network the proxy can pay on, as carried on x402
 * `selectedRequirements.network`. Single source of truth for surfaces that
 * validate `allowedNetworks` entries: an entry outside this set can never
 * match a quote and would only block payments.
 */
export const PAYABLE_NETWORKS: readonly string[] = [CAIP2_BASE, CAIP2_SOLANA_MAINNET];

export const POLICY_LISTS: readonly PolicyList[] = [
  "allowedPayees",
  "blockedPayees",
  "allowedNetworks",
  "allowedAssets",
];
/**
 * Lists whose entries are addresses. EVM addresses are case-insensitive hex,
 * so a checksummed entry must match a lowercase one and vice versa. `asset` is
 * a token contract address and belongs here too: on Base, USDC is quoted as
 * `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, and an operator who configures
 * the lowercase form would otherwise have every legitimate payment refused.
 * `allowedNetworks` is deliberately absent — CAIP-2 ids are case-sensitive.
 */
const ADDRESS_LISTS = ["allowedPayees", "blockedPayees", "allowedAssets"] as const;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Lowercase a 20-byte EVM address; leave Solana base58 and other strings alone. */
export function normalizePayee(value: string): string {
  return EVM_ADDRESS.test(value) ? value.toLowerCase() : value;
}

function isAddressList(list: PolicyList): boolean {
  return (ADDRESS_LISTS as readonly string[]).includes(list);
}

/** Normalize a policy list's entries for storage and comparison. */
function normalizePolicyValues(list: PolicyList, values: readonly string[]): string[] {
  return isAddressList(list) ? values.map(normalizePayee) : [...values];
}

/** Policy entries must be a non-empty array of non-empty strings. */
function isValidPolicyValues(values: unknown): values is string[] {
  return Array.isArray(values) && values.every((v) => typeof v === "string" && v.length > 0);
}

function isPolicyList(value: string): value is PolicyList {
  return (POLICY_LISTS as readonly string[]).includes(value);
}

/**
 * A policy list on disk is present but unusable. Thrown rather than swallowed:
 * silently dropping a corrupted allow/deny list would widen what the agent may
 * pay, which is the one direction this file must never fail in. Callers
 * classify on `instanceof`, not on the message text.
 */
export class MalformedSpendPolicyError extends Error {
  constructor(key: string) {
    super(
      `[ClawRouter] refusing to load spending.json: ${key} is malformed; a corrupted policy file must not widen what the agent may pay`,
    );
    this.name = "MalformedSpendPolicyError";
  }
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
  /**
   * Optional: persist history without touching stored limits. Implement it to
   * keep recorded spend from overwriting an operator's policy edits. Falls
   * back to save() when absent.
   */
  saveHistory?(history: SpendRecord[]): void;
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
          if (!isValidPolicyValues(val)) {
            throw new MalformedSpendPolicyError(key);
          }
          // An empty array is how an operator clears a list by hand. Treat it
          // as "not configured" rather than corruption — refusing to start
          // over an empty array would brick the proxy on a legal edit.
          if (val.length === 0) continue;
          limits[key] = normalizePolicyValues(key, val);
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
      if (err instanceof MalformedSpendPolicyError) {
        throw err;
      }
      // A torn or unparseable file loses history, which is safe. It must not
      // also silently drop configured policy lists — but at this point we
      // cannot tell whether any were configured, so say so loudly.
      console.error(
        `[ClawRouter] Failed to load spending data, starting fresh (any configured spend policy is NOT in effect until this file is repaired): ${err}`,
      );
    }
    return null;
  }

  save(data: { limits: SpendLimits; history: SpendRecord[] }): void {
    try {
      if (!fs.existsSync(WALLET_DIR)) {
        fs.mkdirSync(WALLET_DIR, { recursive: true, mode: 0o700 });
      }
      // Write-then-rename: a crash mid-write must not leave truncated JSON.
      // Torn JSON parses as a failure, which drops configured policy lists on
      // the next start — fail-open on exactly the file that must not do that.
      const tmp = `${this.spendingFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.spendingFile);
    } catch (err) {
      console.error(`[ClawRouter] Failed to save spending data: ${err}`);
    }
  }

  /**
   * Persist history while leaving the stored limits exactly as they are on
   * disk. Recording spend must not rewrite policy: the proxy reads limits once
   * at startup, so writing its in-memory copy back on every payment would
   * erase an operator's hand-edit to spending.json seconds after they made it.
   */
  saveHistory(history: SpendRecord[]): void {
    let storedLimits: SpendLimits = {};
    try {
      const current = this.load();
      if (current) storedLimits = current.limits;
    } catch {
      // A malformed policy list on disk: leave the file alone rather than
      // overwrite it with a version that drops what we could not parse.
      return;
    }
    this.save({ limits: storedLimits, history });
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

/**
 * How long an unsettled pre-sign reservation holds budget. Longer than any
 * payment round trip, short enough that a process killed mid-payment does not
 * leave the window shut for the rest of the hour.
 */
const RESERVATION_TTL_MS = 2 * 60 * 1000;

export class SpendControl {
  private limits: SpendLimits = {};
  private history: SpendRecord[] = [];
  private sessionSpent: number = 0;
  private sessionCalls: number = 0;
  private pending = new Map<string, { amount: number; expiresAt: number }>();
  private reservationSeq = 0;
  /** Limits we loaded and have not changed; history-only saves must not clobber operator edits. */
  private limitsDirty = false;
  /** Set when spending.json held an unusable policy list: refuse every payment. */
  private policyFileBroken?: string;
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
    this.limitsDirty = true;
    this.save();
  }

  clearLimit(window: SpendWindow): void {
    delete this.limits[window];
    this.limitsDirty = true;
    this.save();
  }

  setPolicy(list: PolicyList, values: string[]): void {
    if (!isPolicyList(list)) {
      throw new Error(`Unknown policy list: ${String(list)}`);
    }
    if (!isValidPolicyValues(values) || values.length === 0) {
      throw new Error("Policy list must be a non-empty array of non-empty strings");
    }
    this.limits[list] = normalizePolicyValues(list, values);
    this.limitsDirty = true;
    this.save();
  }

  clearPolicy(list: PolicyList): void {
    if (!isPolicyList(list)) {
      throw new Error(`Unknown policy list: ${String(list)}`);
    }
    delete this.limits[list];
    this.limitsDirty = true;
    this.save();
  }

  getLimits(): SpendLimits {
    return cloneLimits(this.limits);
  }

  /**
   * Why spending.json could not be loaded, or undefined when it is usable.
   * While set, every setter mutates memory only: save() refuses to rewrite a
   * file it could not fully parse, so callers must check this before
   * reporting a change as applied.
   */
  getPolicyFileError(): string | undefined {
    return this.policyFileBroken;
  }

  check(estimatedCost: number, counterparty?: CounterpartyInfo): CheckResult {
    if (this.policyFileBroken !== undefined) {
      return {
        allowed: false,
        reason: `Spend policy is unreadable, refusing all payments: ${this.policyFileBroken}`,
      };
    }
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
      if (!this.limits.allowedAssets.includes(normalizePayee(counterparty.asset))) {
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
      const hourlySpent = this.getSpendingInWindow(now - HOUR_MS, now, now);
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
      const dailySpent = this.getSpendingInWindow(now - DAY_MS, now, now);
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
      const sessionSpent = this.sessionSpent + this.pendingTotal();
      const remaining = this.limits.session - sessionSpent;
      if (estimatedCost > remaining) {
        return {
          allowed: false,
          blockedBy: "session",
          remaining,
          reason: `Session limit exceeded: $${(sessionSpent + estimatedCost).toFixed(2)} > $${this.limits.session.toFixed(2)} max`,
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

  /** True when any window that this module can compare an amount against is set. */
  hasAmountLimits(): boolean {
    return (
      this.limits.perRequest !== undefined ||
      this.limits.hourly !== undefined ||
      this.limits.daily !== undefined ||
      this.limits.session !== undefined
    );
  }

  /** True when a window spans more than one request, so reservations matter. */
  hasAggregateLimits(): boolean {
    return (
      this.limits.hourly !== undefined ||
      this.limits.daily !== undefined ||
      this.limits.session !== undefined
    );
  }

  /**
   * Hold `amount` against the aggregate windows before a payment is signed.
   *
   * Reservations live in memory only and are never persisted: an unsettled
   * reservation is not spend, and writing it to disk is what made a failed
   * signer permanently consume budget. They expire on their own so a caller
   * that never settles or releases (process killed mid-payment, a transport
   * that hangs past the payment timeout) cannot wedge the window shut.
   */
  reserve(amount: number): string {
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error("Reservation amount must be a non-negative finite number");
    }
    const id = `${this.now()}-${(this.reservationSeq += 1)}`;
    this.pending.set(id, { amount, expiresAt: this.now() + RESERVATION_TTL_MS });
    return id;
  }

  /** Convert a reservation into recorded spend (the payment was signed). */
  settleReservation(id: string, metadata?: { model?: string; action?: string }): void {
    const held = this.pending.get(id);
    if (!held) return; // already released, settled, or expired
    this.pending.delete(id);
    this.record(held.amount, metadata);
  }

  /** Drop a reservation without recording spend (the payment was never signed). */
  releaseReservation(id: string): void {
    this.pending.delete(id);
  }

  /** Total currently held but not yet settled. */
  private pendingTotal(): number {
    this.expireReservations();
    let total = 0;
    for (const held of this.pending.values()) {
      total += held.amount;
    }
    return total;
  }

  private expireReservations(): void {
    const now = this.now();
    for (const [id, held] of this.pending) {
      if (held.expiresAt <= now) {
        this.pending.delete(id);
      }
    }
  }

  // `now` is the single clock reading the caller already took to build the
  // window; it must be passed in, not re-read here. In-flight reservations are
  // "now" holds, so they count only against a window that reaches the present
  // (`to >= now`). The bug this guards against: reading the clock a SECOND time
  // inside this method (the old `to >= this.now()`) could land a millisecond
  // after the caller's `now`, flip the guard false, and silently drop the
  // pending total from the hourly/daily check — letting two concurrent payments
  // both clear the same remaining budget. Threading the caller's `now` keeps the
  // guard meaningful (a genuinely historical window with `to < now` still
  // excludes live holds) without a second, racing read. Every existing test
  // injects a frozen clock (`now: () => clock`), so the two reads always matched
  // and the sub-ms window went uncaught; see the live-clock test in
  // spend-control.test.ts.
  private getSpendingInWindow(from: number, to: number, now: number): number {
    const recorded = this.history
      .filter((r) => r.timestamp >= from && r.timestamp <= to)
      .reduce((sum, r) => sum + r.amount, 0);
    return recorded + (to >= now ? this.pendingTotal() : 0);
  }

  getSpending(window: "hourly" | "daily" | "session"): number {
    const now = this.now();
    switch (window) {
      case "hourly":
        return this.getSpendingInWindow(now - HOUR_MS, now, now);
      case "daily":
        return this.getSpendingInWindow(now - DAY_MS, now, now);
      case "session":
        return this.sessionSpent + this.pendingTotal();
    }
  }

  getRemaining(window: "hourly" | "daily" | "session"): number | null {
    const limit = this.limits[window];
    if (limit === undefined) return null;
    return Math.max(0, limit - this.getSpending(window));
  }

  getStatus(): SpendingStatus {
    const now = this.now();
    const hourlySpent = this.getSpendingInWindow(now - HOUR_MS, now, now);
    const dailySpent = this.getSpendingInWindow(now - DAY_MS, now, now);

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
        session:
          this.limits.session !== undefined
            ? this.limits.session - (this.sessionSpent + this.pendingTotal())
            : null,
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
    if (this.policyFileBroken !== undefined) {
      return; // never rewrite a file we could not fully parse
    }
    if (!this.limitsDirty && this.storage.saveHistory) {
      this.storage.saveHistory([...this.history]);
      return;
    }
    this.storage.save({
      limits: cloneLimits(this.limits),
      history: [...this.history],
    });
  }

  private load(): void {
    let data: { limits: SpendLimits; history: SpendRecord[] } | null;
    try {
      data = this.storage.load();
    } catch (err) {
      if (!(err instanceof MalformedSpendPolicyError)) throw err;
      // Refuse every paid request rather than either (a) running with the
      // policy silently dropped, or (b) throwing out of the constructor and
      // taking the whole proxy down — which would kill free models too, for a
      // file that only governs payments.
      this.policyFileBroken = err.message;
      console.error(`[ClawRouter] ${err.message}`);
      console.error(
        "[ClawRouter] All paid requests will be refused until spending.json is repaired. Free models are unaffected.",
      );
      return;
    }
    if (data) {
      this.limits = cloneLimits(data.limits);
      this.history = data.history;
      this.cleanup();
    }
  }
}

export type SpendPolicyAbort = { abort: true; reason: string };

/**
 * Thrown from the pre-sign hook when policy or an amount window refuses.
 *
 * A deliberate refusal must never be mistaken for a transient upstream fault:
 * the proxy's fallback loop retries provider errors across every paid model
 * and then silently lands on a free one, which would hide the denial from the
 * caller entirely. Callers classify on `instanceof` (see `proxy.ts`), so the
 * message text is free to change. It keeps the `Payment creation aborted:`
 * prefix that `@x402/core` uses for its own aborts so existing log greps and
 * error matchers still see a familiar string.
 */
export class SpendPolicyError extends Error {
  readonly blockedBy?: SpendWindow;
  readonly blockedByPolicy?: PolicyList;

  constructor(reason: string, blocked?: { blockedBy?: SpendWindow; blockedByPolicy?: PolicyList }) {
    super(`Payment creation aborted: ${reason}`);
    this.name = "SpendPolicyError";
    this.blockedBy = blocked?.blockedBy;
    this.blockedByPolicy = blocked?.blockedByPolicy;
  }
}

/** Server-quoted amounts are canonical decimal micro-USDC strings, nothing else. */
const CANONICAL_AMOUNT = /^\d+$/;

/**
 * Read the payment amount the signer is about to authorize, in USD.
 *
 * `Number.parseInt(v, 10)` is NOT safe here. `@x402/core` validates `amount`
 * as a non-empty string with no digit-format check, while the EVM exact scheme
 * signs `BigInt(value)` off the same raw string — and the two disagree on every
 * radix prefix `BigInt` accepts:
 *
 *   parseInt("0x1DCD6500", 10) === 0   BigInt("0x1DCD6500") === 500000000n
 *
 * A gateway quoting hex therefore reads as $0.000000 against every cap while
 * the wallet authorizes the full amount. Returns undefined for anything that
 * is not a canonical decimal integer so the caller can fail closed.
 *
 * x402 v1 carries the cost in `maxAmountRequired`; v2 renamed it to `amount`.
 */
function parseQuotedAmountUsd(selected: {
  amount?: string;
  maxAmountRequired?: string;
}): number | undefined {
  const raw = selected.amount ?? selected.maxAmountRequired;
  if (typeof raw !== "string" || !CANONICAL_AMOUNT.test(raw)) {
    return undefined;
  }
  const micros = Number(raw);
  if (!Number.isSafeInteger(micros)) {
    return undefined;
  }
  return micros / 1_000_000;
}

/** Requirements as they reach the pre-sign hook (v2 `amount`, v1 `maxAmountRequired`). */
export type QuotedRequirements = {
  payTo?: string;
  network?: string;
  asset?: string;
  amount?: string;
  maxAmountRequired?: string;
};

/**
 * Evaluate policy and amount windows for a pending payment.
 *
 * Returns a reservation id when the payment may proceed and an aggregate
 * window is configured; the caller must settle or release it. Throws
 * `SpendPolicyError` when the payment must not be signed.
 */
export function assertSpendPolicyAllows(
  control: SpendControl,
  selected: QuotedRequirements,
): string | undefined {
  const quoted = parseQuotedAmountUsd(selected);
  if (quoted === undefined && control.hasAmountLimits()) {
    // Fail closed: we cannot compare an amount we could not parse against a
    // cap the operator configured.
    throw new SpendPolicyError(
      `Payment quote carries no usable amount (${JSON.stringify(
        selected.amount ?? selected.maxAmountRequired,
      )}); refusing to sign against a configured spend limit`,
    );
  }
  const estimatedCost = quoted ?? 0;
  const result = control.check(estimatedCost, {
    payTo: selected.payTo,
    network: selected.network,
    asset: selected.asset,
  });
  if (!result.allowed) {
    throw new SpendPolicyError(result.reason ?? "blocked by spend policy", {
      blockedBy: result.blockedBy,
      blockedByPolicy: result.blockedByPolicy,
    });
  }
  if (!control.hasAggregateLimits()) {
    return undefined;
  }
  // Reserve synchronously — no await between check() and reserve() — so two
  // concurrent payments cannot both clear the same remaining budget.
  return control.reserve(estimatedCost);
}

/**
 * Register the fail-closed spend-policy hook on an x402 client.
 *
 * Reservations are keyed on the `selectedRequirements` object, which
 * `@x402/core` passes by reference to the before / after / failure hooks of
 * the same `createPaymentPayload` call, so concurrent payments never settle
 * each other's reservation.
 */
export function registerSpendPolicyHook(x402: x402Client, control: SpendControl): void {
  const reservations = new WeakMap<object, string>();

  x402.onBeforePaymentCreation(async (ctx) => {
    const selected = ctx.selectedRequirements as unknown as QuotedRequirements;
    const reservationId = assertSpendPolicyAllows(control, selected);
    if (reservationId !== undefined) {
      reservations.set(ctx.selectedRequirements as unknown as object, reservationId);
    }
  });

  // Signed: the wallet has authorized this payment, so the reservation becomes
  // real spend. Conservative by design — a payment that is signed but never
  // settles upstream still counts against the window.
  x402.onAfterPaymentCreation(async (ctx) => {
    const key = ctx.selectedRequirements as unknown as object;
    const id = reservations.get(key);
    if (id !== undefined) {
      reservations.delete(key);
      control.settleReservation(id, { action: "x402 payment" });
    }
  });

  // Never signed: release, or the window drains on failures that cost nothing.
  x402.onPaymentCreationFailure(async (ctx) => {
    const key = ctx.selectedRequirements as unknown as object;
    const id = reservations.get(key);
    if (id !== undefined) {
      reservations.delete(key);
      control.releaseReservation(id);
    }
  });
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
