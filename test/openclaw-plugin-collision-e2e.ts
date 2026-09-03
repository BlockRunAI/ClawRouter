/**
 * Release gate: OpenClaw 2026.8.2 plugin collision/migration path (#305, #307).
 *
 * Exercises the REAL installation path end to end — no mocks:
 *   1. isolated temporary HOME (the operator's ~/.openclaw is never touched)
 *   2. seeds a legacy `plugins.entries.clawrouter` entry (pre-rename BlockRun)
 *   3. installs the npm tarball packed from this repo via `openclaw plugins install`
 *   4. runs `openclaw gateway` and asserts BOTH routers coexist:
 *        - OpenClaw's bundled router keeps plugin id `clawrouter` (enabled, provider loaded)
 *        - BlockRun is plugin id `blockrun-clawrouter`
 *        - the legacy entry migrates away without clobbering either router
 *        - BlockRun's x402 proxy ACTIVATES (GET /health answers with a wallet)
 *   5. second scenario: a pre-rename opt-out (`enabled: false`) survives the
 *      installer's {enabled:true} default, the bundled router stays enabled,
 *      and the proxy stays DOWN on the next gateway boot
 *
 * Uses the real `openclaw` CLI. By default the pinned version is installed into
 * the sandbox (network required); set OPENCLAW_E2E_OPENCLAW to the path of an
 * existing openclaw.mjs to skip that, OPENCLAW_E2E_VERSION to change the pin,
 * OPENCLAW_E2E_KEEP=1 to preserve the sandbox for debugging.
 *
 * Run: npm run test:e2e:openclaw-collision
 */

import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OPENCLAW_VERSION = process.env.OPENCLAW_E2E_VERSION || "2026.8.2";
const KEEP = process.env.OPENCLAW_E2E_KEEP === "1";
const PROXY_PORT = 8402; // compiled into the plugin; BLOCKRUN_PROXY_PORT does not survive the gateway
const HEALTH_TIMEOUT_MS = 90_000;

interface CheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}

const results: CheckResult[] = [];
const children: { pid?: number }[] = [];
let sandbox: string | null = null;

function check(name: string, passed: boolean, detail?: string): boolean {
  results.push({ name, passed, detail });
  console.log(`  ${passed ? "✓" : "✗"} ${name}${!passed && detail ? `\n    ${detail}` : ""}`);
  return passed;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/** Shell out with output captured; throw (with captured output) on nonzero exit. */
function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string): string {
  const res: SpawnSyncReturns<string> = spawnSync(cmd, args, {
    env,
    cwd,
    encoding: "utf8",
    timeout: 600_000,
  });
  if (res.status !== 0 || res.error) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed (exit ${res.status}, ${res.error?.message ?? "no error"})\n` +
        `${res.stdout ?? ""}\n${res.stderr ?? ""}`,
    );
  }
  return res.stdout ?? "";
}

function runLogged(cmd: string, args: string[], env: NodeJS.ProcessEnv, logFile: string): string {
  const res: SpawnSyncReturns<string> = spawnSync(cmd, args, {
    env,
    encoding: "utf8",
    timeout: 600_000,
  });
  const output = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
  if (sandbox) appendFileSync(join(sandbox, logFile), `$ ${cmd} ${args.join(" ")}\n${output}\n`);
  if (res.status !== 0 || res.error) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed (exit ${res.status}, ${res.error?.message ?? "no error"})\n${output}`,
    );
  }
  return res.stdout ?? "";
}

/** Env for sandboxed children: redirect HOME, strip operator OpenClaw/BlockRun state. */
function sandboxEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ...extra };
  for (const k of [
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_PROFILE",
    "OPENCLAW_CONTAINER",
    "BLOCKRUN_WALLET_KEY",
    "BLOCKRUN_PROXY_PORT",
    "BLOCKRUN_WEB_SEARCH",
  ]) {
    delete env[k];
  }
  return env;
}

function readConfig(home: string): any {
  return JSON.parse(readFileSync(join(home, ".openclaw", "openclaw.json"), "utf8"));
}

/** Fresh isolated OpenClaw home with a legacy pre-rename plugin entry seeded. */
function seedHome(home: string, legacyEnabled: boolean): void {
  mkdirSync(join(home, ".openclaw"), { recursive: true });
  writeFileSync(
    join(home, ".openclaw", "openclaw.json"),
    JSON.stringify({ plugins: { entries: { clawrouter: { enabled: legacyEnabled } } } }, null, 2),
  );
}

function pluginListJson(openclawMjs: string, home: string): any[] {
  const out = run(process.execPath, [openclawMjs, "plugins", "list", "--json"], sandboxEnv(home));
  return (JSON.parse(out).plugins ?? []) as any[];
}

