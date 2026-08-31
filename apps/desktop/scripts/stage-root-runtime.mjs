import { cp, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(desktopRoot, "../..");
const packageLink = join(desktopRoot, "runtime", "node_modules", "@blockrun", "clawrouter");

const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
if (manifest.name !== "@blockrun/clawrouter") {
  throw new Error(`Expected the ClawRouter repository root, found ${manifest.name ?? "unknown"}`);
}

const runtimePackage = await realpath(packageLink).catch(() => {
  throw new Error("Desktop runtime is not installed. Run npm run runtime:install first.");
});
const sourceDist = join(repositoryRoot, "dist");
const targetDist = join(runtimePackage, "dist");

await rm(targetDist, { recursive: true, force: true });
await cp(sourceDist, targetDist, { recursive: true, force: true });
await cp(join(repositoryRoot, "package.json"), join(runtimePackage, "package.json"), {
  force: true,
});

console.log(`Staged ${manifest.name}@${manifest.version} from the repository checkout.`);
