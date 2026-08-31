import { spawn } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

import type { CommandResult, CommandRunner } from "./types.js";

export const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const TRUNCATION_MARKER = "[earlier command output truncated]\n";

function appendBoundedOutput(current: string, chunk: Buffer | string): string {
  const currentBytes = Buffer.from(current);
  const chunkBytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (currentBytes.byteLength + chunkBytes.byteLength <= MAX_COMMAND_OUTPUT_BYTES) {
    return Buffer.concat([currentBytes, chunkBytes]).toString("utf8");
  }
  const marker = Buffer.from(TRUNCATION_MARKER);
  const combined = Buffer.concat([currentBytes, chunkBytes]);
  const keep = Math.max(0, MAX_COMMAND_OUTPUT_BYTES - marker.byteLength);
  return Buffer.concat([
    marker,
    combined.subarray(Math.max(0, combined.byteLength - keep)),
  ]).toString("utf8");
}

export const runCommand: CommandRunner = (command, args, options = {}) =>
  new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout = appendBoundedOutput(stdout, chunk)));
    child.stderr.on("data", (chunk: Buffer) => (stderr = appendBoundedOutput(stderr, chunk)));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${options.timeoutMs ?? 120_000}ms`));
    }, options.timeoutMs ?? 120_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });

export async function commandExists(command: string): Promise<boolean> {
  const result = await runCommand(process.platform === "win32" ? "where" : "which", [command], {
    timeoutMs: 5_000,
  }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  return result.code === 0;
}

/** Make Electron's embedded Node available to package `.bin` shebangs. */
export async function withEmbeddedNode(
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  if (!process.versions.electron) return env;
  const binDir = join(stateDir, "embedded-node");
  await mkdir(binDir, { recursive: true });
  if (process.platform === "win32") {
    await writeFile(join(binDir, "node.cmd"), `@"${process.execPath}" %*\r\n`, { mode: 0o700 });
  } else {
    const shim = join(binDir, "node");
    await symlink(process.execPath, shim).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  }
  return {
    ...env,
    ELECTRON_RUN_AS_NODE: "1",
    PATH: `${binDir}${delimiter}${env.PATH ?? ""}`,
  };
}
