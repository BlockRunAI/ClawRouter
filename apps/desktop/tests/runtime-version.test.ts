import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { CLAWROUTER_PACKAGE_VERSION } from "../electron/core/runtime.js";

describe("Desktop ClawRouter runtime pin", () => {
  it("matches the root package release", async () => {
    const rootPackage = JSON.parse(
      await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { version: string };

    expect(CLAWROUTER_PACKAGE_VERSION).toBe(rootPackage.version);
  });

  // `runtime/package.json` never depends on @blockrun/clawrouter directly — it
  // arrives transitively through @blockrun/clawrouter-codex — and `stage:runtime`
  // runs `pnpm install --frozen-lockfile`. So a version bump moves the constant
  // above while the lockfile stays put, `findPinnedPackage()` misses, and
  // `ensureNpmPackage()` quietly falls through to a live `npm install` at Connect
  // time. That defeats the frozen, offline-capable runtime this pin exists for.
  it("resolves the same version in the staged runtime lockfile", async () => {
    const lockfile = await readFile(new URL("../runtime/pnpm-lock.yaml", import.meta.url), "utf8");

    const resolved = [...lockfile.matchAll(/^\s*'@blockrun\/clawrouter@([^'(]+)/gm)].map(
      (match) => match[1],
    );

    expect(resolved.length).toBeGreaterThan(0);
    expect([...new Set(resolved)]).toEqual([CLAWROUTER_PACKAGE_VERSION]);
  });
});
