import { lstat, mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  canonicalWriteDestination,
  restoreFiles,
  snapshotFiles,
  type FileSnapshot,
} from "./files.js";
import type { AgentId } from "./types.js";

type SnapshotManifest = {
  version: 1;
  agent: AgentId;
  createdAt: string;
  files: FileSnapshot[];
};

export class ConfigurationTransaction {
  constructor(private readonly stateDir: string) {}

  private manifestPath(agent: AgentId): string {
    return join(this.stateDir, "backups", `${agent}.json`);
  }

  async ensureOriginalSnapshot(agent: AgentId, paths: string[]): Promise<SnapshotManifest> {
    const existing = await this.read(agent, paths);
    if (existing) return existing;
    const manifest: SnapshotManifest = {
      version: 1,
      agent,
      createdAt: new Date().toISOString(),
      files: await snapshotFiles(paths),
    };
    const path = this.manifestPath(agent);
    await mkdir(join(this.stateDir, "backups"), { recursive: true });
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    return manifest;
  }

  async run<T>(agent: AgentId, paths: string[], operation: () => Promise<T>): Promise<T> {
    const beforeAttempt = await snapshotFiles(paths);
    await this.ensureOriginalSnapshot(agent, paths);
    try {
      return await operation();
    } catch (error) {
      await restoreFiles(beforeAttempt);
      throw error;
    }
  }

  async restoreOriginal(agent: AgentId, paths: string[]): Promise<boolean> {
    const manifest = await this.read(agent, paths);
    if (!manifest) return false;
    await restoreFiles(manifest.files);
    await rm(this.manifestPath(agent), { force: true });
    return true;
  }

  async read(agent: AgentId, paths: string[]): Promise<SnapshotManifest | null> {
    try {
      const parsed = JSON.parse(await readFile(this.manifestPath(agent), "utf8")) as unknown;
      const manifest = validateManifest(parsed, agent, paths);
      await validateSymlinkTargets(manifest.files, agent);
      return manifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}

function validateManifest(value: unknown, agent: AgentId, paths: string[]): SnapshotManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${agent} backup manifest: expected an object.`);
  }
  const manifest = value as Record<string, unknown>;
  if (
    manifest.version !== 1 ||
    manifest.agent !== agent ||
    typeof manifest.createdAt !== "string" ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error(`Invalid ${agent} backup manifest metadata.`);
  }

  const allowed = new Set(paths);
  if (allowed.size !== paths.length || manifest.files.length !== allowed.size) {
    throw new Error(`Invalid ${agent} backup manifest path set.`);
  }
  const seen = new Set<string>();
  for (const candidate of manifest.files) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`Invalid ${agent} backup manifest file entry.`);
    }
    const file = candidate as Record<string, unknown>;
    if (typeof file.path !== "string" || !allowed.has(file.path) || seen.has(file.path)) {
      throw new Error(`Invalid ${agent} backup manifest path.`);
    }
    seen.add(file.path);
    if (typeof file.existed !== "boolean") {
      throw new Error(`Invalid ${agent} backup manifest existence flag.`);
    }
    if (
      file.mode !== undefined &&
      (!Number.isInteger(file.mode) || (file.mode as number) < 0 || (file.mode as number) > 0o777)
    ) {
      throw new Error(`Invalid ${agent} backup manifest file mode.`);
    }
    if (file.contentBase64 !== undefined && !isBase64(file.contentBase64)) {
      throw new Error(`Invalid ${agent} backup manifest content.`);
    }
    if (file.symlinkTarget !== undefined && typeof file.symlinkTarget !== "string") {
      throw new Error(`Invalid ${agent} backup manifest symlink target.`);
    }
    if (file.symlinkTargetExisted !== undefined && typeof file.symlinkTargetExisted !== "boolean") {
      throw new Error(`Invalid ${agent} backup manifest symlink state.`);
    }
    if (typeof file.resolvedPath !== "string") {
      throw new Error(`Invalid ${agent} backup manifest resolved path.`);
    }
  }
  return value as SnapshotManifest;
}

function isBase64(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  );
}

async function validateSymlinkTargets(files: FileSnapshot[], agent: AgentId): Promise<void> {
  for (const file of files) {
    let currentIsSymlink = false;
    let currentTarget: string | undefined;
    try {
      const metadata = await lstat(file.path);
      currentIsSymlink = metadata.isSymbolicLink();
      currentTarget = currentIsSymlink ? await readlink(file.path) : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const declaredIsSymlink = file.symlinkTarget !== undefined;
    if (currentIsSymlink !== declaredIsSymlink || currentTarget !== file.symlinkTarget) {
      throw new Error(`Invalid ${agent} backup manifest symlink target.`);
    }
    if ((await canonicalWriteDestination(file.path)) !== file.resolvedPath) {
      throw new Error(`Invalid ${agent} backup manifest resolved path.`);
    }
  }
}
