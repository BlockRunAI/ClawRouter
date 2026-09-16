/**
 * Usage statistics the Usage page renders: the router's /stats payload reshaped
 * into one continuous calendar window plus the totals that describe it.
 *
 * Lives outside App.tsx because the window math is the part that can be wrong in
 * ways a screenshot will not show — a day silently dropped, a label counting
 * days the bars do not.
 */

export type UsageDay = {
  date: string;
  label: string;
  short: string;
  requests: number;
  cost: number;
};

/** Widest calendar window the activity chart pads out to. */
export const MAX_CHART_DAYS = 14;

export function normalizeStats(stats: Record<string, unknown> | null | undefined) {
  const pick = (...keys: string[]) =>
    keys.map((key) => stats?.[key]).find((value) => typeof value === "number") as
      number | undefined;

  const num = (row: Record<string, unknown>, key: string) =>
    typeof row[key] === "number" && Number.isFinite(row[key]) ? (row[key] as number) : 0;

  // The router only reports days that had traffic, so pad the series into a
  // continuous calendar window: the last 7 days at minimum, stretched back to
  // cover any older day the router still included (it takes the 7 most recent
  // log files, which need not be consecutive). Quiet days render as zero bars
  // instead of vanishing, and the window label stays truthful. Days are UTC
  // throughout because that is how the router buckets its logs; building the
  // window in local time would surface an evening's traffic as a phantom
  // "tomorrow" bar west of Greenwich.
  const byDate = new Map<string, { requests: number; cost: number }>();
  const rawDaily = stats?.dailyBreakdown ?? stats?.daily_breakdown;
  if (Array.isArray(rawDaily)) {
    for (const entry of rawDaily) {
      if (!entry || typeof entry !== "object") continue;
      const row = entry as Record<string, unknown>;
      const date = typeof row.date === "string" ? row.date : "";
      if (!date || Number.isNaN(parseDay(date).getTime())) continue;
      const prev = byDate.get(date) ?? { requests: 0, cost: 0 };
      byDate.set(date, {
        requests: prev.requests + num(row, "totalRequests"),
        cost: prev.cost + num(row, "totalCost"),
      });
    }
  }

  const daily: UsageDay[] = [];
  if (byDate.size > 0) {
    const dates = [...byDate.keys()].sort();
    const today = parseDay(formatDay(new Date()));
    const end = latest(parseDay(dates[dates.length - 1]), today);
    // Anything older than the cap is dropped rather than stretching the window.
    const floor = shiftDays(end, -(MAX_CHART_DAYS - 1));
    const firstKept = dates.map(parseDay).find((day) => day >= floor);
    // Every day the router reported is older than the cap. Padding to `end`
    // anyway would draw a week of zero bars for days that were never measured
    // and label them "last 7 days"; an empty chart is the honest answer.
    const start = firstKept ? earliest(firstKept, shiftDays(end, -6)) : undefined;
    for (let cursor = start ?? end; start && cursor <= end; cursor = shiftDays(cursor, 1)) {
      const date = formatDay(cursor);
      const entry = byDate.get(date) ?? { requests: 0, cost: 0 };
      daily.push({
        date,
        label: cursor.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          timeZone: "UTC",
        }),
        short: cursor
          .toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" })
          .slice(0, 2),
        requests: entry.requests,
        cost: entry.cost,
      });
    }
  }

  return {
    // The metric card carries the chart's own window label, so it has to count
    // the same days the bars do. `totalRequests` spans the 7 most recent log
    // FILES, which for an intermittent user reach back further than the window.
    requests: daily.length
      ? daily.reduce((sum, day) => sum + day.requests, 0)
      : (pick("requests", "totalRequests", "total_requests") ?? 0),
    cost: pick("totalCost", "totalCostUSD", "total_cost") ?? 0,
    savings: pick("totalSavings", "total_savings") ?? 0,
    savingsPct: pick("savingsPercentage", "savings_percentage") ?? 0,
    daily,
  };
}

/** UTC-midnight Date for a YYYY-MM-DD string. */
function parseDay(date: string) {
  return new Date(`${date}T00:00:00Z`);
}

/** YYYY-MM-DD of the UTC day, the key the router names its daily logs by. */
function formatDay(day: Date) {
  return day.toISOString().slice(0, 10);
}

function shiftDays(day: Date, delta: number) {
  const next = new Date(day);
  next.setUTCDate(next.getUTCDate() + delta);
  return next;
}

function earliest(a: Date, b: Date) {
  return a < b ? a : b;
}

function latest(a: Date, b: Date) {
  return a > b ? a : b;
}

/** Round a chart maximum up to the nearest readable tick value. */
export function niceCeiling(value: number) {
  if (value <= 4) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8, 10]) {
    const candidate = step * magnitude;
    if (candidate >= value) return candidate;
  }
  return 10 * magnitude;
}

export function windowLabel(days: UsageDay[]) {
  return days.length === 0 ? "no data yet" : `last ${days.length} days`;
}