function installPlugin(openclawMjs: string, home: string, tarballPath: string): void {
  runLogged(
    process.execPath,
    [openclawMjs, "plugins", "install", "--force", "--accept-capabilities", tarballPath],
    sandboxEnv(home),
    `install-${home.split("/").pop()}.log`,
  );
}

async function startGateway(openclawMjs: string, home: string, gatewayPort: number, logName: string) {
  const logFd = openSync(join(sandbox!, logName), "a");
  const child = spawn(
    process.execPath,
    [openclawMjs, "gateway", "run", "--port", String(gatewayPort), "--allow-unconfigured"],
    {
      env: sandboxEnv(home),
      stdio: ["ignore", logFd, logFd],
      detached: true,
    },
  );
  child.unref();
  children.push(child);
  return child;
}

async function waitHealthy(proxyPort: number, timeoutMs: number): Promise<object | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${proxyPort}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return (await res.json()) as object;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 750));
  }
  return null;
}

async function stopGateway(child: { pid?: number; exitCode: number | null; signalCode: string | null }) {
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid!, "SIGTERM");
    } catch {
      return;
    }
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
      await new Promise((r) => setTimeout(r, 250));
    }
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}

function cleanup(): void {
  for (const child of children) {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  if (sandbox && !KEEP) {
    rmSync(sandbox, { recursive: true, force: true });
    console.log(`\nCleaned up sandbox ${sandbox}`);
  } else if (sandbox) {
    console.log(`\nSandbox kept for debugging: ${sandbox}`);
  }
}

async function main(): Promise<number> {
  console.log(
    `\n╔════════════════════════════════════════════════════════════════╗\n` +
      `║ Release gate: OpenClaw ${OPENCLAW_VERSION} plugin collision/migration         ║\n` +
      `╚════════════════════════════════════════════════════════════════╝\n`,
  );

  if (!existsSync(join(process.cwd(), "dist", "index.js"))) {
    console.error("dist/index.js missing — run `npm run build` first (or use the npm script).");
    return 2;
  }

  sandbox = mkdtempSync(join(tmpdir(), "clawrouter-openclaw-e2e-"));
  const homeA = join(sandbox, "home-enabled");
  const homeB = join(sandbox, "home-disabled");
  console.log(`Sandbox: ${sandbox}\n`);

  // The x402 proxy port is compiled in from BLOCKRUN_PROXY_PORT at plugin load
  // time inside the gateway process, and OpenClaw's gateway does not forward
  // that env var — the proxy binds 8402 regardless of what we export. Own the
  // port for the duration instead: refuse to run if something else holds it.
  const portProbe = spawnSync(
    process.execPath,
    ["-e", "require('node:net').createServer().listen(8402,'127.0.0.1',()=>process.exit(0))"],
    { timeout: 5000 },
  );
  if (portProbe.status !== 0) {
    console.error("Port 8402 is already in use — stop the running ClawRouter proxy and retry.");
    return 2;
  }

  // 1. Pack this repo's plugin; make the pinned OpenClaw CLI available.
  console.log("Packing @blockrun/clawrouter and provisioning the sandbox OpenClaw CLI…");
  run("npm", ["pack", "--pack-destination", sandbox], process.env, process.cwd());
  const tgz = readdirSync(sandbox).find((f) => f.endsWith(".tgz"));
  if (!tgz) throw new Error("npm pack produced no tarball");
  const tarballPath = join(sandbox, tgz);

  const openclawMjs =
    process.env.OPENCLAW_E2E_OPENCLAW ?? join(sandbox, "cli", "node_modules", "openclaw", "openclaw.mjs");
  if (!process.env.OPENCLAW_E2E_OPENCLAW) {
    run(
      "npm",
      [
        "install",
        "--prefix",
        join(sandbox, "cli"),
        `openclaw@${OPENCLAW_VERSION}`,
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
      ],
      process.env,
    );
  }
  const version = run(process.execPath, [openclawMjs, "--version"], sandboxEnv(homeA)).trim();
  check(`openclaw CLI reports ${OPENCLAW_VERSION}`, version.includes(OPENCLAW_VERSION), version);

  // 2. Scenario A — legacy entry enabled (the common upgrade population).
  console.log("\nScenario A: legacy plugins.entries.clawrouter = {enabled:true}");
  seedHome(homeA, true);
  const gwPortA = await freePort();
  installPlugin(openclawMjs, homeA, tarballPath);

  const entriesA0 = readConfig(homeA).plugins?.entries ?? {};
  check(
    "install left both keys on disk (installer commit + our deferred write)",
    entriesA0.clawrouter?.enabled === true && entriesA0["blockrun-clawrouter"]?.enabled === true,
    JSON.stringify(entriesA0),
  );

  const listA = pluginListJson(openclawMjs, homeA);
  const bundledA = listA.find((p) => p.id === "clawrouter");
  const blockrunA = listA.find((p) => p.id === "blockrun-clawrouter");
  check(
    "bundled router discovered as plugin id `clawrouter`",
    !!bundledA && bundledA.origin === "bundled",
  );
  check("BlockRun discovered as plugin id `blockrun-clawrouter`", !!blockrunA);

  const gwA = await startGateway(openclawMjs, homeA, gwPortA, "gateway-a.log");
  const healthA = (await waitHealthy(PROXY_PORT, HEALTH_TIMEOUT_MS)) as any;
  check(
    "BlockRun x402 proxy actually activates (GET /health answers with a wallet)",
    !!healthA && healthA.status === "ok" && typeof healthA.wallet === "string",
    healthA ? JSON.stringify(healthA) : "no /health response in time",
  );
  const listAfterA = pluginListJson(openclawMjs, homeA);
  const blockrunAfterA = listAfterA.find((p) => p.id === "blockrun-clawrouter");
  const bundledAfterA = listAfterA.find((p) => p.id === "clawrouter");
  check(
    "BlockRun provider registered (providerIds includes `blockrun`), not merely present in config",
    !!blockrunAfterA && (blockrunAfterA.providerIds ?? []).includes("blockrun"),
    JSON.stringify(blockrunAfterA?.providerIds),
  );
  check(
    "bundled router still enabled after gateway boot",
    !!bundledAfterA && bundledAfterA.enabled === true,
  );
  await stopGateway(gwA);

  const entriesA = readConfig(homeA).plugins?.entries ?? {};
  check(
    "legacy plugins.entries.clawrouter migrated away (gone from config)",
    entriesA.clawrouter === undefined,
    JSON.stringify(entriesA),
  );
  check(
    "plugins.entries.blockrun-clawrouter enabled:true",
    entriesA["blockrun-clawrouter"]?.enabled === true,
  );
  const baseUrlA: string | undefined = readConfig(homeA).models?.providers?.blockrun?.baseUrl;
  check(
    "models.providers.blockrun wired to the activated proxy port",
    baseUrlA === `http://127.0.0.1:${PROXY_PORT}/v1`,
    String(baseUrlA),
  );

  // 3. Scenario B — pre-rename opt-out must survive the installer default.
  console.log("\nScenario B: legacy plugins.entries.clawrouter = {enabled:false}");
  seedHome(homeB, false);
  const gwPortB = await freePort();
  installPlugin(openclawMjs, homeB, tarballPath);
  const entriesB0 = readConfig(homeB).plugins?.entries ?? {};
  check(
    "installer wrote blockrun-clawrouter {enabled:true} while the legacy opt-out is still deferred on disk",
    entriesB0["blockrun-clawrouter"]?.enabled === true && entriesB0.clawrouter?.enabled === false,
    JSON.stringify(entriesB0),
  );

  const gwB1 = await startGateway(openclawMjs, homeB, gwPortB, "gateway-b1.log");
  const healthB1 = await waitHealthy(PROXY_PORT, HEALTH_TIMEOUT_MS);
  check(
    "boot 1 loads the plugin (installer default) and the proxy activates",
    !!healthB1,
  );
  await stopGateway(gwB1);

  const entriesB = readConfig(homeB).plugins?.entries ?? {};
  check(
    "pre-rename opt-out restored: blockrun-clawrouter {enabled:false}",
    entriesB["blockrun-clawrouter"]?.enabled === false,
    JSON.stringify(entriesB),
  );
  check(
    "legacy clawrouter key retired (bundled router no longer disabled by it)",
    entriesB.clawrouter === undefined,
  );
  const bundledB = pluginListJson(openclawMjs, homeB).find((p) => p.id === "clawrouter");
  check(
    "bundled router NOT disabled by the legacy BlockRun opt-out",
    !!bundledB && bundledB.enabled === true,
  );

  const gwPortB2 = await freePort();
  const gwB2 = await startGateway(openclawMjs, homeB, gwPortB2, "gateway-b2.log");
  const healthB2 = await waitHealthy(PROXY_PORT, 15_000);
  check("proxy stays DOWN on the next boot (opt-out honored end to end)", healthB2 === null);
  await stopGateway(gwB2);

  // 4. Summary.
  const failed = results.filter((r) => !r.passed);
  console.log(
    `\n${failed.length === 0 ? "✅" : "❌"} ${results.length - failed.length}/${results.length} checks passed\n`,
  );
  for (const r of failed) console.log(`  ✗ ${r.name}${r.detail ? `\n    ${r.detail}` : ""}`);
  return failed.length === 0 ? 0 : 1;
}

process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`\nGate crashed: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(2);
  });
