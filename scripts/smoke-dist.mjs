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
// ~10MB that way), not a size budget. Since the bundle is whitespace/syntax-minified
// and viem is bundled once (tsup.config.ts), index.js sits near 6.9MB; any second copy
// of ClawRouter or of viem lands well above this. If it trips, find the duplicate —
// only raise it once you have confirmed the growth is real.
const MAX_BUNDLE_BYTES = 9 * 1024 * 1024;

// The bundle is minified, so esbuild's `// node_modules/...` module comments are gone,
// and the sourcemap is no substitute: it follows each package's own maps back to its
// src/, so viem's _cjs and _esm builds both read as `viem/src/...`. tsup's metafile
// lists the real input files of every output; every duplicate check below reads it.
const METAFILE = resolve(root, "dist", "metafile-esm.json");
let metafile = null;
try {
  metafile = JSON.parse(readFileSync(METAFILE, "utf8"));
} catch (err) {
  failures.push(
    `dist/metafile-esm.json is unreadable (${err.message}) — tsup.config.ts must keep ` +
      `\`metafile: true\`; without it none of the duplicate checks can run.`,
  );
}

/** The bundled input files (\`node_modules/...\` or \`src/...\`) of one dist entry. */
function bundledInputs(entry) {
  const output = metafile?.outputs?.[`dist/${entry}`];
  return output ? Object.keys(output.inputs) : null;
}

/**
 * Packages that ship CommonJS and ES builds side by side and must be bundled only as
 * ESM. The Polymarket SDKs require() viem; without the esm-only plugin in
 * tsup.config.ts that pulled viem's whole _cjs build (and ox's, abitype's) in beside
 * the _esm one — +2.8MB and two module identities on the order-signing path.
 */
const DUAL_FORMAT_CJS = /^(?:.*\/)?node_modules\/(viem|ox|abitype)\/_cjs\//;

/**
 * The @solana/* packages that must never appear twice in a bundle.
 *
 * Not a size concern — the stateless ones (errors, codecs-*, addresses) duplicate
 * without breaking anything (see the size check below for why they still must not).
 * These three are different: `transaction-messages` keys its address map off a module-private
 * `Symbol("AddressMapTypeProperty")`, and `signers`/`transactions` hold the state a
 * signature is assembled from. Two copies read each other's objects as foreign and
 * produce malformed signatures — which is what shipped on 2026-03-06 when
 * `@solana/kit` and `@x402/svm` resolved to different major versions.
 *
 * The real invariant is this single-copy rule, NOT a pin on any one kit version.
 */
const SINGLE_COPY_SOLANA_PACKAGES = [
  "@solana/signers",
  "@solana/transactions",
  "@solana/transaction-messages",
];

/**
 * How many distinct installed copies of each guarded package esbuild inlined.
 *
 * Counting input files is wrong twice over: one copy contributes a file per dist
 * entry it pulls in, and "@solana/signers/node_modules/@solana/errors/..." is a
 * copy of errors, not of signers. Both are counted by resolving each input to the
 * package it actually names — everything after the LAST node_modules/ segment —
 * and then counting distinct install paths, not files.
 */
function countSolanaCopies(inputs) {
  const paths = new Map();
  for (const marker of inputs) {
    if (!marker.startsWith("node_modules/")) continue;
    const owner = marker.slice(marker.lastIndexOf("node_modules/") + "node_modules/".length);
    const pkg = owner.match(/^@solana\/[^/]+/)?.[0];
    if (!pkg) continue;
    // The install path is everything up to and including the package name, so two
    // different nestings of the same package count as two copies and its several
    // dist entries count as one.
    if (!paths.has(pkg)) paths.set(pkg, new Set());
    paths.get(pkg).add(marker.slice(0, marker.length - (owner.length - pkg.length)));
  }
  return [...paths].map(([pkg, seen]) => [pkg, seen.size]);
}

// A guard that has never fired is a guard nobody has tested. Prove the matcher
// still recognises the 2026-03-06 shape — two installs of @solana/signers — before
// trusting it to say a real bundle is clean. It must also NOT be fooled by the two
// things that look like copies and are not: a second dist entry of the same install,
// and a different package nested underneath this one.
{
  const probe = [
    "node_modules/@solana/signers/dist/index.node.mjs",
    "node_modules/@solana/signers/dist/program-client-core.node.mjs",
    "node_modules/@solana/signers/node_modules/@solana/errors/dist/index.node.mjs",
    "node_modules/@x402/svm/node_modules/@solana/signers/dist/index.node.mjs",
  ];
  const seen = new Map(countSolanaCopies(probe));
  if (seen.get("@solana/signers") !== 2) {
    failures.push(
      `smoke-dist's own duplicate detector is broken: it counted ` +
        `${seen.get("@solana/signers")} copies of @solana/signers in a fixture that has ` +
        `exactly 2. Fix countSolanaCopies — until then this check proves nothing.`,
    );
  }
}

