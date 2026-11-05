import { defineConfig } from "tsup";

// Keep the host and optional payment SDKs external to this package.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2022",
  dts: true,
  clean: true,
  external: [
    "@twzrd1111/clawrouter",
    "mppx",
    /^mppx\//,
    "@solana/mpp",
    /^@solana\/mpp\//,
    "@solana/kit",
    "viem",
    /^viem\//,
  ],
});
