import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  PAYMENT_CHAINS,
  chainLabel,
  coreWalletFileOf,
  paymentChainOrUndefined,
  walletKindOf,
} from "../electron/core/chains.js";
import { parsePaymentChain } from "../electron/core/ipc-policy.js";
import { ClawRouterManager } from "../electron/core/manager.js";
import { CLAWROUTER_PACKAGE_VERSION } from "../electron/core/runtime.js";
import { PAYMENT_CHAINS as CLAWROUTER_CHAINS } from "../../../src/payment-chain.js";

/**
 * Arc (Circle, eip155:5042) in Desktop. Desktop used to hand-define
 * PaymentChain as "base" | "solana", so a proxy paying on Arc was shown as
 * Base — Base's balance, Base's funding controls — pointing the user at the
 * wrong network. These pin that Desktop takes its chains from ClawRouter's
 * table and treats Arc as the EVM wallet read on Arc.
 */

const ARC_BALANCE = "https://arc.blockrun.ai/api/v1/balance";
const EVM_KEY = `0x${"0".repeat(63)}1`;
const EVM_ADDRESS = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf"; // address of key 0x…01

function response(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
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

async function homeWithEvmWallet(prefix: string, chain?: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(home, ".blockrun"), { recursive: true });
  await writeFile(join(home, ".blockrun", ".session"), `${EVM_KEY}\n`, { mode: 0o600 });
  if (chain) await writeFile(join(home, ".blockrun", ".chain"), `${chain}\n`);
  return home;
}

/** Base USDC 12.5, Arc USDC 24.25; anything else is "proxy offline" unless `health` is given. */
function chainFetcher(home: string, health?: Record<string, unknown>, arcCalls: string[] = []) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    if (path === "https://mainnet.base.org") {
      return response({ result: `0x${BigInt(12_500_000).toString(16)}` });
    }
    if (path.startsWith(ARC_BALANCE)) {
      arcCalls.push(path);
      return response({ balance: "24253720", balanceUSD: "$24.25", network: "arc" });
    }
    if (!health) throw new TypeError("proxy offline");
    if (path.endsWith("/admin/models")) return new Response("{}", { status: 404 });
    if (path.endsWith("/v1/models")) return response({ data: [] });
    if (path.includes("/stats")) return response({});
    return authenticatedResponse(home, init, health);
  }) as typeof fetch;
}

describe("Desktop payment chains come from ClawRouter's table", () => {
  it("lists exactly the chains the proxy can pay on, Arc included", () => {
    expect([...PAYMENT_CHAINS]).toEqual([...CLAWROUTER_CHAINS]);
    expect(PAYMENT_CHAINS).toContain("arc");
    expect(chainLabel("arc")).toBe("Arc");
  });

  it("accepts arc over IPC and still rejects anything undeclared", () => {
    expect(parsePaymentChain("arc")).toBe("arc");
    expect(() => parsePaymentChain("eip155:5042")).toThrow("Unsupported payment chain");
    expect(() => parsePaymentChain("ARC")).toThrow("Unsupported payment chain");
  });

  it("keeps arc from /health instead of discarding it", () => {
    expect(paymentChainOrUndefined("arc")).toBe("arc");
    expect(paymentChainOrUndefined("ethereum")).toBeUndefined();
  });

  it("pays Arc from the EVM (Base) key, never the Solana one", () => {
    expect(walletKindOf("arc")).toBe("evm");
    expect(coreWalletFileOf("arc")).toBe(".session");
    expect(coreWalletFileOf("base")).toBe(".session");
    expect(coreWalletFileOf("solana")).toBe(".solana-session");
  });
});

