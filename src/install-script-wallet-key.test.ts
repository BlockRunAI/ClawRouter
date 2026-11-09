import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";

// GHSA-27x5-82hg-xwr6: update.sh used to derive the wallet address with
// `node -e "... privateKeyToAccount('$WALLET_KEY') ..."`, which put the private
// key in node's argv (world-readable via /proc/<pid>/cmdline on Linux).
// The key must reach node only through the key file, never the command line.

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const UPDATE_SH = readFileSync(new URL("../scripts/update.sh", import.meta.url), "utf8");
// Throwaway key, never funded.
const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

// Pull one top-level shell function out of the script. Heredoc-aware: the JS
// inside `<<'NODE'` has its own column-0 `}` lines that must not end the match.
function extractFunction(script: string, name: string): string {
  const lines = script.split("\n");
  const start = lines.indexOf(`${name}() {`);
  if (start === -1) throw new Error(`${name} not found in update.sh`);
  let heredocEnd: string | null = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (heredocEnd) {
      if (line === heredocEnd) heredocEnd = null;
      continue;
    }
    const opener = line.match(/<<-?'?(\w+)'?/);
    if (opener) heredocEnd = opener[1] ?? null;
    else if (line === "}") return lines.slice(start, i + 1).join("\n");
  }
  throw new Error(`${name} has no closing brace`);
}

const DERIVE_FNS = ["derive_wallet_address", "print_wallet_address"]
  .map((name) => extractFunction(UPDATE_SH, name))
  .join("\n");
// Prefer /bin/bash: on macOS it is bash 3.2, the oldest parser users run this with.
const BASH = existsSync("/bin/bash") ? "/bin/bash" : "bash";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("update.sh wallet address derivation", () => {
  it("never interpolates a wallet key into a node program", () => {
    // Any `$WALLET_KEY` / `$FINAL_KEY` / `${...KEY}` inside a double-quoted
    // `node -e "..."` body is expanded by bash into node's argv.
    const programs = [...UPDATE_SH.matchAll(/node -e "([\s\S]*?)"/g)].map((m) => m[1] ?? "");
    expect(programs.length).toBeGreaterThan(0);
    for (const program of programs) {
      expect(program).not.toMatch(/\$\{?[A-Z_]*KEY\b/);
      expect(program).not.toContain("privateKeyToAccount");
    }
  });

  it("derives the right address without the key ever appearing in argv", () => {
    const dir = mkdtempSync(join(tmpdir(), "clawrouter-wallet-argv-"));
    dirs.push(dir);
    const keyFile = join(dir, "wallet.key");
    writeFileSync(keyFile, `${TEST_KEY}\n`, { mode: 0o600 });

    // A `node` shim first on PATH records every argv it receives, then runs the
    // real node with the same argv and stdin.
    const argvLog = join(dir, "argv.log");
    const shimDir = join(dir, "bin");
    mkdirSync(shimDir);
    const realNode = process.execPath;
    writeFileSync(
      join(shimDir, "node"),
      `#!/bin/bash\nprintf '%s\\n' "$@" >> "${argvLog}"\nexec "${realNode}" "$@"\n`,
    );
    chmodSync(join(shimDir, "node"), 0o755);

    const script = `${DERIVE_FNS}\nderive_wallet_address "$1" "FALLBACK"\n`;
    const out = execFileSync(BASH, ["-c", script, "bash", keyFile], {
      env: {
        ...process.env,
        PATH: `${shimDir}:${process.env.PATH}`,
        ACTIVE_PACKAGE_DIR: REPO_ROOT,
      },
      encoding: "utf8",
    }).trim();

    expect(out).toBe(privateKeyToAccount(TEST_KEY).address);
    const argv = readFileSync(argvLog, "utf8");
    expect(argv.length).toBeGreaterThan(0);
    expect(argv).not.toContain(TEST_KEY.slice(2));
  });

  it("prints the fallback, not an error, when the key file is unusable", () => {
    const dir = mkdtempSync(join(tmpdir(), "clawrouter-wallet-argv-"));
    dirs.push(dir);
    const keyFile = join(dir, "wallet.key");
    writeFileSync(keyFile, "not-a-key\n", { mode: 0o600 });

    const out = execFileSync(
      BASH,
      ["-c", `${DERIVE_FNS}\nderive_wallet_address "$1" "FALLBACK"\n`, "bash", keyFile],
      { env: { ...process.env, ACTIVE_PACKAGE_DIR: REPO_ROOT }, encoding: "utf8" },
    ).trim();
    expect(out).toBe("FALLBACK");
  });
});
