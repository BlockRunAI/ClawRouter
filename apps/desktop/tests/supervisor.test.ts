import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  listenerBelongsToProcess,
  listenersOnPort,
  ServiceSupervisor,
} from "../electron/core/supervisor.js";
import { ensureServiceToken, verifyClawRouter } from "../electron/core/service-auth.js";
import type { AdapterContext } from "../electron/core/types.js";

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ServiceSupervisor ownership", () => {
  it("accepts a proxy only when it proves possession of the Desktop token", async () => {
    const root = await mkdtemp(join(tmpdir(), "clawrouter-service-auth-"));
    const { token } = await ensureServiceToken(join(root, "state"));
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
      const challenge = new Headers(init?.headers).get("x-clawrouter-challenge") ?? "";
      return new Response(JSON.stringify({ status: "ok", wallet: "0xabc" }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-ClawRouter-Proof": createHmac("sha256", token).update(challenge).digest("hex"),
        },
      });
    }) as typeof fetch;

    await expect(verifyClawRouter("http://127.0.0.1:8402/health", fetcher, token)).resolves.toBe(
      true,
    );
    await expect(
      verifyClawRouter("http://127.0.0.1:8402/health", fetcher, "0".repeat(64)),
    ).resolves.toBe(false);
  });

  it("rejects a shape-compatible proxy that Desktop did not start", async () => {
    const supervisor = new ServiceSupervisor(
      await context(async () =>
        response({
          status: "ok",
          wallet: "0x0000000000000000000000000000000000000001",
        }),
      ),
      async (port) => port === 8402,
    );

    await expect(supervisor.ensureProxy()).rejects.toThrow("unverified or outdated");
  });

  it("refuses to restart a proxy Desktop did not launch", async () => {
    const supervisor = new ServiceSupervisor(
      await context(async () => response({ status: "ok", wallet: "0xabc" })),
      async () => true,
    );

    await expect(supervisor.restartProxy()).resolves.toBe(false);
  });

  it("stops the proxy it launched and brings a fresh one up", async () => {
    const supervisor = new ServiceSupervisor(
      await context(async () => response({ status: "ok", wallet: "0xabc" })),
      async () => false,
    );
    // A real child standing in for the proxy: idles until it is signalled.
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    (supervisor as unknown as { children: Map<string, ChildProcess> }).children.set("proxy", child);
    let relaunched = 0;
    supervisor.ensureProxy = async () => {
      relaunched += 1;
      expect(child.exitCode ?? child.signalCode).not.toBeNull();
    };

    await expect(supervisor.restartProxy()).resolves.toBe(true);

    expect(relaunched).toBe(1);
    expect(child.signalCode).toBe("SIGTERM");
  });

  it("also stops a listener a wrapper child left behind before relaunching", async () => {
    // A wrapper that spawns the real "proxy" as a grandchild, reports its pid,
    // and idles. SIGTERM on the wrapper alone would orphan the grandchild.
    const wrapper = spawn(
      process.execPath,
      [
        "-e",
        'const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); process.stdout.write(c.pid + "\\n"); setInterval(() => {}, 1000);',
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const grandchild = Number(
      await new Promise<string>((resolve) =>
        wrapper.stdout!.once("data", (chunk) => resolve(String(chunk).trim())),
      ),
    );
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const base = await context(async () => response({ status: "ok", wallet: "0xabc" }));
    const supervisor = new ServiceSupervisor(
      {
        ...base,
        // Fake lsof/ps: the grandchild holds the port and its parent is the wrapper.
        runCommand: async (command, args) => {
          if (command === "lsof")
            return { code: 0, stdout: alive(grandchild) ? `${grandchild}\n` : "", stderr: "" };
          if (command === "ps") {
            const pid = Number(args.at(-1));
            return { code: 0, stdout: pid === grandchild ? `${wrapper.pid}\n` : "1\n", stderr: "" };
          }
          return { code: 1, stdout: "", stderr: "unexpected command" };
        },
      },
      async () => alive(grandchild),
    );
    (supervisor as unknown as { children: Map<string, ChildProcess> }).children.set(
      "proxy",
      wrapper,
    );
    let relaunched = 0;
    supervisor.ensureProxy = async () => {
      relaunched += 1;
      expect(alive(grandchild)).toBe(false);
    };

    await expect(supervisor.restartProxy()).resolves.toBe(true);

    expect(relaunched).toBe(1);
    expect(wrapper.signalCode).toBe("SIGTERM");
    expect(alive(grandchild)).toBe(false);
  });

  it("does not hang on a tracked proxy something else already killed", async () => {
    // A child killed by a signal keeps exitCode === null and killed === false, so
    // reading liveness off exitCode alone treats a dead process as running and
    // then waits for an "exit" that already fired. This must resolve, not hang.
    const supervisor = new ServiceSupervisor(
      await context(async () => response({ status: "ok", wallet: "0xabc" })),
      async () => false,
    );
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
    process.kill(child.pid!, "SIGTERM"); // an outside kill, not child.kill()
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBe("SIGTERM");
    expect(child.killed).toBe(false);
    (supervisor as unknown as { children: Map<string, ChildProcess> }).children.set("proxy", child);
    let relaunched = 0;
    supervisor.ensureProxy = async () => {
      relaunched += 1;
    };

    await expect(supervisor.restartProxy()).resolves.toBe(false);

    expect(relaunched).toBe(0);
  }, 5_000);

  it("clears the tracked proxy when the port refuses to close", async () => {
    // stopProxy throws here; the child is already signalled, so it must not stay
    // in the map claiming Desktop still owns a live proxy.
    const supervisor = new ServiceSupervisor(
      await context(async () => response({ status: "ok", wallet: "0xabc" })),
      async () => true, // the port never closes
    );
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const children = (supervisor as unknown as { children: Map<string, ChildProcess> }).children;
    children.set("proxy", child);

    await expect(supervisor.restartProxy()).rejects.toThrow("still listening on port 8402");

    expect(children.has("proxy")).toBe(false);
    expect(child.signalCode).toBe("SIGTERM");
  }, 20_000);

  it("reads the listeners on a port without an ownership filter", async () => {
    const pids = await listenersOnPort(8402, async () => ({
      code: 0,
      stdout: "4242\n\n4343\nnot-a-pid\n",
      stderr: "",
    }));
    expect(pids).toEqual([4242, 4343]);
    await expect(
      listenersOnPort(8402, async () => ({ code: 1, stdout: "", stderr: "" })),
    ).resolves.toEqual([]);
  });

  it("rejects a shape-compatible Codex bridge that Desktop did not start", async () => {
    const supervisor = new ServiceSupervisor(
      await context(async () => response({ data: [] })),
      async (port) => port === 8403,
    );

    await expect(supervisor.ensureCodexBridge()).rejects.toThrow("Desktop did not start");
  });

  it("accepts a listener owned by a descendant of the spawned command", async () => {
    const parents = new Map([
      ["902", "701"],
      ["701", "500"],
    ]);
    const runCommand: AdapterContext["runCommand"] = async (command, args) => {
      if (command === "lsof") return { code: 0, stdout: "902\n", stderr: "" };
      const pid = args.at(-1) ?? "";
      return { code: parents.has(pid) ? 0 : 1, stdout: parents.get(pid) ?? "", stderr: "" };
    };
    await expect(listenerBelongsToProcess(500, 8403, runCommand)).resolves.toBe(true);
    await expect(listenerBelongsToProcess(499, 8403, runCommand)).resolves.toBe(false);
  });
});

async function context(fetcher: typeof fetch): Promise<AdapterContext> {
  const homeDir = await mkdtemp(join(tmpdir(), "clawrouter-supervisor-"));
  return {
    homeDir,
    stateDir: join(homeDir, ".clawrouter-desktop"),
    proxyBaseUrl: "http://127.0.0.1:8402/v1",
    fetch: fetcher,
    commandExists: async () => false,
    runCommand: async () => ({ code: 1, stdout: "", stderr: "must not run" }),
  };
}
