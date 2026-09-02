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

  // The post-publish release PR must pin the published package in the frozen
  // Desktop runtime. Otherwise packaged builds silently fall back to a network
  // install on first Connect (see issue #316).
  it("stages exactly the root @blockrun/clawrouter release", async () => {
    const lockfile = await readFile(new URL("../runtime/pnpm-lock.yaml", import.meta.url), "utf8");

    const resolved = [...lockfile.matchAll(/^\s*'@blockrun\/clawrouter@([^'(]+)/gm)].map(
      (match) => match[1],
    );

    expect(resolved.length).toBeGreaterThan(0);
    expect([...new Set(resolved)]).toEqual([CLAWROUTER_PACKAGE_VERSION]);
  });
});
