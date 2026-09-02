import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { upsertDshConfig } from "../electron/core/config.js";

const dshBin = process.env.DSH_BIN;
const dshNode = process.env.DSH_NODE;

describe("official DSH CLI compatibility", () => {
  it.runIf(Boolean(dshBin))(
    "accepts a profile with ClawRouter's current settings schema",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "clawrouter-dsh-cli-"));
      await upsertDshConfig(
        join(home, "settings.yaml"),
        join(home, ".credentials.yaml"),
        "http://127.0.0.1:8402/v1",
        ["auto", "anthropic/claude-sonnet-4.6"],
        "auto",
      );
      const result = await execute(
        dshNode ?? dshBin!,
        [...(dshNode ? [dshBin!] : []), "--profile", "web", "--dump-config"],
        {
          ...process.env,
          HOME: home,
          DSH_HOME: home,
          ...(dshNode ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        },
      );
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("llm-pi-ai");
    },
    60_000,
  );
});

function execute(command: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
