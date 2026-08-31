import { spawn, type ChildProcess } from "node:child_process";

import { ensureNpmPackage } from "./runtime.js";
import { withEmbeddedNode } from "./process.js";
import type { AdapterContext } from "./types.js";

type ServiceName = "proxy" | "codex-bridge";

export class ServiceSupervisor {
  private readonly children = new Map<ServiceName, ChildProcess>();

  constructor(private readonly context: AdapterContext) {}

  async ensureProxy(): Promise<void> {
    if (await isClawRouter("http://127.0.0.1:8402/health", this.context.fetch)) return;
    const command = await ensureNpmPackage(this.context, "@blockrun/clawrouter", "clawrouter");
    await this.start("proxy", command, ["--port", "8402"], {
      ...process.env,
      HOME: this.context.homeDir,
    });
    await waitFor("http://127.0.0.1:8402/health", this.context.fetch, 30_000, isClawRouter);
  }

  async ensureCodexBridge(): Promise<void> {
    if (await isModelService("http://127.0.0.1:8403/v1/models", this.context.fetch)) return;
    await this.ensureProxy();
    const command = await ensureNpmPackage(
      this.context,
      "@blockrun/clawrouter-codex",
      "clawrouter-codex",
    );
    await this.start("codex-bridge", command, ["bridge"], {
      ...process.env,
      HOME: this.context.homeDir,
      PORT: "8403",
      PROXY_PORT: "8402",
      CLAWROUTER_PROXY_URL: "http://127.0.0.1:8402/v1",
    });
    await waitFor("http://127.0.0.1:8403/v1/models", this.context.fetch, 30_000, isModelService);
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
  ): Promise<void> {
    const current = this.children.get(name);
    if (current && current.exitCode === null && !current.killed) return;
    const child = spawn(command, args, {
      env: await withEmbeddedNode(this.context.stateDir, env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => console.log(`[${name}] ${String(chunk).trimEnd()}`));
    child.stderr?.on("data", (chunk) => console.error(`[${name}] ${String(chunk).trimEnd()}`));
    child.once("exit", () => this.children.delete(name));
    this.children.set(name, child);
  }
}

async function isClawRouter(url: string, fetcher: typeof fetch): Promise<boolean> {
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(1_500) });
    if (!response.ok) return false;
    const body = (await response.json()) as { status?: unknown; wallet?: unknown };
    return body.status === "ok" && typeof body.wallet === "string";
  } catch {
    return false;
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

async function waitFor(
  url: string,
  fetcher: typeof fetch,
  timeoutMs: number,
  probe: (url: string, fetcher: typeof fetch) => Promise<boolean>,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await probe(url, fetcher)) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Service did not become healthy: ${url}`);
}
