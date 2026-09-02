import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ConfigurationTransaction } from "../electron/core/transaction.js";
import { atomicWrite, canonicalWriteDestination } from "../electron/core/files.js";

describe("ConfigurationTransaction", () => {
  it("rolls a failed attempt back without losing the original uninstall snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "clawrouter-transaction-"));
    const target = join(root, "config.toml");
    await writeFile(target, "original\n", { mode: 0o640 });
    const transaction = new ConfigurationTransaction(join(root, "state"));

    await transaction.run("codex", [target], async () => {
      await writeFile(target, "installed\n");
    });
    await expect(
      transaction.run("codex", [target], async () => {
        await writeFile(target, "broken\n");
        throw new Error("verification failed");
      }),
    ).rejects.toThrow("verification failed");

    expect(await readFile(target, "utf8")).toBe("installed\n");
    expect(await transaction.restoreOriginal("codex", [target])).toBe(true);
    expect(await readFile(target, "utf8")).toBe("original\n");
    expect((await stat(target)).mode & 0o777).toBe(0o640);
  });

  it("removes a file that did not exist before installation", async () => {
    const root = await mkdtemp(join(tmpdir(), "clawrouter-transaction-"));
    const target = join(root, "new.yaml");
    const transaction = new ConfigurationTransaction(join(root, "state"));
    await transaction.run("dsh", [target], async () => writeFile(target, "created\n"));
    await transaction.restoreOriginal("dsh", [target]);
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a managed symlink and restores its target content exactly", async () => {
    const root = await mkdtemp(join(tmpdir(), "clawrouter-transaction-"));
    const target = join(root, "dotfiles", "config.toml");
    const link = join(root, "home", ".codex", "config.toml");
    await mkdir(join(root, "dotfiles"), { recursive: true });
    await mkdir(join(root, "home", ".codex"), { recursive: true });
    await writeFile(target, "original through symlink\n", { mode: 0o640 });
    await symlink(target, link);
    const transaction = new ConfigurationTransaction(join(root, "state"));

    await transaction.run("codex", [link], async () => {
      await atomicWrite(link, "installed through symlink\n", 0o600);
    });
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe("installed through symlink\n");

    expect(await transaction.restoreOriginal("codex", [link])).toBe(true);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe(target);
    expect(await readFile(target, "utf8")).toBe("original through symlink\n");
    expect((await stat(target)).mode & 0o777).toBe(0o640);
  });

  it("rejects a forged manifest path before touching the filesystem", async () => {
    const root = await mkdtemp(join(tmpdir(), "clawrouter-transaction-"));
    const target = join(root, "config.toml");
    const outside = join(root, "outside.txt");
    const state = join(root, "state");
    await mkdir(join(state, "backups"), { recursive: true });
    await writeFile(target, "managed\n");
    await writeFile(outside, "do not overwrite\n");
    await writeFile(
      join(state, "backups", "codex.json"),
      JSON.stringify({
        version: 1,
        agent: "codex",
        createdAt: new Date().toISOString(),
        files: [
          {
            path: outside,
            existed: true,
            contentBase64: Buffer.from("forged\n").toString("base64"),
            mode: 0o600,
          },
        ],
      }),
    );
    const transaction = new ConfigurationTransaction(state);

    await expect(transaction.restoreOriginal("codex", [target])).rejects.toThrow(
      "backup manifest path",
    );
    expect(await readFile(outside, "utf8")).toBe("do not overwrite\n");
  });

  it("rejects a forged symlink target before overwriting or deleting it", async () => {
    const root = await mkdtemp(join(tmpdir(), "clawrouter-transaction-"));
    const safeTarget = join(root, "safe.txt");
    const outside = join(root, "outside.txt");
    const link = join(root, "config.toml");
    const state = join(root, "state");
    await writeFile(safeTarget, "safe\n");
    await writeFile(outside, "do not touch\n");
    await symlink(safeTarget, link);
    await mkdir(join(state, "backups"), { recursive: true });
    await writeFile(
      join(state, "backups", "codex.json"),
      JSON.stringify({
        version: 1,
        agent: "codex",
        createdAt: new Date().toISOString(),
        files: [
          {
            path: link,
            existed: true,
            symlinkTarget: outside,
            symlinkTargetExisted: false,
            contentBase64: Buffer.from("forged\n").toString("base64"),
            mode: 0o600,
            resolvedPath: await canonicalWriteDestination(link),
          },
        ],
      }),
    );

    const transaction = new ConfigurationTransaction(state);
    await expect(transaction.restoreOriginal("codex", [link])).rejects.toThrow(
      "backup manifest symlink target",
    );
    expect(await readFile(outside, "utf8")).toBe("do not touch\n");
    expect(await readlink(link)).toBe(safeTarget);
  });

  it("rejects a manifest that omits the current leaf symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "clawrouter-transaction-"));
    const target = join(root, "target.txt");
    const link = join(root, "config.toml");
    const state = join(root, "state");
    await writeFile(target, "do not touch\n");
    await symlink(target, link);
    await mkdir(join(state, "backups"), { recursive: true });
    await writeFile(
      join(state, "backups", "codex.json"),
      JSON.stringify({
        version: 1,
        agent: "codex",
        createdAt: new Date().toISOString(),
        files: [
          {
            path: link,
            existed: true,
            contentBase64: Buffer.from("forged\n").toString("base64"),
            mode: 0o600,
            resolvedPath: await canonicalWriteDestination(link),
          },
        ],
      }),
    );

    const transaction = new ConfigurationTransaction(state);
    await expect(transaction.restoreOriginal("codex", [link])).rejects.toThrow(
      "backup manifest symlink target",
    );
    expect(await readFile(target, "utf8")).toBe("do not touch\n");
  });
});
