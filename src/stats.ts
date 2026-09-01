/**
 * Usage Statistics Aggregator
 *
 * Reads usage log files and aggregates statistics for terminal display.
 * Supports filtering by date range and provides multiple aggregation views.
 */

import { readdir, unlink } from "node:fs/promises";
import { readTextFile } from "./fs-read.js";
import { join } from "node:path";
import { homedir } from "node:os";
import type { UsageEntry } from "./logger.js";
import { VERSION } from "./version.js";

const LOG_DIR = join(homedir(), ".openclaw", "blockrun", "logs");

/** Default reporting window when the request declares no usable `days`. */
export const DEFAULT_STATS_DAYS = 7;
/** Hard cap on the window — only this many daily log files are ever read. */
export const MAX_STATS_DAYS = 30;

/**
 * Resolve the reporting window (`?days=`) for the /stats endpoint.
 *
 * The raw value is user-controlled, so it has to survive the ways JS silently
 * coerces bad input into a number that changes behaviour. `parseInt("abc", 10)`
 * is `NaN`, `Math.min(NaN, 30)` stays `NaN`, and `getStats`' `slice(0, NaN)`
 * reads as `slice(0, 0)` — so a typo'd param reported zero usage instead of the
 * default window. A negative value (`?days=-1`) survived `Math.min` and
 * `slice(0, -1)` dropped the newest day while the response mislabelled itself
 * "last -1 days". The single `Number.isFinite(parsed) && parsed > 0` guard
 * covers non-numeric, NaN, zero, and negative alike; anything else falls back to
 * the default. The result is clamped to MAX_STATS_DAYS.
 */
export function resolveStatsDays(raw: string | null | undefined): number {
  const parsed = parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_STATS_DAYS;
  }
  return Math.min(parsed, MAX_STATS_DAYS);
}

export type DailyStats = {
  date: string;
  totalRequests: number;
  totalCost: number;
  totalBaselineCost: number;
  totalSavings: number;
  avgLatencyMs: number;
  byTier: Record<string, { count: number; cost: number }>;
  byModel: Record<string, { count: number; cost: number }>;
};

export type AggregatedStats = {
  period: string;
  totalRequests: number;
  totalCost: number;
  totalBaselineCost: number;
  totalSavings: number;
  savingsPercentage: number;
  avgLatencyMs: number;
  avgCostPerRequest: number;
  byTier: Record<string, { count: number; cost: number; percentage: number }>;
  byModel: Record<string, { count: number; cost: number; percentage: number }>;
  dailyBreakdown: DailyStats[];
  entriesWithBaseline: number; // Entries with valid baseline tracking
};

/**
 * Parse a JSONL log file into usage entries.
 * Handles both old format (without tier/baselineCost) and new format.
 */
