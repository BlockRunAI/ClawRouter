#!/usr/bin/env node

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

if (process.env.BLOCKRUN_CLAWROUTER_SKIP_POSTINSTALL === "1") {
  process.exit(0);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(root, "dist", "cli.js");

if (!existsSync(cliPath)) {
  process.exit(0);
}

const result = spawnSync(process.execPath, [cliPath, "setup"], {
  stdio: "inherit",
  env: {
    ...process.env,
    BLOCKRUN_CLAWROUTER_SKIP_POSTINSTALL: "1",
  },
});

if (result.status && result.status !== 0) {
  console.warn("[ClawRouter] OpenClaw setup did not complete; run `clawrouter setup` manually.");
}
