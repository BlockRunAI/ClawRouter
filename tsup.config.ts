import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";
import type { Plugin } from "esbuild";

/**
 * Packages that publish both a CommonJS and an ES build and must be bundled once,
 * as ES modules.
 *
 * Our source imports viem as ESM, but the Polymarket SDKs are CommonJS and
 * `require("viem")` / `require("viem/chains")`. esbuild resolves a require() through
 * the package's "require" export condition, so it inlined viem's `_cjs` build
 * (and ox's and abitype's beneath it) beside the `_esm` one: 2.8MB of second copy,
 * none of it tree-shakeable, every chain definition included. Two copies are also
 * two module identities (two `BaseError` classes, two chain objects) on the path
 * that signs Polymarket orders.
 *
 * Re-resolving those require() calls with the "import" condition points them at
 * the ESM build we already bundle; esbuild wraps it for require(). Verified
 * byte-identical on the SDK paths we use (Safe/proxy derivation, multisend and
 * proxy encoding, message and EIP-712 signatures). smoke-dist fails the build if a
 * `_cjs` file of these packages comes back.
 */
const ESM_ONLY = /^(viem|ox|abitype)(\/.*)?$/;
const esmOnlyDualPackages: Plugin = {
  name: "esm-only-dual-packages",
  setup(build) {
    build.onResolve({ filter: ESM_ONLY }, async (args) => {
      if (args.kind !== "require-call" || args.pluginData === "esm-only") return undefined;
      const resolved = await build.resolve(args.path, {
        kind: "import-statement",
        resolveDir: args.resolveDir,
        importer: args.importer,
        pluginData: "esm-only",
      });
      return resolved.errors.length > 0 ? undefined : { path: resolved.path };
    });
  },
};

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts", "src/router/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node22",
  splitting: false,
  // Whitespace and syntax only: identifiers stay intact, so a stack trace a user
  // pastes still names our functions (the .map files are not published). Cuts the
  // bundle ~30%. Full `minify` would save another ~1.7MB but mangle every name.
  minifyWhitespace: true,
  minifySyntax: true,
  // dist/metafile-esm.json lists every input file per output. smoke-dist reads it to
  // find duplicate packages; minified output no longer carries esbuild's
  // `// node_modules/...` comments, and the sourcemap maps viem's _cjs and _esm
  // builds back to the same src/ files. Not published (see package.json "files").
  metafile: true,
  esbuildPlugins: [esmOnlyDualPackages],
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
    // @blockrun/llm lazy-imports the Anthropic SDK for its own AnthropicClient,
    // which ClawRouter never uses. Inlined it is ~0.6MB, including an agent bash
    // tool built on child_process; external, it loads from node_modules (an
    // @blockrun/llm dependency) in the unlikely case it ever runs. Set here, not
    // in `external`: `noExternal: [/.*/]` wins over tsup's own external list.
    options.external = [...(options.external ?? []), "@anthropic-ai/sdk"];
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
