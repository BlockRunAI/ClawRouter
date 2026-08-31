import { join } from "node:path";
import { readdir } from "node:fs/promises";

import { fileExists } from "./files.js";
import type { AdapterContext } from "./types.js";

export function managedBin(context: AdapterContext, name: string): string {
  const suffix = process.platform === "win32" ? ".cmd" : "";
  return join(context.stateDir, "runtime", "node_modules", ".bin", `${name}${suffix}`);
}

export function bundledBin(name: string): string | null {
  if (!process.versions.electron || !process.resourcesPath) return null;
  const suffix = process.platform === "win32" ? ".cmd" : "";
  return join(process.resourcesPath, "runtime", "node_modules", ".bin", `${name}${suffix}`);
}

export async function findCommand(context: AdapterContext, name: string): Promise<string | null> {
  const bundled = bundledBin(name);
  if (bundled && (await fileExists(bundled))) return bundled;
  const managed = managedBin(context, name);
  if (await fileExists(managed)) return managed;
  const suffix = process.platform === "win32" ? ".exe" : "";
  const candidates = [
    join(context.homeDir, ".local", "bin", `${name}${suffix}`),
    join(context.homeDir, ".npm-global", "bin", `${name}${suffix}`),
    join(context.homeDir, ".local", "share", "pnpm", `${name}${suffix}`),
    join(context.homeDir, ".volta", "bin", `${name}${suffix}`),
    join(context.homeDir, ".bun", "bin", `${name}${suffix}`),
    join(context.homeDir, ".asdf", "shims", `${name}${suffix}`),
    join(context.homeDir, ".hermes", "hermes-agent", "venv", "bin", `${name}${suffix}`),
    join("/opt/homebrew/bin", `${name}${suffix}`),
    join("/usr/local/bin", `${name}${suffix}`),
  ];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  const nvm = await findNvmCommand(context.homeDir, `${name}${suffix}`);
  if (nvm) return nvm;
  return (await context.commandExists(name)) ? name : null;
}

async function findNvmCommand(homeDir: string, binaryName: string): Promise<string | null> {
  const versionsDir = join(homeDir, ".nvm", "versions", "node");
  try {
    const versions = (await readdir(versionsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions) {
      const candidate = join(versionsDir, version, "bin", binaryName);
      if (await fileExists(candidate)) return candidate;
    }
  } catch {
    // NVM is optional.
  }
  return null;
}

export async function ensureNpmPackage(
  context: AdapterContext,
  packageName: string,
  binaryName: string,
  options: { ignoreScripts?: boolean } = {},
): Promise<string> {
  const present = await findCommand(context, binaryName);
  if (present) return present;
  const result = await context.runCommand(
    "npm",
    [
      "install",
      ...(options.ignoreScripts ? ["--ignore-scripts"] : []),
      "--prefix",
      join(context.stateDir, "runtime"),
      `${packageName}@latest`,
    ],
    { timeoutMs: 600_000 },
  );
  if (result.code !== 0) {
    throw new Error(`Could not install ${packageName}: ${tail(result.stderr || result.stdout)}`);
  }
  const installed = managedBin(context, binaryName);
  if (!(await fileExists(installed)))
    throw new Error(`${packageName} installed without ${binaryName}`);
  return installed;
}

export async function proxyHealth(context: AdapterContext): Promise<boolean> {
  try {
    const response = await context.fetch(`${context.proxyBaseUrl.replace(/\/v1\/?$/, "")}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function tail(value: string, length = 600): string {
  const clean = value.trim();
  return clean.length > length ? clean.slice(-length) : clean;
}
