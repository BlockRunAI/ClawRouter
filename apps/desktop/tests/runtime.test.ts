import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { ensureNpmPackage } from "../electron/core/runtime.js";
import type { AdapterContext } from "../electron/core/types.js";

describe("managed runtime package pins", () => {
  it("replaces a stale managed binary instead of silently reusing it", async () => {
    const home = await mkdtemp(join(tmpdir(), "clawrouter-runtime-pin-"));
    const stateDir = join(home, ".clawrouter-desktop");
    const runtime = join(stateDir, "runtime");
    const binary = join(runtime, "node_modules", ".bin", "example");
    const manifest = join(runtime, "node_modules", "@example", "tool", "package.json");
    await mkdir(dirname(binary), { recursive: true });
    await mkdir(dirname(manifest), { recursive: true });
    await writeFile(binary, "stale\n");
    await writeFile(manifest, JSON.stringify({ version: "1.0.0" }));
    const commands: string[][] = [];
    const context = {
      homeDir: home,
      stateDir,
      proxyBaseUrl: "http://127.0.0.1:8402/v1",
      commandExists: async () => true,
      fetch: globalThis.fetch,
      runCommand: async (_command: string, args: string[]) => {
        commands.push(args);
        await writeFile(manifest, JSON.stringify({ version: "2.0.0" }));
        return { code: 0, stdout: "", stderr: "" };
      },
    } satisfies AdapterContext;

    await expect(
      ensureNpmPackage(context, "@example/tool", "example", {
        enforceVersion: true,
        version: "2.0.0",
      }),
    ).resolves.toBe(binary);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("@example/tool@2.0.0");
  });
});
