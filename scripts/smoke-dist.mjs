#!/usr/bin/env node
// Loads the freshly-built bundles and fails the build if they cannot be executed.
//
// This exists because v0.12.220 shipped to npm with a dead CLI: the tsup banner's
// `__cjs_createRequire` collided with an identically-named import emitted by a
// bundled dependency, so every entrypoint threw a load-time SyntaxError. Nothing in
// `build && typecheck && test` ever loads dist/, so CI published it happily.
// Anything that only a real import would catch belongs here.

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

try {
  const lib = await import(`file://${resolve(root, "dist", "index.js")}`);
  if (typeof lib.resolveModelAlias !== "function") {
    failures.push("dist/index.js loaded but does not export resolveModelAlias");
  }
} catch (err) {
  failures.push(`dist/index.js failed to load: ${err.message}`);
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
