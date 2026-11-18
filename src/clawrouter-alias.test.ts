import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `packages/clawrouter-alias` is published as the unscoped npm name
 * `clawrouter`, held so that `npx clawrouter` runs this package
 * (GHSA-c2qw-vppx-3p8r). It is published by hand, so nothing else notices when
 * a change here breaks it. See packages/clawrouter-alias/PUBLISHING.md.
 */

type Manifest = {
  version: string;
  bin?: Record<string, string>;
  exports?: Record<string, { import?: string }>;
  dependencies?: Record<string, string>;
};

const read = (path: string): Manifest =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as Manifest;

const root = read("../package.json");
const alias = read("../packages/clawrouter-alias/package.json");

describe("clawrouter alias package", () => {
  it("its dependency range still covers the current release", () => {
    // A caret range on 0.x stops at the minor: ^0.12.316 never installs 0.13.0.
    const range = alias.dependencies?.["@blockrun/clawrouter"] ?? "";
    const match = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
    expect(match, `unexpected range ${range}`).not.toBeNull();
    const [, major, minor, patch] = match!.map(Number);
    const [rMajor, rMinor, rPatch] = root.version.split(/[+-]/, 1)[0]!.split(".").map(Number);
    expect([rMajor, rMinor], "main package left the alias's range: republish it").toEqual([
      major,
      minor,
    ]);
    expect(rPatch).toBeGreaterThanOrEqual(patch!);
  });

  it("the CLI it imports sits next to the main entry, where its bin script looks", () => {
    // bin/clawrouter.js: new URL("./cli.js", import.meta.resolve("@blockrun/clawrouter"))
    const entry = root.exports?.["."]?.import ?? "";
    const cli = root.bin?.clawrouter ?? "";
    expect(new URL("./cli.js", new URL(entry, "file:///pkg/")).href).toBe(
      new URL(cli, "file:///pkg/").href,
    );
    expect(
      readFileSync(
        new URL("../packages/clawrouter-alias/bin/clawrouter.js", import.meta.url),
        "utf8",
      ),
    ).toContain('new URL("./cli.js"');
  });
});
