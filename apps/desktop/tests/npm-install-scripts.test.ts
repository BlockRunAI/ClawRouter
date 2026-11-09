import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// Desktop installs npm packages into the same account that holds the wallet
// key files, so npm lifecycle scripts (for the package AND its transitive tree,
// which resolves by range) run with access to them. Every ensureNpmPackage()
// call must pass `ignoreScripts: true` unless the package is listed here with
// the reason it genuinely cannot work without its install scripts.
const NEEDS_INSTALL_SCRIPTS: Record<string, string> = {
  // node-pty and koffi build/fetch native binaries at install time, and
  // @deepseek-ai/dsh-subprocess-local's postinstall stages its spawn helper.
  // Without them DSH's terminal and subprocess tools don't work.
  "@deepseek-ai/dsh": "native modules (node-pty, koffi) and spawn helper",
};

const ELECTRON_DIR = new URL("../electron/", import.meta.url).pathname;

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return Promise.resolve(entry.name.endsWith(".ts") ? [path] : []);
    }),
  );
  return nested.flat();
}

// The text of each `ensureNpmPackage(...)` call, matched by paren depth.
function ensureNpmPackageCalls(source: string): string[] {
  const calls: string[] = [];
  for (const match of source.matchAll(/\bensureNpmPackage\(/g)) {
    if (/function\s+$/.test(source.slice(0, match.index))) continue; // the definition
    let depth = 0;
    for (let i = match.index + "ensureNpmPackage".length; i < source.length; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")" && --depth === 0) {
        calls.push(source.slice(match.index, i + 1));
        break;
      }
    }
  }
  return calls;
}

describe("Desktop npm installs", () => {
  it("disable lifecycle scripts unless the package is explicitly exempted", async () => {
    const calls: { file: string; pkg: string; call: string }[] = [];
    for (const file of await sourceFiles(ELECTRON_DIR)) {
      for (const call of ensureNpmPackageCalls(await readFile(file, "utf8"))) {
        const pkg = call.match(/["'](@?[\w./-]+)["']/)?.[1] ?? "";
        calls.push({ file: file.slice(ELECTRON_DIR.length), pkg, call });
      }
    }

    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const { file, pkg, call } of calls) {
      if (pkg in NEEDS_INSTALL_SCRIPTS) continue;
      expect(call, `${file}: ${pkg} must pass ignoreScripts: true`).toMatch(
        /ignoreScripts:\s*true/,
      );
    }
    // An exemption for a package no longer installed is stale; drop it.
    for (const pkg of Object.keys(NEEDS_INSTALL_SCRIPTS)) {
      expect(calls.some((c) => c.pkg === pkg)).toBe(true);
    }
  });

  it("turn ignoreScripts into npm's --ignore-scripts flag", async () => {
    const runtime = await readFile(join(ELECTRON_DIR, "core/runtime.ts"), "utf8");
    expect(runtime).toContain('...(options.ignoreScripts ? ["--ignore-scripts"] : [])');
  });
});
