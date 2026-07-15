#!/usr/bin/env node
// Loads the freshly-built bundles and fails the build if they cannot be executed.
//
// MUST NOT SHIP: package.json `files` excludes this via "!scripts/smoke-dist.mjs".
// It uses child_process, and OpenClaw's plugin scanner blocks the install of any
// package containing "dangerous code patterns" — shipping it in v0.12.222 made the
// plugin uninstallable ("installation blocked: Shell command execution detected").
// This is a build-time-only gate; it has no business in the published tarball.
//
// This exists because v0.12.220 shipped to npm with a dead CLI: the tsup banner's
// `__cjs_createRequire` collided with an identically-named import emitted by a
// bundled dependency, so every entrypoint threw a load-time SyntaxError. Nothing in
// `build && typecheck && test` ever loads dist/, so CI published it happily.
// Anything that only a real import would catch belongs here.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

// `noExternal: [/.*/]` bundles @blockrun/llm, which imports @blockrun/clawrouter back
// (the two packages depend on each other). Without an alias pinning that back-import to
// our own src, esbuild resolves it to whatever stale copy npm left in node_modules and
// inlines the entire published bundle — a second, older ClawRouter shadowing this one,
// with its own module state. That is what made v0.12.220 10MB and collided the banner.
// The identifier rename cures the SyntaxError but NOT this; only the alias does, and a
// loadable bundle would hide it. Assert the copy is absent, not merely harmless.
// Deliberately generous: a canary for a whole extra copy of something (v0.12.220 hit
// ~10MB that way), not a size budget. viem/ox/undici plus the Polymarket SDKs put the
// honest floor near 7.5MB. If this trips, find the duplicate — only raise it once you
// have confirmed the growth is real.
const MAX_BUNDLE_BYTES = 12 * 1024 * 1024;

for (const entry of ["index.js", "cli.js"]) {
  const path = resolve(root, "dist", entry);
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch (err) {
    failures.push(`dist/${entry} is unreadable: ${err.message}`);
    continue;
  }
  if (source.includes("// node_modules/@blockrun/clawrouter/")) {
    failures.push(
      `dist/${entry} has a stale published ClawRouter inlined into it (esbuild module ` +
        `marker "// node_modules/@blockrun/clawrouter/" is present) — the tsup alias for ` +
        `the @blockrun/llm back-import is missing or broken.`,
    );
  }
  if (source.length > MAX_BUNDLE_BYTES) {
    failures.push(
      `dist/${entry} is ${(source.length / 1024 / 1024).toFixed(1)}MB, over the ` +
        `${MAX_BUNDLE_BYTES / 1024 / 1024}MB ceiling — likely a dependency inlined twice.`,
    );
  }
}

try {
  const lib = await import(`file://${resolve(root, "dist", "index.js")}`);
  if (typeof lib.resolveModelAlias !== "function") {
    failures.push("dist/index.js loaded but does not export resolveModelAlias");
  }
} catch (err) {
  failures.push(`dist/index.js failed to load: ${err.message}`);
}

// OpenClaw scans a plugin's loose script files for "dangerous code patterns" and
// blocks the ENTIRE install when it finds one — v0.12.222 shipped this very file,
// whose child_process import made the plugin uninstallable for every user
// ("installation blocked: Shell command execution detected"). dist/ is exempt from
// that scan (the proxy legitimately spawns processes), so this only guards the
// loose scripts/ files we publish. Assert on the real pack list, not on intent.
try {
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 120_000,
    }).toString(),
  );
  const shipped = (packed[0]?.files ?? []).map((f) => f.path);
  const scanned = shipped.filter((p) => /^scripts\/.*\.(mjs|js|cjs)$/.test(p));
  for (const rel of scanned) {
    const source = readFileSync(resolve(root, rel), "utf8");
    if (/child_process/.test(source)) {
      failures.push(
        `${rel} ships in the npm tarball and imports child_process — OpenClaw's plugin ` +
          `scanner will block the install. Exclude it via package.json "files" ` +
          `(e.g. "!${rel}") or drop the child_process use.`,
      );
    }
  }
} catch (err) {
  // Never fail the build because `npm pack` itself misbehaved (offline, etc).
  console.warn(`  ! could not verify pack contents: ${err.message}`);
}

try {
  execFileSync(process.execPath, [resolve(root, "dist", "cli.js"), "--version"], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
} catch (err) {
  failures.push(`dist/cli.js --version failed: ${(err.stderr?.toString() || err.message).trim()}`);
}

if (failures.length > 0) {
  console.error("\n✗ dist smoke check failed — do NOT publish this build:\n");
  for (const failure of failures) console.error(`  • ${failure}`);
  console.error("");
  process.exit(1);
}

console.log("✓ dist smoke check passed (index.js imports, cli.js runs)");
