import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { ClawRouterManager } from "../electron/core/manager.js";
import type { CommandRunner } from "../electron/core/types.js";

function response(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("ClawRouterManager adapter flow", () => {
  it("enriches a standard model list with bundled pricing and context metadata", async () => {
    const home = await mkdtemp(join(tmpdir(), "clawrouter-manager-"));
    const manager = fixtureManager(home, async () => false);

    const dashboard = await manager.dashboard();
    const sonnet = dashboard.models.find((model) => model.id === "anthropic/claude-sonnet-4.6");
    expect(sonnet).toMatchObject({
      ownedBy: "anthropic",
      contextWindow: expect.any(Number),
      maxOutput: expect.any(Number),
      inputPrice: expect.any(Number),
      outputPrice: expect.any(Number),
    });
  });

  it("configures and exactly restores Codex through the transaction boundary", async () => {
    const home = await mkdtemp(join(tmpdir(), "clawrouter-manager-"));
    const codexDir = join(home, ".codex");
    await mkdir(codexDir, { recursive: true });
    const config = join(codexDir, "config.toml");
    const original = 'model = "gpt-native"\n[projects.demo]\ntrust_level = "trusted"\n';
    await writeFile(config, original);
    const manager = fixtureManager(home, async (command) => command === "codex");

    const installed = await manager.install("codex", { setDefault: true, model: "blockrun/auto" });
    expect(installed, installed.message).toMatchObject({ ok: true });
    expect(await readFile(config, "utf8")).toContain("[model_providers.clawrouter]");

    const restored = await manager.uninstall("codex");
    expect(restored.ok).toBe(true);
    expect(await readFile(config, "utf8")).toBe(original);
  });

  it("installs DSH into the managed runtime and validates its official config shape", async () => {
    const home = await mkdtemp(join(tmpdir(), "clawrouter-manager-"));
    const state = join(home, ".clawrouter-desktop");
    const dsh = join(state, "runtime", "node_modules", ".bin", "dsh");
    await mkdir(dirname(dsh), { recursive: true });
    await writeFile(dsh, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const manager = fixtureManager(home, async () => false);

    const installed = await manager.install("dsh", { model: "auto" });
    expect(installed, installed.message).toMatchObject({ ok: true });
    const settings = parse(await readFile(join(home, ".dsh", "settings.yaml"), "utf8"));
    const credentials = parse(await readFile(join(home, ".dsh", ".credentials.yaml"), "utf8"));
    expect(settings["llm-pi-ai"].providers.clawrouter.api).toBe("openai-completions");
    expect(credentials.refs.CLAWROUTER_API_KEY).toBe("clawrouter-local");
  });

  it("turns every agent connection on and off and reports how each change activates", async () => {
    const expectations = {
      openclaw: "Restart the OpenClaw gateway",
      codex: "Restart Codex",
      hermes: "Restart Hermes",
      dsh: "no restart is needed",
      pi: "no restart is needed",
    } as const;

    for (const [agent, guidance] of Object.entries(expectations)) {
      const home = await mkdtemp(join(tmpdir(), `clawrouter-toggle-${agent}-`));
      const manager = fixtureManager(
        home,
        async () => true,
        async (command, args) => {
          if (command === "npx" && args.includes("setup")) {
            const path = join(home, ".openclaw", "openclaw.json");
            await mkdir(dirname(path), { recursive: true });
            await writeFile(
              path,
              JSON.stringify({
                models: { providers: { blockrun: { baseUrl: "http://127.0.0.1:8402/v1" } } },
                plugins: { entries: { "blockrun-clawrouter": { enabled: true } } },
              }),
            );
          }
          if (command.includes("hermes-clawrouter") && args.includes("setup")) {
            const config = join(home, ".hermes", "config.yaml");
            const env = join(home, ".hermes", ".env");
            await mkdir(dirname(config), { recursive: true });
            await writeFile(
              config,
              "providers:\n  clawrouter:\n    base_url: http://127.0.0.1:8402/v1\n",
            );
            await writeFile(env, "CLAWROUTER_API_KEY=clawrouter-local\n");
          }
          return { code: 0, stdout: "ok", stderr: "" };
        },
      );

      const before = (await manager.statuses()).find((status) => status.id === agent);
      expect(before?.configured).toBe(false);

      const connected = await manager.install(agent as keyof typeof expectations, {
        setDefault: true,
        model: agent === "dsh" || agent === "pi" ? "auto" : "blockrun/auto",
      });
      expect(connected, connected.message).toMatchObject({
        ok: true,
        status: { configured: true },
      });
      expect(connected.message).toContain(guidance);

      const restored = await manager.uninstall(agent as keyof typeof expectations);
      expect(restored, restored.message).toMatchObject({ ok: true, status: { configured: false } });
      expect(restored.message).toContain(guidance);
    }
  });

  it("keeps a reported zero wallet balance available instead of treating it as missing", async () => {
    const home = await mkdtemp(join(tmpdir(), "clawrouter-wallet-"));
    const manager = fixtureManager(home, async () => false, undefined, { balance: "$0.00" });
    const dashboard = await manager.dashboard();
    expect(dashboard.proxy.balance).toBe(0);
    expect(dashboard.proxy.balances?.base).toBe(0);
  });

  it("shows the active signing wallet and marks a different Core wallet for restart", async () => {
    const home = await mkdtemp(join(tmpdir(), "clawrouter-wallet-preferred-"));
    await mkdir(join(home, ".blockrun"), { recursive: true });
    await writeFile(join(home, ".blockrun", ".session"), `0x${"0".repeat(63)}1\n`, { mode: 0o600 });
    const staleWallet = "0x0000000000000000000000000000000000000001";
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path === "https://mainnet.base.org") {
        const request = JSON.parse(String(init?.body)) as { method: string };
        if (request.method === "eth_call")
          return response({ result: `0x${BigInt(12_746_213).toString(16)}` });
        if (request.method === "eth_getBalance")
          return response({ result: `0x${BigInt(2_000_000_000).toString(16)}` });
      }
      if (path.endsWith("/admin/models")) return new Response("{}", { status: 404 });
      if (path.endsWith("/v1/models")) return response({ data: [] });
      if (path.includes("/stats")) return response({});
      return authenticatedResponse(home, init, {
        status: "ok",
        wallet: staleWallet,
        paymentChain: "base",
        balance: "$0.00",
      });
    }) as typeof fetch;
    const manager = new ClawRouterManager({
      homeDir: home,
      stateDir: join(home, ".clawrouter-desktop"),
      commandExists: async () => false,
      runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
      fetch: fetcher,
    });

    const dashboard = await manager.dashboard();
    expect(dashboard.proxy.wallet).toBe(staleWallet);
    expect(dashboard.proxy.activeWallet).toBe(staleWallet);
    expect(dashboard.proxy.walletRestartRequired).toBe(true);
    expect(dashboard.proxy.balance).toBe(12.746213);
    expect(dashboard.proxy.nativeBalances?.base).toBe(0.000000002);
  });

  it("disconnects OpenClaw and Hermes safely when their pre-Desktop configs have no backup", async () => {
    const home = await mkdtemp(join(tmpdir(), "clawrouter-preexisting-"));
    const commands: Array<{ command: string; args: string[] }> = [];
    await mkdir(join(home, ".openclaw", "agents", "main", "agent"), { recursive: true });
    await mkdir(join(home, ".hermes"), { recursive: true });
    await writeFile(
      join(home, ".openclaw", "openclaw.json"),
      JSON.stringify({
        models: { providers: { blockrun: { baseUrl: "http://127.0.0.1:8402/v1" }, keep: {} } },
        plugins: {
          entries: {
            clawrouter: { enabled: true },
            "blockrun-clawrouter": { enabled: true },
            keep: { enabled: true },
          },
        },
      }),
    );
    await writeFile(
      join(home, ".openclaw", "agents", "main", "agent", "auth-profiles.json"),
      JSON.stringify({ profiles: { "blockrun:default": {}, keep: {} } }),
    );
    await writeFile(
      join(home, ".hermes", "config.yaml"),
      "model:\n  provider: clawrouter\n  default: auto\nproviders:\n  clawrouter:\n    base_url: http://127.0.0.1:8402/v1\n  keep: {}\n",
    );
    await writeFile(join(home, ".hermes", ".env"), "CLAWROUTER_API_KEY=local\nKEEP=1\n");
    const manager = fixtureManager(
      home,
      async (command) => command === "openclaw" || command === "hermes",
      async (command, args) => {
        commands.push({ command, args });
        return { code: 0, stdout: "ok", stderr: "" };
      },
    );

    const before = await manager.statuses();
    expect(before.find((item) => item.id === "openclaw")).toMatchObject({
      configured: true,
      removalMode: "disconnect",
    });
    expect(before.find((item) => item.id === "hermes")).toMatchObject({
      configured: true,
      removalMode: "disconnect",
    });
    expect(await manager.uninstall("openclaw")).toMatchObject({
      ok: true,
      status: { configured: false },
    });
    expect(await manager.uninstall("hermes")).toMatchObject({
      ok: true,
      status: { configured: false },
    });

    const openclaw = JSON.parse(await readFile(join(home, ".openclaw", "openclaw.json"), "utf8"));
    const hermes = parse(await readFile(join(home, ".hermes", "config.yaml"), "utf8"));
    expect(openclaw.models.providers).toHaveProperty("keep");
    expect(openclaw.plugins.entries).toHaveProperty("clawrouter");
    expect(openclaw.plugins.entries).toHaveProperty("keep");
    expect(commands).toContainEqual({
      command: "openclaw",
      args: ["plugins", "uninstall", "--force", "blockrun-clawrouter"],
    });
    expect(hermes.providers).toHaveProperty("keep");
    expect(await readFile(join(home, ".hermes", ".env"), "utf8")).toBe("KEEP=1\n");
  });

  it("detects agent CLIs installed by NVM even when Electron's PATH omits them", async () => {
    const home = await mkdtemp(join(tmpdir(), "clawrouter-nvm-"));
    const openclaw = join(home, ".nvm", "versions", "node", "v24.14.1", "bin", "openclaw");
    await mkdir(dirname(openclaw), { recursive: true });
    await writeFile(openclaw, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const manager = fixtureManager(home, async () => false);
    const status = (await manager.statuses()).find((item) => item.id === "openclaw");
    expect(status?.installed).toBe(true);
  });

  it("accepts only an exact Coinbase-hosted onramp URL from the bundled ClawRouter CLI", async () => {
    const home = await mkdtemp(join(tmpdir(), "clawrouter-onramp-"));
    const manager = fixtureManager(
      home,
      async (command) => command === "clawrouter",
      async (command, args) => {
        expect(command).toBe("clawrouter");
        expect(args).toEqual(["onramp", "50", "--json"]);
        return {
          code: 0,
          stdout: '{"url":"https://pay.coinbase.com/buy/select-asset?sessionToken=test"}\n',
          stderr: "",
        };
      },
    );
    await expect(manager.createOnramp(50)).resolves.toMatchObject({
      ok: true,
      url: expect.stringContaining("pay.coinbase.com"),
    });

    const rejected = fixtureManager(
      home,
      async (command) => command === "clawrouter",
      async () => ({
        code: 0,
        stdout: '{"url":"https://pay.coinbase.com.evil.test/buy"}\n',
        stderr: "",
      }),
    );
    await expect(rejected.createOnramp(50)).resolves.toMatchObject({ ok: false });
  });
});

