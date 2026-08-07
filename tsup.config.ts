import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts", "src/router/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node22",
  splitting: false,
  noExternal: [/.*/],
  external: [...builtinModules.flatMap((m) => [m, `node:${m}`])],
  esbuildOptions(options) {
    // We and @blockrun/llm depend on each other, and `noExternal` inlines it. Its
    // `import { route, ... } from "@blockrun/clawrouter"` therefore resolves through
    // node_modules to the LAST PUBLISHED build of this package, and esbuild inlines
    // that whole stale bundle beside the one it is building — a second ClawRouter,
    // older, with its own module state, growing by one full copy every release
    // (3MB -> 10MB in v0.12.220). Point the back-import at our own source so it
    // dedupes into the graph instead. scripts/smoke-dist.mjs asserts the copy is gone.
    options.alias = {
      ...options.alias,
      "@blockrun/clawrouter": fileURLToPath(new URL("src/index.ts", import.meta.url)),
    };
  },
  // The identifier must not be `__cjs_createRequire`: the stale bundle above carries
  // its own `import { createRequire as __cjs_createRequire }`, and esbuild cannot
  // rename around a banner it never sees (banners are injected as raw text after the
  // bundle is built). The duplicate declaration is a load-time SyntaxError that
  // bricked the whole CLI in v0.12.220. Keep this name unique to us.
  banner: {
    js: `import { createRequire as __blockrun_createRequire } from 'node:module'; const require = __blockrun_createRequire(import.meta.url);`,
  },
});
