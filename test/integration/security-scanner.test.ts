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

/** Resolve openclaw dist dir — prefer local dependency, then fall back for Docker/global runs. */
function resolveOpenclawDist(): string {
  const local = resolve(__dirname, "../../node_modules/openclaw/dist");
  try {
    readdirSync(local);
    return local;
  } catch {
    // fall through to global/Docker lookup
  }

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
  let scannerLoadError: string | undefined;

  beforeAll(async () => {
    distDir = resolveClawrouterDist();

    // Locate openclaw's skill-scanner chunk in its dist/.
    // 2026.5.7 ships two skill-scanner-*.js chunks: one minified with mangled exports
    // and one with proper names. Iterate all and pick the one exporting
    // scanDirectoryWithSummary; fall back to "first function export" for pre-2026.5.4 builds.
    const openclawDist = resolveOpenclawDist();
    try {
      const files = readdirSync(openclawDist);
      const scannerFiles = files.filter((f) => f.startsWith("skill-scanner"));
      if (scannerFiles.length === 0) {
        scannerLoadError = `skill-scanner chunk not found in ${openclawDist}`;
        return;
      }
      for (const scannerFile of scannerFiles) {
        const scannerPath = resolve(openclawDist, scannerFile);
        const mod = (await import(pathToFileURL(scannerPath).href)) as Record<string, unknown>;
        if (typeof mod.scanDirectoryWithSummary === "function") {
          scanDirectoryWithSummary = mod.scanDirectoryWithSummary as ScanFn;
          break;
        }
      }
      if (!scanDirectoryWithSummary) {
        const firstScannerPath = resolve(openclawDist, scannerFiles[0]);
        const mod = (await import(pathToFileURL(firstScannerPath).href)) as Record<string, unknown>;
        const fn = Object.values(mod).find((v) => typeof v === "function") as ScanFn | undefined;
        if (fn) {
          scanDirectoryWithSummary = fn;
        } else {
          scannerLoadError = `No scanDirectoryWithSummary export found across ${scannerFiles.length} skill-scanner chunks`;
        }
      }
    } catch (err) {
      scannerLoadError = `Could not load openclaw scanner: ${String(err)}`;
    }
  });

  it("dist/ has zero critical findings (no env-harvesting)", async () => {
    if (!scanDirectoryWithSummary) {
      throw new Error(`[scanner] Scanner not available: ${scannerLoadError ?? "unknown error"}`);
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
      throw new Error(`[scanner] Scanner not available: ${scannerLoadError ?? "unknown error"}`);
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
