import { readFileSync } from "node:fs";
import { configDefaults, defineConfig } from "vitest/config";
import { compareVersions, formatVersion, parseVersion, rangeFloor } from "./test/node-engines";

/**
 * Refuse to run on a Node below `engines.node`. Below it the suite does not fail
 * cleanly: on Node 22.14 `test/upstream-proxy.test.ts` dies at import with
 * "Cannot read properties of undefined (reading 'bind')" inside undici, because
 * undici 8 binds `zlib.createZstdDecompress`, which Node only added in 22.15.
 * Every other file passes, so the run looks like one broken test rather than an
 * unsupported runtime. Say which it is instead.
 */
const { engines } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const nodeFloor = rangeFloor(engines.node);
const running = parseVersion(process.versions.node);
if (!nodeFloor || !running) {
  throw new Error(
    `vitest.config.ts: cannot compare Node ${process.versions.node} to engines.node "${engines.node}"`,
  );
}
if (compareVersions(running, nodeFloor) < 0) {
  throw new Error(
    `ClawRouter needs Node ${formatVersion(nodeFloor)} or newer (engines.node "${engines.node}"); this is Node ${process.versions.node}. Use Node 24 (see .nvmrc).`,
  );
}

/**
 * Default test run: hermetic tests only.
 *
 * `test/integration/**` drives a live proxy against the real BlockRun gateway,
 * so it cannot run anywhere without network access to that gateway — on a CI
 * runner those requests hang past even their own 30s timeouts. Without this
 * exclude, vitest's default glob swept them into `npm test`, which gates the
 * npm publish workflow, so a release could be blocked by runner networking
 * rather than by anything wrong with the code.
 *
 * They keep their own config (`vitest.integration.config.ts`, 30s timeouts)
 * and run on demand via `npm run test:integration`.
 */
// Unit tests must not fetch public picker policy from GitHub.
process.env.BLOCKRUN_MODEL_CATALOG_URL ??= "";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "test/integration/**"],
  },
});
