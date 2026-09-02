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
});
