import { readFile } from "node:fs/promises";
import { createECDH } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { keccak_256 } from "@noble/hashes/sha3.js";

import { CodexAdapter } from "../adapters/codex.js";
import { DshAdapter } from "../adapters/dsh.js";
import { HermesAdapter } from "../adapters/hermes.js";
import { OpenClawAdapter } from "../adapters/openclaw.js";
import { PiAdapter } from "../adapters/pi.js";
import { commandExists, runCommand, withEmbeddedNode } from "./process.js";
import { BUNDLED_MODEL_METADATA } from "./model-catalog.js";
import { ensureNpmPackage, proxyHealth } from "./runtime.js";
import { ServiceSupervisor } from "./supervisor.js";
import { ConfigurationTransaction } from "./transaction.js";
import type {
  AdapterContext,
  AgentAdapter,
  AgentId,
  AgentStatus,
  DashboardData,
  InstallOptions,
  ModelInfo,
  OnrampResult,
  OperationResult,
  PaymentChain,
  PaymentChainSwitchResult,
} from "./types.js";

const BASE_RPC_URL = "https://mainnet.base.org";
const BASE_USDC_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export class ClawRouterManager {
  readonly context: AdapterContext;
  readonly supervisor: ServiceSupervisor;
  private readonly transaction: ConfigurationTransaction;
  private readonly adapters: Map<AgentId, AgentAdapter>;

  constructor(overrides: Partial<AdapterContext> = {}) {
    const homeDir = overrides.homeDir ?? homedir();
    const stateDir = overrides.stateDir ?? join(homeDir, ".clawrouter-desktop");
    const baseRunner = overrides.runCommand ?? runCommand;
    this.context = {
      homeDir,
      stateDir,
      proxyBaseUrl: "http://127.0.0.1:8402/v1",
      commandExists,
      fetch: globalThis.fetch,
      ...overrides,
      runCommand: async (command, args, options = {}) =>
        baseRunner(command, args, {
          ...options,
          env: await withEmbeddedNode(stateDir, options.env),
        }),
    };
    this.supervisor = new ServiceSupervisor(this.context);
    this.transaction = new ConfigurationTransaction(this.context.stateDir);
    this.adapters = new Map(
      [
        new OpenClawAdapter(),
        new CodexAdapter(),
        new HermesAdapter(),
        new DshAdapter(),
        new PiAdapter(),
      ].map((adapter) => [adapter.id, adapter]),
    );
  }

  async statuses(): Promise<AgentStatus[]> {
    return Promise.all(
      [...this.adapters.values()].map(async (adapter) =>
        this.decorateStatus(adapter, await adapter.status(this.context)),
      ),
    );
  }

  async install(agent: AgentId, options: InstallOptions = {}): Promise<OperationResult> {
    const adapter = this.requireAdapter(agent);
    try {
      await this.supervisor.ensureProxy();
      if (agent === "codex") await this.supervisor.ensureCodexBridge();
      await this.transaction.run(agent, adapter.managedPaths(this.context), async () => {
        await adapter.install(this.context, options);
        const verification = await adapter.verify(this.context);
        if (!verification.ok) throw new Error(verification.details.join("; "));
      });
      const status = await this.decorateStatus(adapter, await adapter.status(this.context));
      return {
        ok: true,
        status,
        message: activationMessage(adapter, "connect"),
      };
    } catch (error) {
      return {
        ok: false,
        status: await this.decorateStatus(adapter, await adapter.status(this.context)),
        message: error instanceof Error ? error.message : String(error),
        rolledBack: true,
      };
    }
  }

  async uninstall(agent: AgentId): Promise<OperationResult> {
    const adapter = this.requireAdapter(agent);
    try {
      await adapter.cleanupRuntime?.(this.context);
      const restored = await this.transaction.restoreOriginal(
        agent,
        adapter.managedPaths(this.context),
      );
      if (restored) {
        return {
          ok: true,
          status: await this.decorateStatus(adapter, await adapter.status(this.context)),
          message: activationMessage(adapter, "restore"),
        };
      }
      if (!adapter.disconnect) {
        return {
          ok: false,
          status: await this.decorateStatus(adapter, await adapter.status(this.context)),
          message: `${adapter.name} was configured before ClawRouter Desktop, so no original backup is available.`,
        };
      }
      await adapter.disconnect(this.context);
      const status = await this.decorateStatus(adapter, await adapter.status(this.context));
      if (status.configured)
        throw new Error(`ClawRouter settings are still present in ${adapter.name}.`);
      return {
        ok: true,
        status,
        message: activationMessage(adapter, "disconnect"),
      };
    } catch (error) {
      return {
        ok: false,
        status: await this.decorateStatus(adapter, await adapter.status(this.context)),
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async switchPaymentChain(chain: PaymentChain): Promise<PaymentChainSwitchResult> {
    try {
      const command = await ensureNpmPackage(this.context, "@blockrun/clawrouter", "clawrouter");
      const result = await this.context.runCommand(command, ["chain", chain], {
        timeoutMs: 30_000,
      });
      if (result.code !== 0) {
        return {
          ok: false,
          chain,
          restartRequired: false,
          message: (result.stderr || result.stdout).trim() || `Could not switch to ${chain}.`,
        };
      }
      return {
        ok: true,
        chain,
        restartRequired: true,
        message: `${chain === "solana" ? "Solana" : "Base"} selected. Restart the ClawRouter/OpenClaw gateway to apply it.`,
      };
    } catch (error) {
      return {
        ok: false,
        chain,
        restartRequired: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async createOnramp(amount: number): Promise<OnrampResult> {
    try {
      const command = await ensureNpmPackage(this.context, "@blockrun/clawrouter", "clawrouter");
      const result = await this.context.runCommand(command, ["onramp", String(amount), "--json"], {
        timeoutMs: 45_000,
      });
      if (result.code !== 0) {
        return {
          ok: false,
          message:
            (result.stderr || result.stdout).trim().slice(-800) ||
            "Could not start Coinbase Onramp.",
        };
      }
      const line = result.stdout.trim().split(/\r?\n/).at(-1);
      const parsed = line ? (JSON.parse(line) as { url?: unknown }) : {};
      if (typeof parsed.url !== "string") throw new Error("Coinbase Onramp returned no link.");
      const url = new URL(parsed.url);
      if (url.protocol !== "https:" || url.hostname !== "pay.coinbase.com") {
        throw new Error("Coinbase Onramp returned an invalid link.");
      }
      return { ok: true, url: url.toString(), message: "Coinbase Onramp is ready." };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async dashboard(): Promise<DashboardData> {
    const root = this.context.proxyBaseUrl.replace(/\/v1\/?$/, "");
    if (!(await proxyHealth(this.context))) {
      return {
        proxy: {
          reachable: false,
          error: "ClawRouter is not running or could not prove its identity.",
        },
        stats: null,
        models: [],
      };
    }
    const [health, stats, catalog, configuredChain] = await Promise.all([
      fetchJson<Record<string, unknown>>(`${root}/health?full=true`, this.context.fetch),
      fetchJson<Record<string, unknown>>(`${root}/stats?days=7`, this.context.fetch),
      fetchCatalog(root, this.context.fetch),
      this.configuredPaymentChain(),
    ]);
    const activeWallet = stringOrUndefined(health.value?.wallet);
    const preferredWallet = await this.preferredBaseWallet();
    // The proxy health response is authoritative: it is the key that signs both
    // Base and Solana requests. A BlockRun CLI session may use another key and
    // should only trigger restart guidance, never replace the displayed balance.
    const wallet = activeWallet ?? preferredWallet;
    const solana = stringOrUndefined(health.value?.solana);
    const paymentChain = paymentChainOrUndefined(health.value?.paymentChain);
    const reportedBalance = currencyNumberOrUndefined(health.value?.balance);
    const [baseBalance, solanaBalance] = await Promise.all([
      wallet ? fetchBaseBalances(wallet, this.context.fetch) : Promise.resolve(undefined),
      solana ? fetchSolanaBalances(solana, this.context.fetch) : Promise.resolve(undefined),
    ]);
    const balances: Partial<Record<PaymentChain, number>> = {
      base:
        baseBalance?.usdc ??
        (paymentChain === "base" && wallet === activeWallet ? reportedBalance : undefined),
      solana: solanaBalance?.usdc ?? (paymentChain === "solana" ? reportedBalance : undefined),
    };
    const nativeBalances: Partial<Record<PaymentChain, number>> = {
      base: baseBalance?.native,
      solana: solanaBalance?.native,
    };
    const models: ModelInfo[] = (catalog.value?.data ?? []).map((model) => {
      const id = String(model.id ?? "");
      const bundled = BUNDLED_MODEL_METADATA[id];
      return {
        id,
        name: stringOrUndefined(model.name) ?? bundled?.name,
        ownedBy: stringOrUndefined(model.owned_by) ?? bundled?.owned_by,
        contextWindow: numberOrUndefined(model.context_window) ?? bundled?.context_window,
        maxOutput: numberOrUndefined(model.max_output) ?? bundled?.max_output,
        inputPrice: numberOrUndefined(model.input_price) ?? bundled?.input_price,
        outputPrice: numberOrUndefined(model.output_price) ?? bundled?.output_price,
        reasoning: booleanOrUndefined(model.reasoning) ?? bundled?.reasoning,
        vision: booleanOrUndefined(model.vision) ?? bundled?.vision,
        agentic: booleanOrUndefined(model.agentic) ?? bundled?.agentic,
        toolCalling: booleanOrUndefined(model.tool_calling) ?? bundled?.tool_calling,
      };
    });
    return {
      proxy: health.value
        ? {
            reachable: true,
            status: String(health.value.status ?? "ok"),
            wallet,
            activeWallet,
            solana,
            paymentChain,
            configuredChain,
            chainRestartRequired: Boolean(paymentChain && configuredChain !== paymentChain),
            balance: paymentChain ? (balances[paymentChain] ?? reportedBalance) : reportedBalance,
            balances,
            nativeBalances,
            walletRestartRequired: Boolean(
              preferredWallet &&
              activeWallet &&
              preferredWallet.toLowerCase() !== activeWallet.toLowerCase(),
            ),
          }
        : { reachable: false, error: health.error },
      stats: stats.value,
      models,
    };
  }

  private async configuredPaymentChain(): Promise<PaymentChain> {
    try {
      const value = (
        await readFile(join(this.context.homeDir, ".openclaw", "blockrun", "payment-chain"), "utf8")
      ).trim();
      return value === "solana" ? "solana" : "base";
    } catch {
      return "base";
    }
  }

  private async preferredBaseWallet(): Promise<string | undefined> {
    try {
      const key = (
        await readFile(join(this.context.homeDir, ".blockrun", ".session"), "utf8")
      ).trim();
      if (!/^0x[0-9a-f]{64}$/i.test(key)) return undefined;
      return evmAddressFromPrivateKey(key);
    } catch {
      return undefined;
    }
  }

  private async decorateStatus(adapter: AgentAdapter, status: AgentStatus): Promise<AgentStatus> {
    try {
      const backupAvailable = Boolean(
        await this.transaction.read(adapter.id, adapter.managedPaths(this.context)),
      );
      return {
        ...status,
        removalMode: backupAvailable
          ? "restore"
          : adapter.disconnect
            ? "disconnect"
            : "unavailable",
      };
    } catch (error) {
      return {
        ...status,
        health: "needs-attention",
        removalMode: adapter.disconnect ? "disconnect" : "unavailable",
        details: [
          ...status.details,
          `The Desktop restore backup is invalid and will not be used: ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
  }

  private requireAdapter(agent: AgentId): AgentAdapter {
    const adapter = this.adapters.get(agent);
    if (!adapter) throw new Error(`Unknown agent: ${agent}`);
    return adapter;
  }
}

function activationMessage(
  adapter: AgentAdapter,
  action: "connect" | "restore" | "disconnect",
): string {
  const changed =
    action === "connect"
      ? `${adapter.name} is configured for ClawRouter.`
      : action === "restore"
        ? `${adapter.name}'s previous configuration was restored exactly.`
        : `ClawRouter settings were removed from ${adapter.name}; other settings were preserved.`;
  if (adapter.activation === "immediate") {
    if (adapter.id === "pi" && action === "connect") {
      return `${changed} Open /model (or press Ctrl+L) in a running Pi session to refresh it now; no restart is needed.`;
    }
    return `${changed} The change is active now; no restart is needed.`;
  }
  if (adapter.activation === "restart-gateway") {
    return `${changed} Restart the OpenClaw gateway to apply the change.`;
  }
  return `${changed} Restart ${adapter.name} to apply the change.`;
}

async function fetchJson<T>(
  url: string,
  fetcher: typeof fetch,
): Promise<{ value: T | null; error?: string }> {
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) return { value: null, error: `HTTP ${response.status}` };
    return { value: (await response.json()) as T };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

async function fetchCatalog(root: string, fetcher: typeof fetch) {
  const detailed = await fetchJson<{ data?: Array<Record<string, unknown>> }>(
    `${root}/admin/models`,
    fetcher,
  );
  return Array.isArray(detailed.value?.data)
    ? detailed
    : fetchJson<{ data?: Array<Record<string, unknown>> }>(`${root}/v1/models`, fetcher);
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function currencyNumberOrUndefined(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Number(value.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function paymentChainOrUndefined(value: unknown): PaymentChain | undefined {
  return value === "base" || value === "solana" ? value : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

async function fetchBaseBalances(
  address: string,
  fetcher: typeof fetch,
): Promise<{ usdc?: number; native?: number } | undefined> {
  if (!/^0x[0-9a-f]{40}$/i.test(address)) return undefined;
  const data = `0x70a08231${address.slice(2).toLowerCase().padStart(64, "0")}`;
  const [token, native] = await Promise.all([
    fetchRpc<{ result?: unknown }>(
      BASE_RPC_URL,
      "eth_call",
      [{ to: BASE_USDC_CONTRACT, data }, "latest"],
      fetcher,
    ),
    fetchRpc<{ result?: unknown }>(BASE_RPC_URL, "eth_getBalance", [address, "latest"], fetcher),
  ]);
  return {
    usdc: rpcHexNumber(token?.result, 1_000_000),
    native: rpcHexNumber(native?.result, 1_000_000_000_000_000_000),
  };
}

async function fetchSolanaBalances(
  address: string,
  fetcher: typeof fetch,
): Promise<{ usdc?: number; native?: number } | undefined> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return undefined;
  const [tokens, native] = await Promise.all([
    fetchRpc<{
      result?: {
        value?: Array<{
          account?: {
            data?: { parsed?: { info?: { tokenAmount?: { amount?: string; decimals?: number } } } };
          };
        }>;
      };
    }>(
      SOLANA_RPC_URL,
      "getTokenAccountsByOwner",
      [address, { mint: SOLANA_USDC_MINT }, { encoding: "jsonParsed" }],
      fetcher,
    ),
    fetchRpc<{ result?: { value?: unknown } }>(SOLANA_RPC_URL, "getBalance", [address], fetcher),
  ]);
  const accounts = tokens?.result?.value;
  const usdc = Array.isArray(accounts)
    ? accounts.reduce((total, item) => {
        const token = item.account?.data?.parsed?.info?.tokenAmount;
        if (!token?.amount || typeof token.decimals !== "number") return total;
        return total + Number(BigInt(token.amount)) / 10 ** token.decimals;
      }, 0)
    : undefined;
  const lamports = native?.result?.value;
  return { usdc, native: typeof lamports === "number" ? lamports / 1_000_000_000 : undefined };
}

function rpcHexNumber(value: unknown, divisor: number): number | undefined {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) return undefined;
  return Number(BigInt(value)) / divisor;
}

function evmAddressFromPrivateKey(key: string): string {
  const ecdh = createECDH("secp256k1");
  ecdh.setPrivateKey(Buffer.from(key.slice(2), "hex"));
  const publicKey = ecdh.getPublicKey(undefined, "uncompressed").subarray(1);
  return `0x${Buffer.from(keccak_256(publicKey)).subarray(-20).toString("hex")}`;
}

async function fetchRpc<T>(
  url: string,
  method: string,
  params: unknown[],
  fetcher: typeof fetch,
): Promise<T | undefined> {
  try {
    const response = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return undefined;
    return (await response.json()) as T;
  } catch {
    return undefined;
  }
}