// Same for the dual-format matcher: it must catch the _cjs build and pass the _esm one.
if (
  DUAL_FORMAT_CJS.exec("node_modules/viem/_cjs/chains/index.js")?.[1] !== "viem" ||
  DUAL_FORMAT_CJS.test("node_modules/viem/_esm/chains/index.js") ||
  DUAL_FORMAT_CJS.test("node_modules/@x402/viem-adapter/_cjs/index.js")
) {
  failures.push("smoke-dist's dual-format matcher (DUAL_FORMAT_CJS) is broken.");
}

for (const entry of ["index.js", "cli.js", "router/index.js"]) {
  const path = resolve(root, "dist", entry);
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch (err) {
    failures.push(`dist/${entry} is unreadable: ${err.message}`);
    continue;
  }
  const inputs = bundledInputs(entry);
  if (metafile && !inputs) {
    failures.push(`dist/metafile-esm.json has no output for dist/${entry}`);
  }
  if (inputs?.some((p) => p.includes("node_modules/@blockrun/clawrouter/"))) {
    failures.push(
      `dist/${entry} has a stale published ClawRouter inlined into it (an input under ` +
        `"node_modules/@blockrun/clawrouter/" is bundled) — the tsup alias for ` +
        `the @blockrun/llm back-import is missing or broken.`,
    );
  }
  const cjsCopies = [
    ...new Set((inputs ?? []).map((p) => p.match(DUAL_FORMAT_CJS)?.[1]).filter(Boolean)),
  ];
  if (cjsCopies.length > 0) {
    failures.push(
      `dist/${entry} bundles the CommonJS build of ${cjsCopies.join(", ")} beside the ESM ` +
        `one — a second, untree-shaken copy. The esm-only plugin in tsup.config.ts is ` +
        `missing, or a new require() path escapes it.`,
    );
  }
  if (source.length > MAX_BUNDLE_BYTES) {
    failures.push(
      `dist/${entry} is ${(source.length / 1024 / 1024).toFixed(1)}MB, over the ` +
        `${MAX_BUNDLE_BYTES / 1024 / 1024}MB ceiling — likely a dependency inlined twice.`,
    );
  }
  const copies = countSolanaCopies(inputs ?? []);
  // Harmless to signing, not to size: npm nests a private copy of every stateless
  // @solana/* package under each dependent when an `overrides` entry touches the
  // tree, and at kit 8 that was 20 copies of errors and +2.1MB (8.0→10.1MB) —
  // under MAX_BUNDLE_BYTES, so nothing else here would have noticed.
  const nested = copies.filter(([pkg, n]) => n > 1 && !SINGLE_COPY_SOLANA_PACKAGES.includes(pkg));
  if (nested.length > 0) {
    failures.push(
      `dist/${entry} bundles duplicate @solana packages (` +
        nested.map(([pkg, n]) => `${pkg} ×${n}`).join(", ") +
        `) — npm nested them instead of hoisting one shared copy. Delete every ` +
        `node_modules/@solana/* and node_modules/@solana-program/* entry from ` +
        `package-lock.json, re-resolve with \`npx npm@11 install\` (npm 10 keeps the ` +
        `nesting, or crashes on a fresh resolve), and confirm only @solana packages ` +
        `moved in the lock diff.`,
    );
  }
  for (const [pkg, count] of copies) {
    if (count > 1 && SINGLE_COPY_SOLANA_PACKAGES.includes(pkg)) {
      failures.push(
        `dist/${entry} bundles ${count} copies of ${pkg}. That package carries module ` +
          `identity — a module-private Symbol, or the signer/transaction state a ` +
          `signature is built from — so two copies do not agree, and the transactions ` +
          `this signs go out malformed (see the 2026-03-06 transaction_simulation_failed ` +
          `incident, a v6-vs-v5 split of exactly these packages). Make them resolve to ` +
          `one copy; do NOT relax this guard.`,
      );
    }
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

try {
  const router = await import(`file://${resolve(root, "dist", "router", "index.js")}`);
  if (
    typeof router.route !== "function" ||
    router.DEFAULT_ROUTING_CONFIG?.strategy !== "portfolio"
  ) {
    failures.push("dist/router/index.js did not expose the default portfolio router");
  }
} catch (err) {
  failures.push(`dist/router/index.js failed to load: ${err.message}`);
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
