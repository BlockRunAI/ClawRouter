import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";

import { CLAWROUTER_PACKAGE_VERSION, ensureNpmPackage } from "./runtime.js";
import { withEmbeddedNode } from "./process.js";
import { ensureServiceToken, verifyClawRouter } from "./service-auth.js";
import type { AdapterContext, CommandRunner } from "./types.js";

type ServiceName = "proxy" | "codex-bridge";

/** How long a managed proxy gets to exit on SIGTERM before it is SIGKILLed. */
const STOP_GRACE_MS = 5_000;
const PROXY_PORT = 8402;

export class ServiceSupervisor {
  private readonly children = new Map<ServiceName, ChildProcess>();

  constructor(
    private readonly context: AdapterContext,
    private readonly portOpen: (port: number) => Promise<boolean> = isPortOpen,
  ) {}

  async ensureProxy(): Promise<void> {
    const { path: tokenFile, token } = await ensureServiceToken(this.context.stateDir);
    const current = this.liveChild("proxy");
    if (current) {
      await waitForOwned(
        "http://127.0.0.1:8402/health",
        this.context.fetch,
        30_000,
        (url, fetcher) => verifyClawRouter(url, fetcher, token),
        current,
        () => this.childOwnsPort(current, 8402),
      );
      return;
    }
    if (await verifyClawRouter("http://127.0.0.1:8402/health", this.context.fetch, token)) return;
    if (await this.portOpen(8402)) {
      throw new Error(
        "Port 8402 is occupied by an unverified or outdated process. Restart ClawRouter/OpenClaw, or stop that process, then try Connect again.",
      );
    }
    const command = await ensureNpmPackage(this.context, "@blockrun/clawrouter", "clawrouter", {
      enforceVersion: true,
      ignoreScripts: true,
      version: CLAWROUTER_PACKAGE_VERSION,
    });
    const child = await this.start("proxy", command, ["--port", "8402", "--no-reuse"], {
      ...process.env,
      HOME: this.context.homeDir,
      CLAWROUTER_DESKTOP_TOKEN_FILE: tokenFile,
    });
    await waitForOwned(
      "http://127.0.0.1:8402/health",
      this.context.fetch,
      30_000,
      (url, fetcher) => verifyClawRouter(url, fetcher, token),
      child,
      () => this.childOwnsPort(child, 8402),
    );
  }

  async ensureCodexBridge(): Promise<void> {
    const current = this.liveChild("codex-bridge");
    if (current) {
      await waitForOwned(
        "http://127.0.0.1:8403/v1/models",
        this.context.fetch,
        30_000,
        isModelService,
        current,
        () => this.childOwnsPort(current, 8403),
      );
      return;
    }
    if (await this.portOpen(8403)) {
      throw new Error(
        "Port 8403 is occupied by a process ClawRouter Desktop did not start. Stop that process, then try Connect again.",
      );
    }
    await this.ensureProxy();
    const command = await ensureNpmPackage(
      this.context,
      "@blockrun/clawrouter-codex",
      "clawrouter-codex",
      { version: "0.4.0" },
    );
    const child = await this.start("codex-bridge", command, ["bridge"], {
      ...process.env,
      HOME: this.context.homeDir,
      PORT: "8403",
      PROXY_PORT: "8402",
      CLAWROUTER_PROXY_URL: "http://127.0.0.1:8402/v1",
    });
    await waitForOwned(
      "http://127.0.0.1:8403/v1/models",
      this.context.fetch,
      30_000,
      isModelService,
      child,
      () => this.childOwnsPort(child, 8403),
    );
  }

  /**
   * Restart the proxy Desktop itself launched so it re-reads the payment chain
   * in ~/.blockrun/.chain. Resolves false when the proxy on 8402 is not one of
   * Desktop's children (an OpenClaw gateway, a terminal instance): Desktop must
   * not kill a process it does not own, so that one still needs its own restart.
   * The Codex bridge keeps running; it reaches the proxy by URL and only sees a
   * brief outage.
   */
  async restartProxy(): Promise<boolean> {
    const current = this.liveChild("proxy");
    if (!current) return false;
    try {
      await this.stopProxy(current);
    } finally {
      // stopProxy throws when the port stays open, but the child is already
      // signalled by then. Keeping it in the map makes the next restartProxy()
      // resolve false and tell the user Desktop does not own a proxy it started.
      this.children.delete("proxy");
    }
    await this.ensureProxy();
    return true;
  }

  /**
   * Stop the proxy child and anything of its that still listens on the proxy
   * port. The child is normally the listener itself, but were it a wrapper the
   * listener would be a descendant that outlives it, and ensureProxy() would
   * then adopt the stale proxy (it still proves the Desktop token) instead of
   * starting one on the new chain. So the port must be closed before relaunch.
   */
  private async stopProxy(child: ChildProcess): Promise<void> {
    const owned = child.pid
      ? await listenersOwnedBy(child.pid, PROXY_PORT, this.context.runCommand)
      : [];
    const descendants = owned.filter((pid) => pid !== child.pid);
    await stopChild(child, STOP_GRACE_MS);
    for (const pid of descendants) signal(pid, "SIGTERM");
    if (await this.waitForPortClosed(PROXY_PORT, STOP_GRACE_MS)) return;
    // Re-read the port before escalating. `descendants` was captured before the
    // parent died; a descendant that exited on SIGTERM can have had its pid
    // recycled inside the grace window, and SIGKILL is not a signal to send at a
    // pid we have not just re-confirmed is the thing holding the port.
    const holding = await listenersOnPort(PROXY_PORT, this.context.runCommand);
    for (const pid of descendants) if (holding.includes(pid)) signal(pid, "SIGKILL");
    if (await this.waitForPortClosed(PROXY_PORT, 1_000)) return;
    throw new Error(
      `The previous proxy is still listening on port ${PROXY_PORT}. Restart ClawRouter Desktop to apply the change.`,
    );
  }

