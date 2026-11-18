import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { compareVersions, formatVersion, rangeFloor } from "./node-engines.js";

const readJson = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

const pkg = readJson("../package.json") as {
  dependencies: Record<string, string>;
  engines: { node: string };
};

// tsup inlines every runtime dependency into dist (`noExternal: [/.*/]`), so a
// dependency's Node floor is ClawRouter's Node floor whether or not npm warns.
// undici 8 (declared `>=22.19.0`) calls `zlib.createZstdDecompress.bind(...)`
// at module load; on Node 22.14 that is `undefined.bind` and the import throws,
// which broke upstream-proxy for users on early 22.x while `engines` said `>=22`.
describe("engines.node", () => {
  const ownFloor = rangeFloor(pkg.engines.node);

  it("is a plain lower bound", () => {
    expect(ownFloor, `engines.node "${pkg.engines.node}" is not a ">=X.Y.Z" range`).not.toBeNull();
  });

  const deps = Object.keys(pkg.dependencies).map((name) => {
    // Read the file directly: some packages' `exports` do not expose ./package.json.
    const manifest = readJson(`../node_modules/${name}/package.json`) as {
      engines?: { node?: string };
    };
    return { name, range: manifest.engines?.node };
  });

  it("checks at least one dependency that declares a Node floor", () => {
    expect(deps.filter((d) => d.range).map((d) => d.name)).toContain("undici");
  });

  for (const { name, range } of deps) {
    if (!range) continue;
    it(`covers ${name} (${range})`, () => {
      const floor = rangeFloor(range);
      expect(floor, `${name} engines.node "${range}" is not a ">=X.Y.Z" range`).not.toBeNull();
      expect(
        compareVersions(ownFloor!, floor!),
        `engines.node "${pkg.engines.node}" is below ${name}'s floor ${formatVersion(floor!)}`,
      ).toBeGreaterThanOrEqual(0);
    });
  }
});
