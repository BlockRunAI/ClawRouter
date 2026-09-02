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

  // The staged runtime must carry exactly one @blockrun/clawrouter. It arrives
  // transitively through @blockrun/clawrouter-codex, so a second copy at another
  // version is possible in principle, and `findPinnedPackage()` walks the tree
  // looking for one specific version — two copies make which one it finds an
  // accident of traversal order. Same failure shape as the @solana/kit split
  // that produced malformed signatures.
  //
  // Deliberately NOT asserted here: that the resolved version equals
  // CLAWROUTER_PACKAGE_VERSION. It cannot, in the release window — the constant
  // moves with the root package on the release commit, and the lockfile can only
  // resolve that version once it is on npm. Relocking the runtime is a
  // post-publish step; until it happens the Desktop falls back to a pinned
  // `npm install` at Connect time, which works but is not the frozen runtime.
  // See issue #316.
  it("stages exactly one @blockrun/clawrouter in the runtime lockfile", async () => {
    const lockfile = await readFile(new URL("../runtime/pnpm-lock.yaml", import.meta.url), "utf8");

    const resolved = [...lockfile.matchAll(/^\s*'@blockrun\/clawrouter@([^'(]+)/gm)].map(
      (match) => match[1],
    );

    expect(resolved.length).toBeGreaterThan(0);
    expect([...new Set(resolved)]).toHaveLength(1);
  });
});
