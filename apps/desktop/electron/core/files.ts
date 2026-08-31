import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export type FileSnapshot = {
  path: string;
  existed: boolean;
  contentBase64?: string;
  mode?: number;
  symlinkTarget?: string;
  symlinkTargetExisted?: boolean;
};

export async function fileExists(path: string): Promise<boolean> {
  return stat(path)
    .then(() => true)
    .catch(() => false);
}

export async function readText(path: string): Promise<string> {
  return readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
}

export async function atomicWrite(
  path: string,
  data: string | Uint8Array,
  mode = 0o600,
): Promise<void> {
  const destination = await resolveWriteDestination(path);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = join(dirname(destination), `.${randomUUID()}.tmp`);
  await writeFile(temporary, data, { mode });
  await rename(temporary, destination);
  await chmod(destination, mode);
}

async function resolveWriteDestination(path: string): Promise<string> {
  let current = path;
  const seen = new Set<string>();
  for (let depth = 0; depth < 16; depth += 1) {
    if (seen.has(current)) throw new Error(`Refusing cyclic configuration symlink: ${path}`);
    seen.add(current);
    try {
      const metadata = await lstat(current);
      if (!metadata.isSymbolicLink()) return current;
      current = resolve(dirname(current), await readlink(current));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return current;
      throw error;
    }
  }
  throw new Error(`Configuration symlink chain is too deep: ${path}`);
}

export async function snapshotFiles(paths: string[]): Promise<FileSnapshot[]> {
  return Promise.all(
    paths.map(async (path) => {
      try {
        const pathMetadata = await lstat(path);
        const symlinkTarget = pathMetadata.isSymbolicLink() ? await readlink(path) : undefined;
        let content: Buffer;
        let metadata;
        try {
          [content, metadata] = await Promise.all([readFile(path), stat(path)]);
        } catch (error) {
          if (symlinkTarget !== undefined && (error as NodeJS.ErrnoException).code === "ENOENT") {
            return { path, existed: true, symlinkTarget, symlinkTargetExisted: false };
          }
          throw error;
        }
        return {
          path,
          existed: true,
          contentBase64: content.toString("base64"),
          mode: metadata.mode & 0o777,
          ...(symlinkTarget === undefined ? {} : { symlinkTarget, symlinkTargetExisted: true }),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, existed: false };
        throw error;
      }
    }),
  );
}

export async function restoreFiles(files: FileSnapshot[]): Promise<void> {
  for (const file of files) {
    if (!file.existed) {
      await rm(file.path, { force: true, recursive: false });
      continue;
    }
    if (file.symlinkTarget !== undefined) {
      await rm(file.path, { force: true, recursive: false });
      await mkdir(dirname(file.path), { recursive: true });
      await symlink(file.symlinkTarget, file.path);
      if (file.symlinkTargetExisted === false) {
        await rm(resolve(dirname(file.path), file.symlinkTarget), {
          force: true,
          recursive: false,
        });
        continue;
      }
    }
    await atomicWrite(
      file.path,
      Buffer.from(file.contentBase64 ?? "", "base64"),
      file.mode ?? 0o600,
    );
  }
}
