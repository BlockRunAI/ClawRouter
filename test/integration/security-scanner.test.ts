/**
 * OpenClaw security scanner integration tests.
 *
 * Runs OpenClaw's skill-scanner (the same one that fires during plugin install)
 * against ClawRouter's built dist/ to catch regressions like process.env
 * triggering env-harvesting warnings.
 *
 * The scanner is imported directly from the installed openclaw package.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface ScanFinding {
  ruleId: string;
  severity: "critical" | "warn" | "info";
  file: string;
  line: number;
  message: string;
  evidence: string;
}

interface ScanSummary {
  scannedFiles: number;
  critical: number;
  warn: number;
  info: number;
  findings: ScanFinding[];
}

type ScanFn = (dir: string) => Promise<ScanSummary>;

/** Resolve openclaw dist dir — try global npm root first, fall back to Docker path. */
function resolveOpenclawDist(): string {
  try {
    const globalRoot = execSync("npm root -g", { encoding: "utf-8" }).trim();
    return `${globalRoot}/openclaw/dist/`;
  } catch {
    return "/usr/local/lib/node_modules/openclaw/dist/";
  }
}

/** Resolve ClawRouter dist dir — relative to this file, fall back to Docker path. */
function resolveClawrouterDist(): string {
  const local = resolve(__dirname, "../../dist");
  try {
    readdirSync(local);
    return local;
  } catch {
    return "/opt/clawrouter/dist";
  }
}

describe("OpenClaw security scanner", () => {
  let scanDirectoryWithSummary: ScanFn | undefined;
  let distDir: string;

  beforeAll(async () => {
    distDir = resolveClawrouterDist();

    // Locate openclaw's skill-scanner chunk in its dist/
    const openclawDist = resolveOpenclawDist();
    try {
      const files = readdirSync(openclawDist);
      const scannerFile = files.find((f) => f.startsWith("skill-scanner"));
      if (!scannerFile) {
        console.warn("[scanner] skill-scanner chunk not found in openclaw dist — skipping");
        return;
      }
      const mod = (await import(pathToFileURL(`${openclawDist}${scannerFile}`).href)) as Record<
        string,
        unknown
      >;
      // The scanner exports scanDirectoryWithSummary as a minified name
      const fn = Object.values(mod).find((v) => typeof v === "function") as ScanFn | undefined;
      if (fn) {
        scanDirectoryWithSummary = fn;
      } else {
        console.warn("[scanner] No function export found in skill-scanner module — skipping");
      }
    } catch (err) {
      console.warn(`[scanner] Could not load openclaw scanner: ${err}`);
    }
  });

  it("dist/ has zero critical findings (no env-harvesting)", async () => {
    if (!scanDirectoryWithSummary) {
      console.log("[scanner] Scanner not available — test passes vacuously");
      return;
    }

    const result = await scanDirectoryWithSummary(distDir);

    console.log(`[scanner] Scanned ${result.scannedFiles} files`);
    console.log(
      `[scanner] Results: ${result.critical} critical, ${result.warn} warn, ${result.info} info`,
    );

    if (result.findings.length > 0) {
      for (const f of result.findings) {
        console.log(`[scanner] [${f.severity}] ${f.ruleId}: ${f.message}`);
        console.log(`[scanner]   ${f.file}:${f.line}`);
        console.log(`[scanner]   evidence: ${f.evidence}`);
      }
    }

    // No critical findings — this catches env-harvesting regressions
    expect(result.critical).toBe(0);

    // Verify env-harvesting specifically is absent
    const envHarvesting = result.findings.filter((f) => f.ruleId === "env-harvesting");
    expect(envHarvesting).toHaveLength(0);
  });

  it("dist/ has no unexpected warn-level findings", async () => {
    if (!scanDirectoryWithSummary) {
      console.log("[scanner] Scanner not available — test passes vacuously");
      return;
    }

    const result = await scanDirectoryWithSummary(distDir);

    // potential-exfiltration is expected (wallet read + network send)
    const unexpectedWarns = result.findings.filter(
      (f) => f.severity === "warn" && f.ruleId !== "potential-exfiltration",
    );

    if (unexpectedWarns.length > 0) {
      for (const f of unexpectedWarns) {
        console.error(`[scanner] Unexpected warning: [${f.ruleId}] ${f.message}`);
        console.error(`[scanner]   ${f.file}:${f.line}`);
      }
    }

    expect(unexpectedWarns).toHaveLength(0);
  });
});
