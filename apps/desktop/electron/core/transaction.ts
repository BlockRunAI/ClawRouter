import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { restoreFiles, snapshotFiles, type FileSnapshot } from "./files.js";
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
    const existing = await this.read(agent);
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

  async restoreOriginal(agent: AgentId): Promise<boolean> {
    const manifest = await this.read(agent);
    if (!manifest) return false;
    await restoreFiles(manifest.files);
    await rm(this.manifestPath(agent), { force: true });
    return true;
  }

  async read(agent: AgentId): Promise<SnapshotManifest | null> {
    try {
      return JSON.parse(await readFile(this.manifestPath(agent), "utf8")) as SnapshotManifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}
