import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";

import { CLAWROUTER_PACKAGE_VERSION, ensureNpmPackage } from "./runtime.js";
import { withEmbeddedNode } from "./process.js";
import { ensureServiceToken, verifyClawRouter } from "./service-auth.js";
import type { AdapterContext, CommandRunner } from "./types.js";

type ServiceName = "proxy" | "codex-bridge";

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
    if (current && current.exitCode === null && !current.killed) return current;
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
    return child && child.exitCode === null && !child.killed ? child : undefined;
  }

  private async childOwnsPort(child: ChildProcess, port: number): Promise<boolean> {
    if (!child.pid || child.exitCode !== null || child.killed) return false;
    return listenerBelongsToProcess(child.pid, port, this.context.runCommand);
  }
}

export async function listenerBelongsToProcess(
  ownerPid: number,
  port: number,
  runCommand: CommandRunner,
): Promise<boolean> {
  const listeners = await runCommand("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
    timeoutMs: 3_000,
  });
  if (listeners.code !== 0) return false;
  for (const line of listeners.stdout.split(/\r?\n/)) {
    let pid = Number.parseInt(line.trim(), 10);
    for (let depth = 0; Number.isInteger(pid) && pid > 1 && depth < 12; depth += 1) {
      if (pid === ownerPid) return true;
      const parent = await runCommand("ps", ["-o", "ppid=", "-p", String(pid)], {
        timeoutMs: 3_000,
      });
      if (parent.code !== 0) break;
      const next = Number.parseInt(parent.stdout.trim(), 10);
      if (!Number.isInteger(next) || next === pid) break;
      pid = next;
    }
  }
  return false;
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
