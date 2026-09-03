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

  // The staged runtime must carry exactly ONE @blockrun/clawrouter. It also
  // arrives transitively through @blockrun/clawrouter-codex, and
  // `findPinnedPackage()` walks the tree for one version — with two copies,
  // which one it finds is an accident of traversal order. The pnpm override in
  // runtime/pnpm-workspace.yaml is what keeps them deduped.
  //
  // That the single version EQUALS CLAWROUTER_PACKAGE_VERSION is checked by
  // `npm run verify:runtime`, which `dist` and `dist:release` run — not here.
  // The two cannot both live in this file: the test above ties the constant to
  // the root package.json, so it moves on the release commit, and the lockfile
  // can only resolve that version once it is published. Asserting equality here
  // would make every release commit red for the window between publishing and
  // relocking. Packaging happens after both, so the guard belongs there, where a
  // stale runtime fails the build instead of silently falling back to a live
  // npm install on first Connect (#316).
  it("stages exactly one @blockrun/clawrouter in the runtime lockfile", async () => {
    const lockfile = await readFile(new URL("../runtime/pnpm-lock.yaml", import.meta.url), "utf8");

    const resolved = [...lockfile.matchAll(/^\s*'@blockrun\/clawrouter@([^'(]+)/gm)].map(
      (match) => match[1],
    );

    expect(resolved.length).toBeGreaterThan(0);
    expect([...new Set(resolved)]).toHaveLength(1);
  });
});
