/**
 * Tests for OKX onchainos detection in auth.ts.
 *
 * Stub PATH lookup by setting XCLAWROUTER_ONCHAINOS_BIN to a fake CLI script.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { writeFile, mkdtemp, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectOnchainosWallet } from "./auth.js";

let tmpDir: string;
const ORIG_BIN = process.env.XCLAWROUTER_ONCHAINOS_BIN;

async function writeFakeCli(name: string, script: string): Promise<string> {
  const path = join(tmpDir, name);
  await writeFile(path, `#!/usr/bin/env node\n${script}\n`, "utf8");
  await chmod(path, 0o755);
  return path;
}

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "auth-okx-test-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  if (ORIG_BIN === undefined) delete process.env.XCLAWROUTER_ONCHAINOS_BIN;
  else process.env.XCLAWROUTER_ONCHAINOS_BIN = ORIG_BIN;
});

beforeEach(() => {
  delete process.env.XCLAWROUTER_ONCHAINOS_BIN;
});

afterEach(() => {
  delete process.env.XCLAWROUTER_ONCHAINOS_BIN;
});

describe("detectOnchainosWallet", () => {
  it("returns OKX address when onchainos is installed and logged in", async () => {
    const bin = await writeFakeCli(
      "okx-logged-in",
      `
      const args = process.argv.slice(2);
      if (args[0] === "--version") { process.stdout.write("1.0.0"); process.exit(0); }
      if (args[0] === "wallet" && args[1] === "status") {
        process.stdout.write(JSON.stringify({
          data: {
            loggedIn: true,
            email: "user@example.com",
            evmAddress: "0xCafe000000000000000000000000000000000001",
          }
        }));
        process.exit(0);
      }
      process.exit(2);
      `,
    );
    process.env.XCLAWROUTER_ONCHAINOS_BIN = bin;
    const detected = await detectOnchainosWallet();
    expect(detected).toBeDefined();
    expect(detected!.address).toBe("0xCafe000000000000000000000000000000000001");
    expect(detected!.email).toBe("user@example.com");
    expect(detected!.adapter).toBeDefined();
  });

  it("returns undefined when onchainos is installed but not logged in", async () => {
    const bin = await writeFakeCli(
      "okx-logged-out",
      `
      const args = process.argv.slice(2);
      if (args[0] === "--version") { process.stdout.write("1.0.0"); process.exit(0); }
      if (args[0] === "wallet" && args[1] === "status") {
        process.stdout.write(JSON.stringify({ data: { loggedIn: false } }));
        process.exit(0);
      }
      process.exit(2);
      `,
    );
    process.env.XCLAWROUTER_ONCHAINOS_BIN = bin;
    expect(await detectOnchainosWallet()).toBeUndefined();
  });

  it("returns undefined when the binary is missing", async () => {
    process.env.XCLAWROUTER_ONCHAINOS_BIN = join(tmpDir, "definitely-missing");
    expect(await detectOnchainosWallet()).toBeUndefined();
  });

  it("returns undefined when wallet status throws", async () => {
    const bin = await writeFakeCli(
      "okx-status-broken",
      `
      const args = process.argv.slice(2);
      if (args[0] === "--version") { process.stdout.write("1.0.0"); process.exit(0); }
      // Status exits non-zero — simulate broken wallet daemon.
      process.stderr.write("daemon down");
      process.exit(7);
      `,
    );
    process.env.XCLAWROUTER_ONCHAINOS_BIN = bin;
    expect(await detectOnchainosWallet()).toBeUndefined();
  });
});
