import { configDefaults, defineConfig } from "vitest/config";

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
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "test/integration/**"],
  },
});