  private async waitForPortClosed(port: number, timeoutMs: number): Promise<boolean> {
    const started = Date.now();
    while (await this.portOpen(port)) {
      if (Date.now() - started >= timeoutMs) return false;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return true;
  }

  async stopAll(): Promise<void> {
    for (const child of this.children.values()) {
      if (!child.killed) child.kill("SIGTERM");
    }
    this.children.clear();
  }

  private async start(
    name: ServiceName,
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ): Promise<ChildProcess> {
    const current = this.children.get(name);
    if (current && !hasExited(current) && !current.killed) return current;
    const child = spawn(command, args, {
      env: await withEmbeddedNode(this.context.stateDir, env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => console.log(`[${name}] ${String(chunk).trimEnd()}`));
    child.stderr?.on("data", (chunk) => console.error(`[${name}] ${String(chunk).trimEnd()}`));
    child.once("exit", () => this.children.delete(name));
    this.children.set(name, child);
    return child;
  }

  private liveChild(name: ServiceName): ChildProcess | undefined {
    const child = this.children.get(name);
    return child && !hasExited(child) && !child.killed ? child : undefined;
  }

  private async childOwnsPort(child: ChildProcess, port: number): Promise<boolean> {
    if (!child.pid || hasExited(child) || child.killed) return false;
    return listenerBelongsToProcess(child.pid, port, this.context.runCommand);
  }
}

export async function listenerBelongsToProcess(
  ownerPid: number,
  port: number,
  runCommand: CommandRunner,
): Promise<boolean> {
  return (await listenersOwnedBy(ownerPid, port, runCommand)).length > 0;
}

/** PIDs listening on `port` that are `ownerPid` itself or descend from it. */
export async function listenersOwnedBy(
  ownerPid: number,
  port: number,
  runCommand: CommandRunner,
): Promise<number[]> {
  const owned: number[] = [];
  for (const listener of await listenersOnPort(port, runCommand)) {
    let pid = listener;
    for (let depth = 0; Number.isInteger(pid) && pid > 1 && depth < 12; depth += 1) {
      if (pid === ownerPid) {
        owned.push(listener);
        break;
      }
      const parent = await runCommand("ps", ["-o", "ppid=", "-p", String(pid)], {
        timeoutMs: 3_000,
      });
      if (parent.code !== 0) break;
      const next = Number.parseInt(parent.stdout.trim(), 10);
      if (!Number.isInteger(next) || next === pid) break;
      pid = next;
    }
  }
  return owned;
}

/** PIDs currently listening on `port`, whoever owns them. */
export async function listenersOnPort(port: number, runCommand: CommandRunner): Promise<number[]> {
  const listeners = await runCommand("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
    timeoutMs: 3_000,
  });
  if (listeners.code !== 0) return [];
  return listeners.stdout
    .split(/\r?\n/)
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

/**
 * Whether the child has actually exited. `exitCode` alone is not the test: it
 * stays null for a process killed by a signal, which is exactly how this file
 * stops things, so `exitCode === null` reads a dead child as still running.
 */
function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function signal(pid: number, name: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(pid, name);
  } catch {
    // Already gone, or not ours to signal; the port check decides what happens next.
  }
}

async function isModelService(url: string, fetcher: typeof fetch): Promise<boolean> {
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(1_500) });
    if (!response.ok) return false;
    const body = (await response.json()) as { data?: unknown };
    return Array.isArray(body.data);
  } catch {
    return false;
  }
}

async function waitForOwned(
  url: string,
  fetcher: typeof fetch,
  timeoutMs: number,
  probe: (url: string, fetcher: typeof fetch) => Promise<boolean>,
  child: ChildProcess,
  ownsPort: () => Promise<boolean>,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null || child.killed) {
      throw new Error(`Managed service exited before becoming healthy: ${url}`);
    }
    if ((await probe(url, fetcher)) && (await ownsPort())) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (
        child.exitCode === null &&
        !child.killed &&
        (await probe(url, fetcher)) &&
        (await ownsPort())
      )
        return;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Service did not become healthy: ${url}`);
}

async function stopChild(child: ChildProcess, graceMs: number): Promise<void> {
  if (hasExited(child)) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const escalate = setTimeout(() => {
    if (!hasExited(child)) child.kill("SIGKILL");
  }, graceMs);
  // A child that outlives SIGKILL (uninterruptible I/O, a stopped process) must
  // not hang the chain switch with no way back: stop waiting and let stopProxy's
  // port check decide, which is the same evidence it uses for the descendants.
  let bail: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<void>((resolve) => {
    bail = setTimeout(resolve, graceMs * 2);
  });
  try {
    await Promise.race([exited, timedOut]);
  } finally {
    clearTimeout(escalate);
    if (bail) clearTimeout(bail);
  }
}

async function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (open: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}