describe("ClawRouterManager on Arc", () => {
  it("reads a persisted arc choice and shows the Arc balance, not Base's, while offline", async () => {
    const home = await homeWithEvmWallet("clawrouter-arc-offline-", "arc");
    const arcCalls: string[] = [];
    const manager = new ClawRouterManager({
      homeDir: home,
      stateDir: join(home, ".clawrouter-desktop"),
      commandExists: async () => false,
      runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
      fetch: chainFetcher(home, undefined, arcCalls),
    });

    const dashboard = await manager.dashboard();
    expect(dashboard.proxy).toMatchObject({
      reachable: false,
      configuredChain: "arc",
      balance: 24.25372,
      balances: { base: 12.5, arc: 24.25372 },
    });
    expect(arcCalls[0]?.toLowerCase()).toBe(`${ARC_BALANCE}?address=${EVM_ADDRESS}`.toLowerCase());
  });

  it("keeps a running proxy's arc chain and reports its Arc balance", async () => {
    const home = await homeWithEvmWallet("clawrouter-arc-live-", "arc");
    const manager = new ClawRouterManager({
      homeDir: home,
      stateDir: join(home, ".clawrouter-desktop"),
      commandExists: async () => false,
      runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
      fetch: chainFetcher(home, {
        status: "ok",
        wallet: EVM_ADDRESS,
        paymentChain: "arc",
        gateway: "https://arc.blockrun.ai/api",
        balance: "$24.25",
      }),
    });

    const dashboard = await manager.dashboard();
    expect(dashboard.proxy.reachable).toBe(true);
    expect(dashboard.proxy.paymentChain).toBe("arc");
    expect(dashboard.proxy.configuredChain).toBe("arc");
    expect(dashboard.proxy.chainRestartRequired).toBe(false);
    expect(dashboard.proxy.balance).toBe(24.25372);
    expect(dashboard.proxy.balances?.base).toBe(12.5);
  });

  it("flags a restart when Arc is saved but the running proxy still pays on Base", async () => {
    const home = await homeWithEvmWallet("clawrouter-arc-restart-", "arc");
    const manager = new ClawRouterManager({
      homeDir: home,
      stateDir: join(home, ".clawrouter-desktop"),
      commandExists: async () => false,
      runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
      fetch: chainFetcher(home, { status: "ok", wallet: EVM_ADDRESS, paymentChain: "base" }),
    });
    const dashboard = await manager.dashboard();
    expect(dashboard.proxy.chainRestartRequired).toBe(true);
  });

  it("switches to arc through the CLI and confirms Arc is active", async () => {
    const home = await mkdtemp(join(tmpdir(), "clawrouter-arc-switch-"));
    const runtime = join(home, ".clawrouter-desktop", "runtime", "node_modules");
    await mkdir(dirname(join(runtime, ".bin", "clawrouter")), { recursive: true });
    await mkdir(join(runtime, "@blockrun", "clawrouter"), { recursive: true });
    await writeFile(join(runtime, ".bin", "clawrouter"), "#!/bin/sh\n", { mode: 0o755 });
    await writeFile(
      join(runtime, "@blockrun", "clawrouter", "package.json"),
      JSON.stringify({ version: CLAWROUTER_PACKAGE_VERSION }),
    );
    const commands: string[][] = [];
    const manager = new ClawRouterManager({
      homeDir: home,
      stateDir: join(home, ".clawrouter-desktop"),
      commandExists: async () => false,
      runCommand: async (_command, args) => {
        commands.push(args);
        return { code: 0, stdout: "", stderr: "" };
      },
      fetch: chainFetcher(home, { status: "ok", wallet: EVM_ADDRESS, paymentChain: "arc" }),
    });
    manager.supervisor.restartProxy = async () => true;

    const result = await manager.switchPaymentChain("arc");
    expect(result).toMatchObject({ ok: true, chain: "arc", restartRequired: false });
    expect(result.message).toContain("Arc is active");
    expect(commands.some((args) => args.join(" ").endsWith("chain arc"))).toBe(true);
  });

  it("creating an Arc wallet creates the shared EVM key, not a Solana one", async () => {
    const home = await mkdtemp(join(tmpdir(), "clawrouter-arc-create-"));
    const manager = new ClawRouterManager({
      homeDir: home,
      stateDir: join(home, ".clawrouter-desktop"),
      commandExists: async () => false,
      runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
      fetch: chainFetcher(home),
    });
    const created = await manager.createWallet("arc");
    expect(created.ok).toBe(true);
    expect(created.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(existsSync(join(home, ".blockrun", ".session"))).toBe(true);
    expect(existsSync(join(home, ".blockrun", ".solana-session"))).toBe(false);
    // And a Base wallet now "already exists": it is the same file.
    expect((await manager.createWallet("base")).ok).toBe(false);
  });

  it("migrates a legacy arc chain selection into BlockRun Core", async () => {
    const home = await mkdtemp(join(tmpdir(), "clawrouter-arc-migrate-"));
    await mkdir(join(home, ".openclaw", "blockrun"), { recursive: true });
    await writeFile(join(home, ".openclaw", "blockrun", "payment-chain"), "arc\n");
    const manager = new ClawRouterManager({
      homeDir: home,
      stateDir: join(home, ".clawrouter-desktop"),
      commandExists: async () => false,
      runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
      fetch: chainFetcher(home),
    });
    const dashboard = await manager.dashboard();
    expect(dashboard.proxy.configuredChain).toBe("arc");
    expect((await readFile(join(home, ".blockrun", ".chain"), "utf8")).trim()).toBe("arc");
  });
});
