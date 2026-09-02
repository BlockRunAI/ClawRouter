import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ATOMIC_WRITER = /function atomicWrite\(filePath, data\) \{([\s\S]*?)\n\}/g;

describe("installer config file permissions", () => {
  for (const name of ["reinstall.sh", "update.sh"]) {
    it(`${name} keeps every atomic config write private`, () => {
      const script = readFileSync(new URL(`../scripts/${name}`, import.meta.url), "utf8");
      const writers = [...script.matchAll(ATOMIC_WRITER)].map((match) => match[1] ?? "");

      expect(writers.length).toBeGreaterThan(0);
      for (const writer of writers) {
        expect(writer).toContain("fs.writeFileSync(tmpPath, data, { mode: 0o600 })");
        expect(writer).toContain("fs.chmodSync(filePath, 0o600)");
      }

      const temporaryWrites = [...script.matchAll(/fs\.writeFileSync\((tmp|tmpPath),[^\n]+/g)].map(
        (match) => match[0],
      );
      expect(temporaryWrites.length).toBeGreaterThan(0);
      for (const write of temporaryWrites) expect(write).toContain("{ mode: 0o600 }");

      const renames = [...script.matchAll(/fs\.renameSync\((tmp|tmpPath), ([^)]+)\);/g)];
      expect(renames).toHaveLength(temporaryWrites.length);
      for (const rename of renames) {
        const destination = rename[2];
        expect(script.slice(rename.index, rename.index + 120)).toContain(
          `fs.chmodSync(${destination}, 0o600)`,
        );
      }
    });
  }
});
