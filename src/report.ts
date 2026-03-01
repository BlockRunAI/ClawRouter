/**
 * Cost Report Generator
 */

import { getStats } from "./stats.js";
import type { AggregatedStats } from "./stats.js";

export type ReportPeriod = "daily" | "weekly" | "monthly";

export async function generateReport(
  period: ReportPeriod,
  json: boolean = false,
): Promise<string> {
  const days = period === "daily" ? 1 : period === "weekly" ? 7 : 30;
  const stats = await getStats(days);

  if (json) {
    return JSON.stringify(stats, null, 2);
  }

  return formatMarkdownReport(period, days, stats);
}

function formatMarkdownReport(
  period: ReportPeriod,
  days: number,
  stats: AggregatedStats,
): string {
  const lines: string[] = [];

  lines.push(`# ClawRouter ${capitalize(period)} Report`);
  lines.push(`**Period:** Last ${days} day${days > 1 ? "s" : ""}`);
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push("");

  lines.push("## 📊 Usage Summary");
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total Requests | ${stats.totalRequests} |`);
  lines.push(`| Total Cost | $${stats.totalCost.toFixed(4)} |`);
  lines.push(`| Baseline Cost | $${stats.totalBaselineCost.toFixed(4)} |`);
  lines.push(`| **Savings** | **$${stats.totalSavings.toFixed(4)}** |`);
  lines.push(`| Savings % | ${stats.savingsPercentage.toFixed(1)}% |`);
  lines.push(`| Avg Latency | ${stats.avgLatencyMs.toFixed(0)}ms |`);
  lines.push("");

  lines.push("## 🤖 Model Distribution");
  lines.push("");
  const sortedModels = Object.entries(stats.byModel)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10);
  for (const [model, data] of sortedModels) {
    lines.push(`- ${model}: ${data.count} reqs, $${data.cost.toFixed(4)}`);
  }
  lines.push("");

  return lines.join("\n");
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
