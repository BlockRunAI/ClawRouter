import { mkdtemp } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { listenerBelongsToProcess, ServiceSupervisor } from "../electron/core/supervisor.js";
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
