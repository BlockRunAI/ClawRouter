/**
 * Usage Statistics Aggregator
 *
 * Reads usage log files and aggregates statistics for terminal display.
 * Supports filtering by date range and provides multiple aggregation views.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { UsageEntry } from "./logger.js";
import { VERSION } from "./version.js";

const LOG_DIR = join(homedir(), ".openclaw", "blockrun", "logs");

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
    const content = await readFile(filePath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    return lines.map((line) => {
      const entry = JSON.parse(line) as Partial<UsageEntry>;
      // Handle old format entries
      return {
        timestamp: entry.timestamp || new Date().toISOString(),
        model: entry.model || "unknown",
        tier: entry.tier || "UNKNOWN",
        cost: entry.cost || 0,
        baselineCost: entry.baselineCost || entry.cost || 0,
        savings: entry.savings || 0,
        latencyMs: entry.latencyMs || 0,
      };
    });
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
  const knownTiers = ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"];
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
