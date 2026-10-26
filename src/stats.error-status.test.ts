import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("usage log error status", () => {
  let home: string;

  beforeEach(async () => {
    vi.resetModules();
    home = await mkdtemp(join(tmpdir(), "clawrouter-error-status-"));
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return { ...actual, homedir: () => home };
    });
    const logs = join(home, ".openclaw", "blockrun", "logs");
    await mkdir(logs, { recursive: true });
    const lines = [
      JSON.stringify({
        timestamp: "2026-10-24T10:00:00.000Z",
        model: "gpt-4",
        tier: "PREMIUM",
        cost: 0.01,
        baselineCost: 0.02,
        savings: 0.5,
        latencyMs: 120,
        status: "success",
      }),
      JSON.stringify({
        timestamp: "2026-10-24T10:01:00.000Z",
        model: "gpt-4",
        tier: "PREMIUM",
        cost: 0,
        baselineCost: 0.02,
        savings: 0,
        latencyMs: 50,
        status: "error",
      }),
    ].join("\n");
    await writeFile(join(logs, "usage-2026-10-24.jsonl"), lines);
  });

  afterEach(async () => {
    vi.doUnmock("node:os");
    await rm(home, { recursive: true, force: true });
  });

  it("counts error entries and marks them in recent log output", async () => {
    const { getStats, formatRecentLogs } = await import("./stats.js");

    const stats = await getStats(1);
    expect(stats.totalRequests).toBe(2);
    expect(stats.errorCount).toBe(1);

    const recent = await formatRecentLogs(1);
    expect(recent).toContain("ERROR");
  });
});
