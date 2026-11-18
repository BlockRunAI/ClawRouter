import { afterEach, describe, expect, it, vi } from "vitest";

import { compareSemver } from "./updater.js";
import { VERSION } from "./version.js";

describe("compareSemver", () => {
  it("orders numeric releases", () => {
    expect(compareSemver("0.12.315", "0.12.314")).toBe(1);
    expect(compareSemver("0.12.314", "0.12.315")).toBe(-1);
    expect(compareSemver("1.0.0", "0.99.99")).toBe(1);
    expect(compareSemver("0.12.315", "0.12.315")).toBe(0);
  });

  it("compares a prerelease by its numeric core", () => {
    expect(compareSemver("0.12.316-rc.1", "0.12.315")).toBe(1);
    expect(compareSemver("1.2.0-beta.3", "1.1.9")).toBe(1);
    expect(compareSemver("0.12.316+build.7", "0.12.315")).toBe(1);
    expect(compareSemver("0.12.315-rc.1", "0.12.315")).toBe(0);
  });

  it("treats missing segments as zero", () => {
    expect(compareSemver("1.2", "1.2.0")).toBe(0);
  });
});

/**
 * The startup update hint compares the npm `latest` version with the installed
 * one. A version carrying a prerelease suffix (for example 0.12.316-rc.1) used
 * to be parsed as patch 0, so a newer prerelease looked older than the installed
 * stable release and no hint was printed.
 */
describe("checkForUpdates version comparison", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function runWithLatest(latest: string): Promise<string[]> {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: latest }),
      }),
    );
    const { checkForUpdates } = await import("./updater.js");
    await checkForUpdates();
    return lines;
  }

  it("prints a hint for a newer stable release", async () => {
    const [major, minor, patch] = (VERSION.split(/[+-]/, 1)[0] ?? "").split(".").map(Number);
    const newer = `${major}.${minor}.${patch + 1}`;
    const lines = await runWithLatest(newer);
    expect(lines.some((line) => line.includes(`${newer} available`))).toBe(true);
  });

  it("prints a hint for a newer prerelease instead of treating its patch as zero", async () => {
    const [major, minor, patch] = (VERSION.split(/[+-]/, 1)[0] ?? "").split(".").map(Number);
    const newerPrerelease = `${major}.${minor}.${patch + 1}-rc.1`;
    const lines = await runWithLatest(newerPrerelease);
    expect(lines.some((line) => line.includes(`${newerPrerelease} available`))).toBe(true);
  });

  it("prints no hint for the installed version", async () => {
    const lines = await runWithLatest(VERSION);
    expect(lines.some((line) => line.includes("available"))).toBe(false);
  });
});
