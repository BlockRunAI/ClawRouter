import { defineConfig } from "tsup";

// The host package and the optional peers stay external: nothing of ClawRouter, mppx or pay-kit is inlined.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2022",
  dts: true,
  clean: true,
  external: [
    "@blockrun/clawrouter",
    "mppx",
    /^mppx\//,
    "@solana/pay-kit",
    /^@solana\/pay-kit\//,
    "@solana/kit",
    "viem",
    /^viem\//,
  ],
});
