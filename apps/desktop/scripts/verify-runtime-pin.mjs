/**
 * Refuse to package a Desktop build whose frozen runtime is not the release the
 * app will ask for.
 *
 * `ensureNpmPackage()` looks for CLAWROUTER_PACKAGE_VERSION inside the staged
 * runtime. If the lockfile pinned something else, it misses and falls through to
 * a live `npm install` on first Connect — the build still works, but it needs the
 * network and it is no longer the frozen runtime the pin exists to provide
 * (issue #316).
 *
 * This lives at packaging time, not in the unit suite, because the two cannot be
 * the same check. `runtime-version.test.ts` ties the constant to the root
 * package.json, so the constant moves on the release commit — and the lockfile
 * can only resolve that version once it is published. Asserting equality in the
 * unit suite would make every release commit red for the window between
 * publishing and relocking. Packaging happens after both, so here it is simply
 * true, and a stale runtime becomes a failed build instead of a silent fallback.
 */
import { readFile } from "node:fs/promises";

const runtimeSource = await readFile(
  new URL("../electron/core/runtime.ts", import.meta.url),
  "utf8",
);
const expected = runtimeSource.match(/CLAWROUTER_PACKAGE_VERSION\s*=\s*"([^"]+)"/)?.[1];
if (!expected) {
  console.error("verify-runtime-pin: could not read CLAWROUTER_PACKAGE_VERSION from runtime.ts");
  process.exit(1);
}

const lockfile = await readFile(new URL("../runtime/pnpm-lock.yaml", import.meta.url), "utf8");
const resolved = [
  ...new Set([...lockfile.matchAll(/^\s*'@blockrun\/clawrouter@([^'(]+)/gm)].map((m) => m[1])),
];

if (resolved.length === 0) {
  console.error(
    "verify-runtime-pin: no @blockrun/clawrouter in apps/desktop/runtime/pnpm-lock.yaml",
  );
  process.exit(1);
}
if (resolved.length > 1) {
  console.error(
    `verify-runtime-pin: runtime stages ${resolved.length} copies of @blockrun/clawrouter (${resolved.join(", ")}).\n` +
      "findPinnedPackage() walks the tree for one version, so which copy it finds is an accident of traversal order.\n" +
      "Add a pnpm override so they dedupe to one.",
  );
  process.exit(1);
}
if (resolved[0] !== expected) {
  console.error(
    `verify-runtime-pin: the app asks for @blockrun/clawrouter@${expected} but the frozen runtime stages ${resolved[0]}.\n` +
      "A packaged build would fall back to a live npm install on first Connect.\n" +
      `Fix: set that version in runtime/package.json and runtime/pnpm-workspace.yaml, then\n` +
      "  corepack pnpm install --dir runtime --prod --lockfile-only",
  );
  process.exit(1);
}

console.log(`✓ Desktop runtime staged at @blockrun/clawrouter@${expected}`);