function fixtureManager(
  homeDir: string,
  exists: (command: string) => Promise<boolean>,
  runCommand: CommandRunner = async () => ({ code: 0, stdout: "ok", stderr: "" }),
  health: Record<string, unknown> = {},
) {
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith("/admin/models")) {
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }
    if (path.endsWith("/v1/models")) {
      return response({ data: [{ id: "auto" }, { id: "anthropic/claude-sonnet-4.6" }] });
    }
    return authenticatedResponse(homeDir, init, {
      status: "ok",
      wallet: "0xabc",
      paymentChain: "base",
      ...health,
    });
  }) as typeof fetch;
  const manager = new ClawRouterManager({
    homeDir,
    stateDir: join(homeDir, ".clawrouter-desktop"),
    runCommand,
    commandExists: exists,
    fetch: fetcher,
  });
  manager.supervisor.ensureProxy = async () => {};
  manager.supervisor.ensureCodexBridge = async () => {};
  return manager;
}

async function authenticatedResponse(
  homeDir: string,
  init: RequestInit | undefined,
  body: unknown,
): Promise<Response> {
  const challenge = new Headers(init?.headers).get("x-clawrouter-challenge");
  if (!challenge) return response(body);
  const token = (
    await readFile(join(homeDir, ".clawrouter-desktop", "service-token"), "utf8")
  ).trim();
  return response(body, {
    "X-ClawRouter-Proof": createHmac("sha256", token).update(challenge).digest("hex"),
  });
}