async function parseLogFile(filePath: string): Promise<UsageEntry[]> {
  try {
    const content = await readTextFile(filePath);
    const lines = content.trim().split("\n").filter(Boolean);
    const entries: UsageEntry[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as Partial<UsageEntry>;
        entries.push({
          timestamp: entry.timestamp || new Date().toISOString(),
          model: entry.model || "unknown",
          tier: entry.tier || "UNKNOWN",
          cost: entry.cost || 0,
          baselineCost: entry.baselineCost || entry.cost || 0,
          savings: entry.savings || 0,
          latencyMs: entry.latencyMs || 0,
        });
      } catch {
        // Skip malformed lines, keep valid ones
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Get list of available log files sorted by date (newest first).
 */
async function getLogFiles(): Promise<string[]> {
  try {
    const files = await readdir(LOG_DIR);
    return files
      .filter((f) => f.startsWith("usage-") && f.endsWith(".jsonl"))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * Aggregate stats for a single day.
 */
function aggregateDay(date: string, entries: UsageEntry[]): DailyStats {
  const byTier: Record<string, { count: number; cost: number }> = {};
  const byModel: Record<string, { count: number; cost: number }> = {};
  let totalLatency = 0;

  for (const entry of entries) {
    // By tier
    if (!byTier[entry.tier]) byTier[entry.tier] = { count: 0, cost: 0 };
    byTier[entry.tier].count++;
    byTier[entry.tier].cost += entry.cost;

    // By model
    if (!byModel[entry.model]) byModel[entry.model] = { count: 0, cost: 0 };
    byModel[entry.model].count++;
    byModel[entry.model].cost += entry.cost;

    totalLatency += entry.latencyMs;
  }

  const totalCost = entries.reduce((sum, e) => sum + e.cost, 0);
  const totalBaselineCost = entries.reduce((sum, e) => sum + e.baselineCost, 0);

  return {
    date,
    totalRequests: entries.length,
    totalCost,
    totalBaselineCost,
    totalSavings: totalBaselineCost - totalCost,
    avgLatencyMs: entries.length > 0 ? totalLatency / entries.length : 0,
    byTier,
    byModel,
  };
}

/**
 * Get aggregated statistics for the last N days.
 */
export async function getStats(days: number = 7): Promise<AggregatedStats> {
  const logFiles = await getLogFiles();
  const filesToRead = logFiles.slice(0, days);

  const dailyBreakdown: DailyStats[] = [];
  const allByTier: Record<string, { count: number; cost: number }> = {};
  const allByModel: Record<string, { count: number; cost: number }> = {};
  let totalRequests = 0;
  let totalCost = 0;
  let totalBaselineCost = 0;
  let totalLatency = 0;

  for (const file of filesToRead) {
    const date = file.replace("usage-", "").replace(".jsonl", "");
    const filePath = join(LOG_DIR, file);
    const entries = await parseLogFile(filePath);

    if (entries.length === 0) continue;

    const dayStats = aggregateDay(date, entries);
    dailyBreakdown.push(dayStats);

    totalRequests += dayStats.totalRequests;
    totalCost += dayStats.totalCost;
    totalBaselineCost += dayStats.totalBaselineCost;
    totalLatency += dayStats.avgLatencyMs * dayStats.totalRequests;

    // Merge tier stats
    for (const [tier, stats] of Object.entries(dayStats.byTier)) {
      if (!allByTier[tier]) allByTier[tier] = { count: 0, cost: 0 };
      allByTier[tier].count += stats.count;
      allByTier[tier].cost += stats.cost;
    }

    // Merge model stats
    for (const [model, stats] of Object.entries(dayStats.byModel)) {
      if (!allByModel[model]) allByModel[model] = { count: 0, cost: 0 };
      allByModel[model].count += stats.count;
      allByModel[model].cost += stats.cost;
    }
  }

  // Calculate percentages
  const byTierWithPercentage: Record<string, { count: number; cost: number; percentage: number }> =
    {};
  for (const [tier, stats] of Object.entries(allByTier)) {
    byTierWithPercentage[tier] = {
      ...stats,
      percentage: totalRequests > 0 ? (stats.count / totalRequests) * 100 : 0,
    };
  }

  const byModelWithPercentage: Record<string, { count: number; cost: number; percentage: number }> =
    {};
  for (const [model, stats] of Object.entries(allByModel)) {
    byModelWithPercentage[model] = {
      ...stats,
      percentage: totalRequests > 0 ? (stats.count / totalRequests) * 100 : 0,
    };
  }

  const totalSavings = totalBaselineCost - totalCost;
  const savingsPercentage = totalBaselineCost > 0 ? (totalSavings / totalBaselineCost) * 100 : 0;

  // Count entries with valid baseline tracking (baseline != cost means tracking was active)
  let entriesWithBaseline = 0;
  for (const day of dailyBreakdown) {
    if (day.totalBaselineCost !== day.totalCost) {
      entriesWithBaseline += day.totalRequests;
    }
  }

  return {
    period: days === 1 ? "today" : `last ${days} days`,
    totalRequests,
    totalCost,
    totalBaselineCost,
    totalSavings,
    savingsPercentage,
    avgLatencyMs: totalRequests > 0 ? totalLatency / totalRequests : 0,
    avgCostPerRequest: totalRequests > 0 ? totalCost / totalRequests : 0,
    byTier: byTierWithPercentage,
    byModel: byModelWithPercentage,
    dailyBreakdown: dailyBreakdown.reverse(), // Oldest first for charts
    entriesWithBaseline, // How many entries have valid baseline tracking
  };
}

/**
 * Format stats as ASCII table for terminal display.
 */
export function formatStatsAscii(stats: AggregatedStats): string {
  const lines: string[] = [];

  // Header
  lines.push("╔════════════════════════════════════════════════════════════╗");
  lines.push(`║          ClawRouter by BlockRun v${VERSION}`.padEnd(61) + "║");
  lines.push("║                Usage Statistics                            ║");
  lines.push("╠════════════════════════════════════════════════════════════╣");

  // Summary
  lines.push(`║  Period: ${stats.period.padEnd(49)}║`);
  lines.push(`║  Total Requests: ${stats.totalRequests.toString().padEnd(41)}║`);
  lines.push(`║  Total Cost: $${stats.totalCost.toFixed(4).padEnd(43)}║`);
  lines.push(`║  Baseline Cost (Opus 4.5): $${stats.totalBaselineCost.toFixed(4).padEnd(30)}║`);

  // Show savings with note if some entries lack baseline tracking
  const savingsLine = `║  💰 Total Saved: $${stats.totalSavings.toFixed(4)} (${stats.savingsPercentage.toFixed(1)}%)`;
  if (stats.entriesWithBaseline < stats.totalRequests && stats.entriesWithBaseline > 0) {
    lines.push(savingsLine.padEnd(61) + "║");
    const note = `║     (based on ${stats.entriesWithBaseline}/${stats.totalRequests} tracked requests)`;
    lines.push(note.padEnd(61) + "║");
  } else {
    lines.push(savingsLine.padEnd(61) + "║");
  }
  lines.push(`║  Avg Latency: ${stats.avgLatencyMs.toFixed(0)}ms`.padEnd(61) + "║");

  // Tier breakdown
  lines.push("╠════════════════════════════════════════════════════════════╣");
  lines.push("║  Routing by Tier:                                          ║");

  // Show all tiers found in data, ordered by known tiers first then others
  const knownTiers = ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING", "DIRECT"];
  const allTiers = Object.keys(stats.byTier);
  const otherTiers = allTiers.filter((t) => !knownTiers.includes(t));
  const tierOrder = [...knownTiers.filter((t) => stats.byTier[t]), ...otherTiers];

  for (const tier of tierOrder) {
    const data = stats.byTier[tier];
    if (data) {
      const bar = "█".repeat(Math.min(20, Math.round(data.percentage / 5)));
      const displayTier = tier === "UNKNOWN" ? "OTHER" : tier;
      const line = `║    ${displayTier.padEnd(10)} ${bar.padEnd(20)} ${data.percentage.toFixed(1).padStart(5)}% (${data.count})`;
      lines.push(line.padEnd(61) + "║");
    }
  }

  // Top models
  lines.push("╠════════════════════════════════════════════════════════════╣");
  lines.push("║  Top Models:                                               ║");

  const sortedModels = Object.entries(stats.byModel)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5);

  for (const [model, data] of sortedModels) {
    const shortModel = model.length > 25 ? model.slice(0, 22) + "..." : model;
    const line = `║    ${shortModel.padEnd(25)} ${data.count.toString().padStart(5)} reqs  $${data.cost.toFixed(4)}`;
    lines.push(line.padEnd(61) + "║");
  }

  // Daily breakdown (last 7 days)
  if (stats.dailyBreakdown.length > 0) {
    lines.push("╠════════════════════════════════════════════════════════════╣");
    lines.push("║  Daily Breakdown:                                          ║");
    lines.push("║    Date        Requests    Cost      Saved                 ║");

    for (const day of stats.dailyBreakdown.slice(-7)) {
      const saved = day.totalBaselineCost - day.totalCost;
      const line = `║    ${day.date}   ${day.totalRequests.toString().padStart(6)}    $${day.totalCost.toFixed(4).padStart(8)}  $${saved.toFixed(4)}`;
      lines.push(line.padEnd(61) + "║");
    }
  }

  lines.push("╚════════════════════════════════════════════════════════════╝");

  return lines.join("\n");
}

/**
 * Format per-request log entries as an ASCII table for terminal display.
 * Reads the last N days of log files and shows each request individually.
 */
export async function formatRecentLogs(requestedDays: number = 1): Promise<string> {
  // `days` reaches here straight from `clawrouter logs --days <n>`, where
  // `parseInt(raw, 10) || 1` lets a negative through (it is truthy). A negative
  // then turns `slice(0, days)` into a tail-trim — `slice(0, -1)` silently drops
  // the NEWEST day, the exact opposite of asking for more history — and the
  // header renders "last -1 days". Guard at the sink so every caller is covered,
  // not just the CLI one.
  const days = Number.isFinite(requestedDays) && requestedDays > 0 ? Math.floor(requestedDays) : 1;

  const logFiles = await getLogFiles();
  const filesToRead = logFiles.slice(0, days);

  const allEntries: UsageEntry[] = [];
  for (const file of filesToRead) {
    const entries = await parseLogFile(join(LOG_DIR, file));
    allEntries.push(...entries);
  }

  // Sort chronologically (oldest first)
  allEntries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const lines: string[] = [];
  lines.push("╔════════════════════════════════════════════════════════════════════════╗");
  lines.push(
    `║  ClawRouter Request Log — last ${days === 1 ? "24h" : `${days} days`}`.padEnd(72) + "║",
  );
  lines.push("╠══════════════════╦══════════════════════════╦═════════╦══════╦════════╣");
  lines.push("║  Time            ║  Model                   ║  Cost   ║  ms  ║ Status ║");
  lines.push("╠══════════════════╬══════════════════════════╬═════════╬══════╬════════╣");

  if (allEntries.length === 0) {
    lines.push("║  No requests found".padEnd(72) + "║");
  }

  let totalCost = 0;
  for (const e of allEntries) {
    const time = e.timestamp.slice(11, 19); // HH:MM:SS
    const date = e.timestamp.slice(5, 10); // MM-DD
    const displayTime = `${date} ${time}`;
    const model = e.model.length > 24 ? e.model.slice(0, 21) + "..." : e.model;
    const cost = `$${e.cost.toFixed(4)}`;
    const ms = e.latencyMs > 9999 ? `${(e.latencyMs / 1000).toFixed(1)}s` : `${e.latencyMs}ms`;
    const status =
      (e as UsageEntry & { status?: string }).status === "error" ? " ERROR  " : " OK     ";
    totalCost += e.cost;
    lines.push(
      `║  ${displayTime.padEnd(16)}║  ${model.padEnd(24)}║  ${cost.padStart(7)}║  ${ms.padStart(4)}║${status}║`,
    );
  }

  lines.push("╠══════════════════╩══════════════════════════╩═════════╩══════╩════════╣");
  lines.push(
    `║  ${allEntries.length} request${allEntries.length !== 1 ? "s" : ""}  Total spent: $${totalCost.toFixed(4)}`.padEnd(
      72,
    ) + "║",
  );
  lines.push(
    "║  Logs: ~/.openclaw/blockrun/logs/  (JSONL — one entry per request)".padEnd(72) + "║",
  );
  lines.push("╚════════════════════════════════════════════════════════════════════════╝");

  return lines.join("\n");
}

/**
 * Delete all usage log files, resetting stats to zero.
 */
export async function clearStats(): Promise<{ deletedFiles: number }> {
  try {
    const files = await readdir(LOG_DIR);
    const logFiles = files.filter((f) => f.startsWith("usage-") && f.endsWith(".jsonl"));

    await Promise.all(logFiles.map((f) => unlink(join(LOG_DIR, f))));

    return { deletedFiles: logFiles.length };
  } catch {
    return { deletedFiles: 0 };
  }
}
