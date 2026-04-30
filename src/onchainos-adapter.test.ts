/**
 * Unit tests for OnchainOsAdapter against the real onchainos CLI surface
 * (per the okxclawrouter sample). Uses a fake CLI script so we don't depend
 * on the actual binary.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFile, mkdtemp, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OnchainOsAdapter, OnchainOsCliError } from "./onchainos-adapter.js";

let tmpDir: string;

async function writeFakeCli(name: string, script: string): Promise<string> {
  const path = join(tmpDir, name);
  await writeFile(path, `#!/usr/bin/env node\n${script}\n`, "utf8");
  await chmod(path, 0o755);
  return path;
}

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "onchainos-adapter-test-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("OnchainOsAdapter.isInstalled", () => {
  it("returns true when the binary responds to --version", async () => {
    const bin = await writeFakeCli(
      "version-ok",
      `if (process.argv[2] === "--version") { process.stdout.write("onchainos 1.2.3"); process.exit(0); } process.exit(2);`,
    );
    expect(new OnchainOsAdapter({ bin }).isInstalled()).toBe(true);
  });

  it("returns false when the binary is missing", () => {
    const adapter = new OnchainOsAdapter({ bin: join(tmpDir, "does-not-exist") });
    expect(adapter.isInstalled()).toBe(false);
  });
});

describe("OnchainOsAdapter.status", () => {
  it("unwraps the .data envelope returned by real onchainos", async () => {
    const bin = await writeFakeCli(
      "status-data-envelope",
      `
      const args = process.argv.slice(2);
      if (args.join(" ") === "wallet status") {
        process.stdout.write(JSON.stringify({
          data: {
            loggedIn: true,
            email: "vicky.fuyu@gmail.com",
            evmAddress: "0x1234567890123456789012345678901234567890"
          }
        }));
        process.exit(0);
      }
      process.exit(2);
      `,
    );
    const adapter = new OnchainOsAdapter({ bin });
    const status = await adapter.status();
    expect(status.loggedIn).toBe(true);
    expect(status.email).toBe("vicky.fuyu@gmail.com");
    expect(status.evmAddress).toBe("0x1234567890123456789012345678901234567890");
  });

  it("accepts the legacy flat shape (no .data envelope)", async () => {
    const bin = await writeFakeCli(
      "status-flat",
      `process.stdout.write(JSON.stringify({ loggedIn: true, evmAddress: "0xAbC0000000000000000000000000000000000001" })); process.exit(0);`,
    );
    const status = await new OnchainOsAdapter({ bin }).status();
    expect(status.loggedIn).toBe(true);
    expect(status.evmAddress).toBe("0xAbC0000000000000000000000000000000000001");
  });

  it("reports loggedIn=false when onchainos says so", async () => {
    const bin = await writeFakeCli(
      "status-out",
      `process.stdout.write(JSON.stringify({ data: { loggedIn: false } })); process.exit(0);`,
    );
    const status = await new OnchainOsAdapter({ bin }).status();
    expect(status.loggedIn).toBe(false);
    expect(status.evmAddress).toBeUndefined();
  });

  it("throws OnchainOsCliError when binary is missing", async () => {
    const adapter = new OnchainOsAdapter({ bin: join(tmpDir, "missing") });
    await expect(adapter.status()).rejects.toBeInstanceOf(OnchainOsCliError);
  });

  it("throws on invalid JSON output", async () => {
    const bin = await writeFakeCli(
      "status-bad-json",
      `process.stdout.write("not json"); process.exit(0);`,
    );
    await expect(new OnchainOsAdapter({ bin }).status()).rejects.toMatchObject({
      name: "OnchainOsCliError",
    });
  });
});

describe("OnchainOsAdapter.signX402Payment", () => {
  it("invokes `payment x402-pay --accepts <json>` and unwraps the result", async () => {
    const bin = await writeFakeCli(
      "x402-pay-ok",
      `
      const args = process.argv.slice(2);
      if (args[0] === "payment" && args[1] === "x402-pay" && args[2] === "--accepts") {
        const accepts = JSON.parse(args[3]);
        process.stdout.write(JSON.stringify({
          data: {
            signature: "0x" + "ab".repeat(65),
            authorization: { from: "0xPAYER", to: "0xPAYEE", scheme: accepts[0].scheme },
          }
        }));
        process.exit(0);
      }
      process.exit(2);
      `,
    );
    const adapter = new OnchainOsAdapter({ bin });
    const result = await adapter.signX402Payment([
      {
        scheme: "exact",
        network: "base",
        maxAmountRequired: "10000",
      },
    ]);
    expect(result.signature).toBe("0x" + "ab".repeat(65));
    expect(result.authorization).toMatchObject({
      from: "0xPAYER",
      to: "0xPAYEE",
      scheme: "exact",
    });
    expect(result.sessionCert).toBeUndefined();
  });

  it("preserves sessionCert for aggr_deferred scheme", async () => {
    const bin = await writeFakeCli(
      "x402-pay-cert",
      `
      process.stdout.write(JSON.stringify({
        data: {
          signature: "0xfeedface",
          authorization: { ok: true },
          sessionCert: "cert-xyz",
        }
      }));
      process.exit(0);
      `,
    );
    const result = await new OnchainOsAdapter({ bin }).signX402Payment([
      { scheme: "aggr_deferred" },
    ]);
    expect(result.sessionCert).toBe("cert-xyz");
  });

  it("throws when onchainos returns no signature", async () => {
    const bin = await writeFakeCli(
      "x402-pay-bad",
      `process.stdout.write(JSON.stringify({ data: { authorization: {} } })); process.exit(0);`,
    );
    await expect(
      new OnchainOsAdapter({ bin }).signX402Payment([{ scheme: "exact" }]),
    ).rejects.toBeInstanceOf(OnchainOsCliError);
  });

  it("throws when onchainos returns no authorization", async () => {
    const bin = await writeFakeCli(
      "x402-pay-bad-auth",
      `process.stdout.write(JSON.stringify({ data: { signature: "0xabcd" } })); process.exit(0);`,
    );
    await expect(
      new OnchainOsAdapter({ bin }).signX402Payment([{ scheme: "exact" }]),
    ).rejects.toBeInstanceOf(OnchainOsCliError);
  });
});

describe("OnchainOsAdapter.login validation", () => {
  it("rejects malformed emails before invoking the CLI", async () => {
    const adapter = new OnchainOsAdapter({ bin: join(tmpDir, "unused") });
    await expect(adapter.login("not-an-email")).rejects.toThrow(/Invalid email/);
  });
});
