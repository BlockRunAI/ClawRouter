/**
 * Auto-update checker for ClawRouter.
 * Checks npm registry on startup and notifies user if update available.
 */

import { VERSION } from "./version.js";

const NPM_REGISTRY = "https://registry.npmjs.org/@twzrd1111/clawrouter/latest";
const CHECK_TIMEOUT_MS = 5_000; // Don't block startup for more than 5s

/**
 * Compare semver versions. Returns:
 *  1 if a > b
 *  0 if a === b
 * -1 if a < b
 */
function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

/**
 * Check npm registry for latest version.
 * Non-blocking, silent on errors.
 */
export async function checkForUpdates(): Promise<void> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);

    const res = await fetch(NPM_REGISTRY, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timeout);

    if (!res.ok) return;

    const data = (await res.json()) as { version?: string };
    const latest = data.version;

    if (!latest) return;

    if (compareSemver(latest, VERSION) > 0) {
      console.log("");
      console.log(`\x1b[33m⬆️  ClawRouter ${latest} available (you have ${VERSION})\x1b[0m`);
      console.log(`   Run: \x1b[36mnpx @twzrd1111/clawrouter@latest\x1b[0m`);
      console.log(`   Docs: \x1b[36mhttps://blockrun.ai/clawrouter.md\x1b[0m`);
      console.log("");
    }
  } catch {
    // Silent fail - don't disrupt startup
  }
}
