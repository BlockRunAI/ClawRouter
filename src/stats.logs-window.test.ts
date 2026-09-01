import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * `clawrouter logs --days <n>` parses with `parseInt(raw, 10) || 1`, which lets a
 * negative through because -1 is truthy. That reached `logFiles.slice(0, days)`,
 * where a negative trims from the END — so `--days -1` dropped the NEWEST day
 * while the header claimed "last -1 days".
 */
describe("formatRecentLogs day window", () => {
  let home: string;

  const entry = (model: string, day: string) =>
    JSON.stringify({
      timestamp: `${day}T12:00:00.000Z`,
      model,
      tier: "CHEAP",
      cost: 0.01,
      baselineCost: 0.02,
      savings: 0.5,
      latencyMs: 100,
    });

  beforeEach(async () => {
    vi.resetModules();
    home = await mkdtemp(join(tmpdir(), "clawrouter-logs-window-"));
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return { ...actual, homedir: () => home };
    });
    const logs = join(home, ".openclaw", "blockrun", "logs");
    await mkdir(logs, { recursive: true });
    // Oldest → newest. getLogFiles() sorts and reverses, so NEWEST is index 0.
    await writeFile(join(logs, "usage-2026-08-27.jsonl"), entry("oldest-model", "2026-08-27"));
    await writeFile(join(logs, "usage-2026-08-28.jsonl"), entry("middle-model", "2026-08-28"));
    await writeFile(join(logs, "usage-2026-08-29.jsonl"), entry("newest-model", "2026-08-29"));
  });

  afterEach(async () => {
    vi.doUnmock("node:os");
    await rm(home, { recursive: true, force: true });
  });

  it("keeps the newest day when --days is negative, and does not label it '-1 days'", async () => {
    const { formatRecentLogs } = await import("./stats.js");
    const out = await formatRecentLogs(-1);

    expect(out).toContain("newest-model");
    expect(out).not.toContain("-1 days");
    expect(out).toContain("24h");
  });

  it.each([
    ["NaN", Number.NaN],
    ["zero", 0],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])("falls back to a single day for %s", async (_label, value) => {
    const { formatRecentLogs } = await import("./stats.js");
    const out = await formatRecentLogs(value);

    expect(out).toContain("newest-model");
    expect(out).not.toContain("middle-model");
    expect(out).toContain("24h");
  });

  it("still honours a valid multi-day window", async () => {
    const { formatRecentLogs } = await import("./stats.js");
    const out = await formatRecentLogs(2);

    expect(out).toContain("newest-model");
    expect(out).toContain("middle-model");
    expect(out).not.toContain("oldest-model");
    expect(out).toContain("2 days");
  });
});
