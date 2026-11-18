# Publishing the `clawrouter` alias

The unscoped npm name `clawrouter` is held by BlockRun so that `npx clawrouter`
(still written in third-party docs, e.g. Continue's) runs the official
`@blockrun/clawrouter` and nothing else (GHSA-c2qw-vppx-3p8r). This directory is
the source of what is published under that name. It is not part of the main
package's tarball and CI does not publish it.

The dependency is a caret range, so new `@blockrun/clawrouter` patch releases
reach alias users without republishing. Republish only when:

- the main package leaves `0.12.x` (a caret range on `0.x` stops at the minor);
  `src/clawrouter-alias.test.ts` fails when that happens;
- `@blockrun/clawrouter` moves its CLI away from `dist/cli.js` next to its main
  entry, which the bin script assumes (the same test checks it).

To publish, from this directory, with an npm login that owns `clawrouter`:

```sh
npm version patch   # or minor for a dependency range change
npm publish --access public
```

Then check `npx -y clawrouter@latest --version` prints the current release.
