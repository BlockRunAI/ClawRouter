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

const WALLET_DIR = path.join(homedir(), ".openclaw", "blockrun");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export type SpendWindow = "perRequest" | "hourly" | "daily" | "session";

export interface SpendLimits {
  perRequest?: number;
  hourly?: number;
  daily?: number;
  session?: number;
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
        const data = JSON.parse(fs.readFileSync(this.spendingFile, "utf-8"));
        const rawLimits = data.limits ?? {};
        const rawHistory = data.history ?? [];

        const limits: SpendLimits = {};
        for (const key of ["perRequest", "hourly", "daily", "session"] as const) {
          const val = rawLimits[key];
          if (typeof val === "number" && val > 0 && Number.isFinite(val)) {
            limits[key] = val;
          }
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
          limits: { ...this.data.limits },
          history: this.data.history.map((r) => ({ ...r })),
        }
      : null;
  }

  save(data: { limits: SpendLimits; history: SpendRecord[] }): void {
    this.data = {
      limits: { ...data.limits },
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

  getLimits(): SpendLimits {
    return { ...this.limits };
  }

  check(estimatedCost: number): CheckResult {
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
      limits: { ...this.limits },
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
      limits: { ...this.limits },
      history: [...this.history],
    });
  }

  private load(): void {
    const data = this.storage.load();
    if (data) {
      this.limits = data.limits;
      this.history = data.history;
      this.cleanup();
    }
  }
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
