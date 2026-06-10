import { builtinModules } from "node:module";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node22",
  splitting: false,
  noExternal: [/.*/],
  external: [...builtinModules.flatMap((m) => [m, `node:${m}`])],
  banner: {
    js: `import { createRequire as __cjs_createRequire } from 'node:module'; const require = __cjs_createRequire(import.meta.url);`,
  },
});
