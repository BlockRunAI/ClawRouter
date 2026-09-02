#!/usr/bin/env node
/**
 * Sync marketing numbers from BlockRun's canonical brand artifact.
 *
 * This file is copied byte-for-byte into every public repo as
 * scripts/sync-brand-numbers.mjs. It is a copy rather than an npm package on
 * purpose: a package would mean 37 dependency bumps, and several consuming
 * repos have no package.json at all. Zero dependencies, plain Node.
 *
 *   node scripts/sync-brand-numbers.mjs            rewrite markers in place
 *   node scripts/sync-brand-numbers.mjs --check    exit 1 on drift, write nothing
 *   node scripts/sync-brand-numbers.mjs --refresh  re-fetch the artifact first
 *
 * --check NEVER touches the network. PR CI must be deterministic and offline:
 * if it fetched, a deploy in progress would fail every repo in the org at once.
 * Freshness is the fan-out job's problem, not the pull request's.
 *
 * Markers look like:  <!-- br:models.chatVisible -->66<!-- /br:models.chatVisible -->
 * and wrap the WHOLE token, so a badge URL, its alt text and the prose number
 * can all regenerate from one key.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, relative, extname } from "node:path";

const ROOT = process.cwd();
const SNAPSHOT = join(ROOT, "brand-numbers.json");
// ORIGIN is tried first because it IS the truth — the mirror can only ever be
// as fresh as the last time someone refreshed it. The mirror exists so a repo
// can still sync while blockrun.ai is down, not to front the origin.
//
// The mirror is awesome-blockrun's own brand-numbers.json: that repo consumes
// the artifact like every other, and its snapshot doubles as the org's copy.
// One file, one role per repo, nothing to keep in step by hand.
const ORIGIN = "https://blockrun.ai/brand/numbers.json";
const MIRROR =
  "https://raw.githubusercontent.com/BlockRunAI/awesome-blockrun/main/brand-numbers.json";

const argv = new Set(process.argv.slice(2));
const check = argv.has("--check");
const refresh = argv.has("--refresh");

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", "coverage",
  "vendor", "target", "__pycache__", ".venv", "venv",
]);
// .txt is here for llms.txt, which is a first-class marketing surface: it is
// what agents read to find out what BlockRun serves. Scanning other .txt files
// costs a read and changes nothing — only files with markers are ever written.
const TEXT_EXT = new Set([".md", ".mdx", ".txt"]);

/* ── 1. numbers ──────────────────────────────────────────────────────────── */

async function loadNumbers() {
  if (!refresh) {
    try {
      return JSON.parse(readFileSync(SNAPSHOT, "utf8"));
    } catch {
      fail(
        `no brand-numbers.json in ${ROOT}\n` +
          `  run with --refresh once to seed it from ${ORIGIN}`,
      );
    }
  }
  for (const url of [ORIGIN, MIRROR]) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) continue;
      const json = await res.json();
      writeFileSync(SNAPSHOT, `${JSON.stringify(json, null, 2)}\n`);
      return json;
    } catch {
      /* try the next source */
    }
  }
  fail(`could not refresh from ${MIRROR} or ${ORIGIN}`);
}

/** Flatten nested numbers into dotted keys, ignoring $comment / rationale prose. */
function flatten(obj, prefix = "") {
  return Object.entries(obj).flatMap(([k, v]) => {
    if (k.startsWith("$")) return [];
    const key = `${prefix}${k}`;
    if (v && typeof v === "object" && !Array.isArray(v)) return flatten(v, `${key}.`);
    if (v === null) return [];
    return [[key, v]];
  });
}

/* ── 2. renderers ────────────────────────────────────────────────────────── */

/**
 * How a key becomes text. Default is the bare value.
 *
 * A marker may carry an `@modifier` — `<!-- br:mcp.tools@badge -->` — which
 * selects a renderer without changing which number is looked up. The modifier
 * is what makes a key reusable: the same mcp.tools appears as a shields badge
 * at the top of a README and as a bare "19 tools" in a table two screens down,
 * and one marker still keeps the badge URL, its alt text and the label in step.
 *
 * Renderers are registered under the FULL marker name so a badge's label is
 * written out rather than guessed from the key.
 */
const badge = (label) => (n) =>
  `<img src="https://img.shields.io/badge/${label}-${n}-5B9BF6?style=flat-square&labelColor=0B0A0F" alt="${n} ${label}">`;

const RENDER = {
  "mcp.tools@badge": badge("tools"),
  "models.totalVisible@badge": badge("models"),
  "models.chatVisible@badge": badge("models"),
};
const render = (marker, value) => (RENDER[marker] ?? String)(value);

/** `mcp.tools@badge` looks up `mcp.tools`. Unmodified markers are unaffected. */
const keyOf = (marker) => marker.split("@")[0];

