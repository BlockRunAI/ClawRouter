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
  // The identifier must not be `__cjs_createRequire`: a bundled dependency emits its
  // own `import { createRequire as __cjs_createRequire } from "module"` into the same
  // ESM scope, and the duplicate declaration is a load-time SyntaxError that bricked
  // the whole CLI in v0.12.220. Keep this name unique to us.
  banner: {
    js: `import { createRequire as __blockrun_createRequire } from 'node:module'; const require = __blockrun_createRequire(import.meta.url);`,
  },
});
