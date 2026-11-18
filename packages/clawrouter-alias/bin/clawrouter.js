#!/usr/bin/env node
// `clawrouter` is an alias held by BlockRun so the unscoped name always runs the
// official package. The real CLI lives in @blockrun/clawrouter; it starts on import.
const entry = import.meta.resolve("@blockrun/clawrouter");
await import(new URL("./cli.js", entry).href);