/**
 * `@live` opts a marker INTO rewriting inside a fenced block.
 *
 * The fence skip exists so a code block demonstrating the marker syntax is not
 * itself rewritten. But a fence is also how you draw an ASCII diagram, and a
 * number inside one is live marketing copy, not documentation. Franklin's README
 * had three model counts inside box-drawing blocks: silently skipped by the
 * rewriter AND by --check, so they would have gone stale while the same number
 * updated five lines above, with CI reporting "up to date" throughout. That is
 * the exact hand-maintained staleness this tool exists to remove.
 *
 * `live` occupies the modifier slot, so it cannot be combined with a renderer
 * modifier like `@badge`. A badge inside a code fence is not a thing worth
 * supporting; a bare number inside a diagram very much is.
 */
const isLive = (marker) => marker.split("@")[1] === "live";

/* ── 3. marker rewriting ─────────────────────────────────────────────────── */

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const OPEN_ANY = /<!--\s*br:([A-Za-z0-9_.@]+)\s*-->/g;
const CLOSE_ANY = /<!--\s*\/br:([A-Za-z0-9_.@]+)\s*-->/g;

/** Byte ranges of fenced code blocks — markers inside them are documentation. */
function fencedRanges(text) {
  const ranges = [];
  const fence = /^(\s*)(`{3,}|~{3,})[^\n]*$/gm;
  let open = null;
  for (let m; (m = fence.exec(text)); ) {
    if (open === null) open = m.index;
    else {
      ranges.push([open, m.index + m[0].length]);
      open = null;
    }
  }
  // An unterminated fence used to be dropped, which silently reclassified the
  // whole tail of the file as live prose and rewrote every example after it.
  // A fence with no partner runs to EOF — that is how the renderers read it too.
  if (open !== null) ranges.push([open, text.length]);
  return ranges;
}

function syncFile(file, numbers, problems, skipped) {
  const before = readFileSync(file, "utf8");
  const rel = relative(ROOT, file);
  const fenced = fencedRanges(before);
  const inFence = (i) => fenced.some(([a, b]) => i >= a && i < b);
  const known = new Map(numbers);
  const used = new Set();

  // Markers actually present, so a file is only ever rewritten for what it uses
  // and an @modifier is carried through to the renderer verbatim.
  const markers = new Set();
  // A marker naming a key that does not exist is an error, never a silent
  // no-op: a typo'd marker would otherwise sit there looking synced forever.
  for (const [re, shown] of [
    [OPEN_ANY, (n) => `<!-- br:${n} -->`],
    [CLOSE_ANY, (n) => `<!-- /br:${n} -->`],
  ]) {
    for (const m of before.matchAll(re)) {
      // A fenced marker is documentation and is neither collected nor validated
      // — unless it is @live, which is explicitly live content that happens to
      // sit in a diagram, so it must be discovered and key-checked like any other.
      if (!isLive(m[1]) && inFence(m.index)) continue;
      markers.add(m[1]);
      if (!known.has(keyOf(m[1]))) problems.push(`${rel}: unknown key ${shown(m[1])}`);
    }
  }

  let after = before;
  for (const marker of markers) {
    const key = keyOf(marker);
    if (!known.has(key)) continue;
    const value = known.get(key);
    const live = isLive(marker);
    const pair = new RegExp(
      `(<!--\\s*br:${esc(marker)}\\s*-->)([\\s\\S]*?)(<!--\\s*/br:${esc(marker)}\\s*-->)`,
      "g",
    );
    // Fence ranges must be recomputed against the string we are about to search.
    // `replace` reports offsets into ITS OWN input, and `after` has already been
    // rewritten by every earlier marker in this loop — a badge turns 2 characters
    // into ~150 — so ranges measured on `before` drift further out of alignment
    // with each pass and start judging the wrong side of a fence boundary.
    const fencedNow = fencedRanges(after);
    const inFenceNow = (i) => fencedNow.some(([a, b]) => i >= a && i < b);
    after = after.replace(pair, (whole, open, inner, close, offset) => {
      if (!live && inFenceNow(offset)) return whole;
      // Nesting means the closing tag of an inner marker would be consumed by
      // the outer one. Refuse rather than produce mangled output.
      if (/<!--\s*\/?br:/.test(inner)) {
        problems.push(`${rel}: nested marker inside br:${marker}`);
        return whole;
      }
      used.add(marker);
      return open + render(marker, value) + close;
    });

    // An opening tag with no partner silently swallows the rest of the file on
    // a naive regex, so catch it explicitly.
    const counted = (m) => live || !inFence(m.index);
    const opens = [...before.matchAll(new RegExp(`<!--\\s*br:${esc(marker)}\\s*-->`, "g"))]
      .filter(counted).length;
    const closes = [...before.matchAll(new RegExp(`<!--\\s*/br:${esc(marker)}\\s*-->`, "g"))]
      .filter(counted).length;
    if (opens !== closes) problems.push(`${rel}: unbalanced marker br:${marker} (${opens} open, ${closes} close)`);
  }

  // Skipping a fenced marker is right for a documentation example and wrong for
  // a number inside a diagram, and only a human can tell those apart. Report the
  // ones whose value actually disagrees with the artifact — those are numbers
  // going stale under a green build. An example already showing the right value
  // stays quiet, so repos that document the syntax get no noise.
  //
  // Scanned over `before` rather than recorded during rewriting because a marker
  // that appears ONLY inside a fence is dropped at discovery and never reaches
  // the replace loop at all.
  const ANY_PAIR = /<!--\s*br:([A-Za-z0-9_.@]+)\s*-->([\s\S]*?)<!--\s*\/br:\1\s*-->/g;
  for (const m of before.matchAll(ANY_PAIR)) {
    const name = m[1];
    if (isLive(name) || !inFence(m.index)) continue;
    const key = keyOf(name);
    if (!known.has(key) || m[2] === render(name, known.get(key))) continue;
    skipped.push(`${rel}:${before.slice(0, m.index).split("\n").length} br:${name}`);
  }

  return { before, after, changed: before !== after, used };
}

/* ── 4. walk ─────────────────────────────────────────────────────────────── */

/**
 * The set of paths git tracks, or null when this is not a git checkout.
 *
 * Without this the walker rewrote ANY .md/.txt it could reach, including files
 * git ignores — a developer's scratch notes, a generated docs/ output — and
 * --check then reported drift against files that are not in the repo at all. CI
 * never saw it (a fresh checkout contains only tracked files), so it was purely
 * a local mystery. Returning null on a non-git tree keeps the tool usable in a
 * bare directory, which is how it is often run the first time.
 */
function trackedFiles() {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const set = new Set(out.split("\0").filter(Boolean).map((rel) => join(ROOT, rel)));
    return set.size ? set : null;
  } catch {
    return null;
  }
}

const TRACKED = trackedFiles();

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    // lstat, not stat: a symlinked directory is reached by its real path or not
    // at all. blockrun's docs/ -> awesome-blockrun/docs is exactly the case that
    // matters — following it would edit a submodule's files behind the skip
    // below, and a link pointing at an ancestor would recurse forever.
    const s = lstatSync(p);
    if (s.isSymbolicLink()) continue;
    if (s.isDirectory()) {
      // A nested repo is a submodule or vendored checkout: it carries its own
      // brand-numbers.json and syncs itself. Rewriting its markers from THIS
      // repo's snapshot would dirty a submodule nobody asked us to touch, and
      // would report drift that belongs to another repo's CI.
      if (existsSync(join(p, ".git"))) continue;
      yield* walk(p);
    } else if (TEXT_EXT.has(extname(name)) && (TRACKED === null || TRACKED.has(p))) yield p;
  }
}

function fail(msg) {
  console.error(`brand-numbers: ${msg}`);
  process.exit(1);
}

/* ── 5. run ──────────────────────────────────────────────────────────────── */

const raw = await loadNumbers();
const numbers = flatten(raw);
const problems = [];
const drifted = [];
const skipped = [];
const everUsed = new Set();

for (const file of walk(ROOT)) {
  const { before, after, changed, used } = syncFile(file, numbers, problems, skipped);
  used.forEach((k) => everUsed.add(k));
  if (!changed) continue;
  drifted.push({ file: relative(ROOT, file), before, after });
  if (!check) writeFileSync(file, after);
}

// Non-fatal on purpose: this ships to 37 repos at once, and a hard failure would
// break every one of them that documents the marker syntax. Visible, not fatal.
if (skipped.length) {
  console.error(
    `brand-numbers: ${skipped.length} marker(s) skipped inside code fences ` +
      `(add @live to sync one, e.g. <!-- br:models.chatVisible@live -->):`,
  );
  for (const s of skipped) console.error(`  ${s}`);
  console.error("");
}

if (problems.length) {
  for (const p of problems) console.error(`  ${p}`);
  fail(`${problems.length} marker problem(s)`);
}

if (check) {
  if (drifted.length === 0) {
    console.log(`brand-numbers: up to date (${everUsed.size} keys in use)`);
    process.exit(0);
  }
  console.error("brand-numbers: these files disagree with brand-numbers.json\n");
  for (const { file, before, after } of drifted) {
    const b = before.split("\n");
    const a = after.split("\n");
    for (let i = 0; i < Math.max(b.length, a.length); i++) {
      if (b[i] !== a[i]) {
        console.error(`  ${file}:${i + 1}`);
        console.error(`    - ${(b[i] ?? "").trim()}`);
        console.error(`    + ${(a[i] ?? "").trim()}`);
      }
    }
  }
  console.error(
    "\n  fix with:  node scripts/sync-brand-numbers.mjs && git commit -am 'chore: sync brand numbers'",
  );
  process.exit(1);
}

console.log(
  drifted.length
    ? `brand-numbers: updated ${drifted.length} file(s)`
    : `brand-numbers: already up to date (${everUsed.size} keys in use)`,
);
