import { join } from "node:path";
import { readFile, readdir } from "node:fs/promises";

import { fileExists } from "./files.js";
import type { AdapterContext } from "./types.js";
import { ensureServiceToken, verifyClawRouter } from "./service-auth.js";

/** Keep in sync with the root package; runtime-version.test.ts enforces it. */
export const CLAWROUTER_PACKAGE_VERSION = "0.12.268";

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
  options: { enforceVersion?: boolean; ignoreScripts?: boolean; version?: string } = {},
): Promise<string> {
  if (options.version && options.enforceVersion) {
    const pinned = await findPinnedPackage(context, packageName, binaryName, options.version);
    if (pinned) return pinned;
  }
  const present = await findCommand(context, binaryName);
  if (present && !options.enforceVersion) return present;
  const result = await context.runCommand(
    "npm",
    [
      "install",
      ...(options.ignoreScripts ? ["--ignore-scripts"] : []),
      "--prefix",
      join(context.stateDir, "runtime"),
      `${packageName}@${options.version ?? "latest"}`,
    ],
    { timeoutMs: 600_000 },
  );
  if (result.code !== 0) {
    throw new Error(`Could not install ${packageName}: ${tail(result.stderr || result.stdout)}`);
  }
  const installed = managedBin(context, binaryName);
  if (!(await fileExists(installed)))
    throw new Error(`${packageName} installed without ${binaryName}`);
  if (options.version) {
    const verified = await packageVersion(join(context.stateDir, "runtime"), packageName);
    if (verified !== options.version) {
      throw new Error(
        `${packageName} ${options.version} was requested but npm installed ${verified ?? "an unknown version"}`,
      );
    }
  }
  return installed;
}

async function findPinnedPackage(
  context: AdapterContext,
  packageName: string,
  binaryName: string,
  version: string,
): Promise<string | null> {
  const roots: Array<{ root: string; binary: string }> = [
    {
      root: join(context.stateDir, "runtime"),
      binary: managedBin(context, binaryName),
    },
  ];
  const bundled = bundledBin(binaryName);
  if (bundled && process.resourcesPath) {
    roots.unshift({ root: join(process.resourcesPath, "runtime"), binary: bundled });
  }
  for (const candidate of roots) {
    if (
      (await fileExists(candidate.binary)) &&
      (await packageVersion(candidate.root, packageName)) === version
    ) {
      return candidate.binary;
    }
  }
  return null;
}

async function packageVersion(root: string, packageName: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(
      await readFile(join(root, "node_modules", ...packageName.split("/"), "package.json"), "utf8"),
    ) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

export async function proxyHealth(context: AdapterContext): Promise<boolean> {
  const { token } = await ensureServiceToken(context.stateDir);
  return verifyClawRouter(
    `${context.proxyBaseUrl.replace(/\/v1\/?$/, "")}/health`,
    context.fetch,
    token,
  );
}

export function tail(value: string, length = 600): string {
  const clean = value.trim();
  return clean.length > length ? clean.slice(-length) : clean;
}
