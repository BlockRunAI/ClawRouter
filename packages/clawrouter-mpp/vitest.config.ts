import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Until the seam release is published, the host package resolves to the repo source (same as tsconfig paths).
process.env.BLOCKRUN_MODEL_CATALOG_URL ??= "";
export default defineConfig({
  resolve: {
    alias: {
      "@blockrun/clawrouter": fileURLToPath(new URL("../../src/index.ts", import.meta.url)),
    },
  },
});
