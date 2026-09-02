import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createHmac, createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english";

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
  WalletMutationResult,
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

  async createWallet(chain: PaymentChain): Promise<WalletMutationResult> {
    const coreDir = join(this.context.homeDir, ".blockrun");
    const name = chain === "base" ? ".session" : ".solana-session";
    try {
      const existing = await readText(join(coreDir, name));
      if (existing) {
        return {
          ok: false,
          chain,
          restartRequired: false,
          message: `A ${chainLabel(chain)} Core wallet file already exists. It was not overwritten.`,
        };
      }

      let value: string;
      let address: string;
      if (chain === "base") {
        value = `0x${Buffer.from(secp256k1.utils.randomSecretKey()).toString("hex")}`;
        address = evmAddressFromPrivateKey(value);
      } else {
        const seed = randomBytes(32);
        const secret = Buffer.concat([seed, ed25519PublicKey(seed)]);
        value = JSON.stringify([...secret]);
        address = base58Encode(secret.subarray(32));
      }
      const created = await writeFileIfMissing(coreDir, name, value + "\n");
      if (!created) throw new Error(`The ${chainLabel(chain)} wallet changed while creating it.`);
      return {
        ok: true,
        chain,
        address,
        restartRequired: true,
        message: `${chainLabel(chain)} wallet created in BlockRun Core. Restart ClawRouter before using it.`,
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

  async adoptLegacyWallet(chain: PaymentChain): Promise<WalletMutationResult> {
    const coreDir = join(this.context.homeDir, ".blockrun");
    const legacyDir = join(this.context.homeDir, ".openclaw", "blockrun");
    const name = chain === "base" ? ".session" : ".solana-session";
    try {
      let value: string | undefined;
      let address: string | undefined;
      if (chain === "base") {
        value = await readPrivateKey(join(legacyDir, "wallet.key"));
        if (value) address = evmAddressFromPrivateKey(value);
      } else {
        const mnemonic = await readText(join(legacyDir, "mnemonic"));
        if (mnemonic && validateMnemonic(mnemonic, english)) {
          const seed = solanaSeedFromMnemonic(mnemonic);
          const secret = Buffer.concat([Buffer.from(seed), Buffer.from(ed25519PublicKey(seed))]);
          value = JSON.stringify([...secret]);
          address = base58Encode(secret.subarray(32));
        }
      }
      if (!value || !address) throw new Error(`No valid legacy ${chainLabel(chain)} wallet found.`);

      const current = await readText(join(coreDir, name));
      if (current === value) {
        return {
          ok: true,
          chain,
          address,
          restartRequired: false,
          message: `This ${chainLabel(chain)} wallet is already current.`,
        };
      }
      await mkdir(coreDir, { recursive: true });
      if (current) {
        const backup = `${name}.backup-${Date.now()}`;
        await writeFileIfMissing(coreDir, backup, current + "\n");
      }
      await atomicWritePrivateFile(coreDir, name, value + "\n");
      return {
        ok: true,
        chain,
        address,
        restartRequired: true,
        message: `Legacy ${chainLabel(chain)} wallet is now current. The previous Core wallet was backed up. Restart ClawRouter to apply it.`,
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

  async dashboard(): Promise<DashboardData> {
    await this.migrateLegacyWalletToCore();
    const root = this.context.proxyBaseUrl.replace(/\/v1\/?$/, "");
    const localWalletsPromise = this.localWallets();
    const legacyWalletsPromise = localWalletsPromise.then((local) => this.legacyWallets(local));
    const localBalancesPromise = localWalletsPromise.then(({ base, solana }) =>
      fetchUsdcBalances(base, solana, this.context.fetch),
    );
    const [reachable, configuredChain, localWallets, legacyWallets, localBalances] =
      await Promise.all([
        proxyHealth(this.context),
        this.configuredPaymentChain(),
        localWalletsPromise,
        legacyWalletsPromise,
        localBalancesPromise,
      ]);
    const legacyBalances = await fetchUsdcBalances(
      legacyWallets.base?.address,
      legacyWallets.solana?.address,
      this.context.fetch,
    );
    const legacyWalletDetails = withLegacyBalances(legacyWallets, legacyBalances);
    if (!reachable) {
      return {
        proxy: {
          reachable: false,
          error: "ClawRouter is not running or could not prove its identity.",
          wallet: localWallets.base,
          solana: localWallets.solana,
          configuredWallet: localWallets.base,
          configuredSolana: localWallets.solana,
          configuredChain,
          balance: localBalances[configuredChain],
          balances: localBalances,
          walletIssues: localWallets.issues,
          legacyWallets: legacyWalletDetails,
        },
        stats: null,
        models: [],
      };
    }
    const [health, stats, catalog] = await Promise.all([
      fetchJson<Record<string, unknown>>(`${root}/health?full=true`, this.context.fetch),
      fetchJson<Record<string, unknown>>(`${root}/stats?days=7`, this.context.fetch),
      fetchCatalog(root, this.context.fetch),
    ]);
    const activeWallet = stringOrUndefined(health.value?.wallet);
    const preferredWallet = localWallets.base;
    // The proxy health response is authoritative while it is running. The saved
    // local wallet lets Desktop show the same addresses and balances before the
    // proxy starts, without ever exposing private key material to the renderer.
    const wallet = activeWallet ?? preferredWallet;
    const activeSolana = stringOrUndefined(health.value?.solana);
    const solana = activeSolana ?? localWallets.solana;
    const paymentChain = paymentChainOrUndefined(health.value?.paymentChain);
    const reportedBalance = currencyNumberOrUndefined(health.value?.balance);
    const activeBalances = await fetchUsdcBalances(
      wallet && !sameAddress(wallet, localWallets.base) ? wallet : undefined,
      solana && solana !== localWallets.solana ? solana : undefined,
      this.context.fetch,
    );
    const balances: Partial<Record<PaymentChain, number>> = {
      base:
        activeBalances.base ??
        (sameAddress(wallet ?? "", localWallets.base) ? localBalances.base : undefined) ??
        (paymentChain === "base" && wallet === activeWallet ? reportedBalance : undefined),
      solana:
        activeBalances.solana ??
        (solana === localWallets.solana ? localBalances.solana : undefined) ??
        (paymentChain === "solana" ? reportedBalance : undefined),
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
    const walletRestartChains: PaymentChain[] = [];
    if (preferredWallet && activeWallet && !sameAddress(activeWallet, preferredWallet)) {
      walletRestartChains.push("base");
    }
    if (localWallets.solana && activeSolana && activeSolana !== localWallets.solana) {
      walletRestartChains.push("solana");
    }
    return {
      proxy: health.value
        ? {
            reachable: true,
            status: String(health.value.status ?? "ok"),
            wallet,
            activeWallet,
            solana,
            activeSolana,
            configuredWallet: localWallets.base,
            configuredSolana: localWallets.solana,
            paymentChain,
            configuredChain,
            chainRestartRequired: Boolean(paymentChain && configuredChain !== paymentChain),
            balance: paymentChain ? (balances[paymentChain] ?? reportedBalance) : reportedBalance,
            balances,
            walletRestartRequired: walletRestartChains.length > 0,
            walletRestartChains,
            walletIssues: localWallets.issues,
            legacyWallets: legacyWalletDetails,
          }
        : {
            reachable: false,
            error: health.error,
            wallet: localWallets.base,
            solana: localWallets.solana,
            configuredWallet: localWallets.base,
            configuredSolana: localWallets.solana,
            configuredChain,
            balance: localBalances[configuredChain],
            balances: localBalances,
            walletIssues: localWallets.issues,
            legacyWallets: legacyWalletDetails,
          },
      stats: stats.value,
      models,
    };
  }

  private async configuredPaymentChain(): Promise<PaymentChain> {
    const coreValue = await readText(join(this.context.homeDir, ".blockrun", ".chain"));
    if (coreValue === "base" || coreValue === "solana") return coreValue;

    const legacyValue = await readText(
      join(this.context.homeDir, ".openclaw", "blockrun", "payment-chain"),
    );
    return legacyValue === "solana" ? "solana" : "base";
  }

  private async migrateLegacyWalletToCore(): Promise<void> {
    const coreDir = join(this.context.homeDir, ".blockrun");
    const legacyDir = join(this.context.homeDir, ".openclaw", "blockrun");
    const [coreBase, coreSolana, coreChain, legacyBase, legacyMnemonic, legacyChain] =
      await Promise.all([
        readText(join(coreDir, ".session")),
        readText(join(coreDir, ".solana-session")),
        readText(join(coreDir, ".chain")),
        readPrivateKey(join(legacyDir, "wallet.key")),
        readText(join(legacyDir, "mnemonic")),
        readText(join(legacyDir, "payment-chain")),
      ]);

    const pending: Array<Promise<boolean>> = [];
    if (!coreBase && legacyBase) {
      pending.push(writeFileIfMissing(coreDir, ".session", legacyBase + "\n"));
    }
    if (!coreSolana && legacyMnemonic && validateMnemonic(legacyMnemonic, english)) {
      const seed = solanaSeedFromMnemonic(legacyMnemonic);
      const secret = [...seed, ...ed25519PublicKey(seed)];
      pending.push(writeFileIfMissing(coreDir, ".solana-session", JSON.stringify(secret) + "\n"));
    }
    if (!coreChain && (legacyChain === "base" || legacyChain === "solana")) {
      pending.push(writeFileIfMissing(coreDir, ".chain", legacyChain + "\n"));
    }
    await Promise.all(pending);
  }

  private async localWallets(): Promise<{
    base?: string;
    solana?: string;
    issues: Partial<Record<PaymentChain, string>>;
  }> {
    const coreDir = join(this.context.homeDir, ".blockrun");
    const coreBaseValue = await readText(join(coreDir, ".session"));
    const coreBaseKey =
      coreBaseValue && /^0x[0-9a-f]{64}$/i.test(coreBaseValue) ? coreBaseValue : undefined;
    const coreSolanaKey = await readText(join(coreDir, ".solana-session"));
    const base = coreBaseKey ? evmAddressFromPrivateKey(coreBaseKey) : undefined;
    const solana = coreSolanaKey ? solanaAddressFromCoreKey(coreSolanaKey) : undefined;
    return {
      base,
      solana,
      issues: {
        ...(coreBaseValue && !base
          ? { base: "The BlockRun Core Base wallet file is invalid." }
          : {}),
        ...(coreSolanaKey && !solana
          ? { solana: "The BlockRun Core Solana wallet file is invalid." }
          : {}),
      },
    };
  }

  private async legacyWallets(local: {
    base?: string;
    solana?: string;
  }): Promise<Partial<Record<PaymentChain, { address: string; source: "ClawRouter legacy" }>>> {
    const legacyDir = join(this.context.homeDir, ".openclaw", "blockrun");
    const [baseKey, mnemonic] = await Promise.all([
      readPrivateKey(join(legacyDir, "wallet.key")),
      readText(join(legacyDir, "mnemonic")),
    ]);
    const base = baseKey ? evmAddressFromPrivateKey(baseKey) : undefined;
    const solana =
      mnemonic && validateMnemonic(mnemonic, english)
        ? solanaAddressFromMnemonic(mnemonic)
        : undefined;
    return {
      ...(base && !sameAddress(base, local.base)
        ? { base: { address: base, source: "ClawRouter legacy" as const } }
        : {}),
      ...(solana && solana !== local.solana
        ? { solana: { address: solana, source: "ClawRouter legacy" as const } }
        : {}),
    };
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

async function fetchUsdcBalances(
  baseAddress: string | undefined,
  solanaAddress: string | undefined,
  fetcher: typeof fetch,
): Promise<Partial<Record<PaymentChain, number>>> {
  const [base, solana] = await Promise.all([
    baseAddress ? fetchBaseUsdcBalance(baseAddress, fetcher) : Promise.resolve(undefined),
    solanaAddress ? fetchSolanaUsdcBalance(solanaAddress, fetcher) : Promise.resolve(undefined),
  ]);
  return { base, solana };
}

async function fetchBaseUsdcBalance(
  address: string,
  fetcher: typeof fetch,
): Promise<number | undefined> {
  if (!/^0x[0-9a-f]{40}$/i.test(address)) return undefined;
  const data = `0x70a08231${address.slice(2).toLowerCase().padStart(64, "0")}`;
  const token = await fetchRpc<{ result?: unknown }>(
    BASE_RPC_URL,
    "eth_call",
    [{ to: BASE_USDC_CONTRACT, data }, "latest"],
    fetcher,
  );
  return rpcHexNumber(token?.result, 1_000_000);
}

async function fetchSolanaUsdcBalance(
  address: string,
  fetcher: typeof fetch,
): Promise<number | undefined> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return undefined;
  const tokens = await fetchRpc<{
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
  );
  const accounts = tokens?.result?.value;
  return Array.isArray(accounts)
    ? accounts.reduce((total, item) => {
        const token = item.account?.data?.parsed?.info?.tokenAmount;
        if (!token?.amount || typeof token.decimals !== "number") return total;
        return total + Number(BigInt(token.amount)) / 10 ** token.decimals;
      }, 0)
    : undefined;
}

function rpcHexNumber(value: unknown, divisor: number): number | undefined {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) return undefined;
  return Number(BigInt(value)) / divisor;
}

function evmAddressFromPrivateKey(key: string): string {
  const publicKey = secp256k1.getPublicKey(Buffer.from(key.slice(2), "hex"), false).subarray(1);
  return `0x${Buffer.from(keccak_256(publicKey)).subarray(-20).toString("hex")}`;
}

function sameAddress(left: string, right: string | undefined): boolean {
  return Boolean(right && left.toLowerCase() === right.toLowerCase());
}

async function readPrivateKey(path: string): Promise<string | undefined> {
  const value = await readText(path);
  return value && /^0x[0-9a-f]{64}$/i.test(value) ? value : undefined;
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, "utf8")).trim() || undefined;
  } catch {
    return undefined;
  }
}

async function writeFileIfMissing(
  directory: string,
  name: string,
  value: string,
): Promise<boolean> {
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(join(directory, name), value, { mode: 0o600, flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

async function atomicWritePrivateFile(
  directory: string,
  name: string,
  value: string,
): Promise<void> {
  const temporaryName = `.${name}.tmp-${process.pid}-${Date.now()}`;
  const temporaryPath = join(directory, temporaryName);
  await writeFile(temporaryPath, value, { mode: 0o600, flag: "wx" });
  try {
    await rename(temporaryPath, join(directory, name));
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch {
      // Preserve the original filesystem error.
    }
    throw error;
  }
}

function chainLabel(chain: PaymentChain): string {
  return chain === "base" ? "Base" : "Solana";
}

function withLegacyBalances(
  wallets: Partial<Record<PaymentChain, { address: string; source: "ClawRouter legacy" }>>,
  balances: Partial<Record<PaymentChain, number>>,
): DashboardData["proxy"]["legacyWallets"] {
  return {
    ...(wallets.base
      ? { base: { ...wallets.base, ...(balances.base == null ? {} : { balance: balances.base }) } }
      : {}),
    ...(wallets.solana
      ? {
          solana: {
            ...wallets.solana,
            ...(balances.solana == null ? {} : { balance: balances.solana }),
          },
        }
      : {}),
  };
}

function solanaSeedFromMnemonic(mnemonic: string): Uint8Array {
  const seed = mnemonicToSeedSync(mnemonic);
  let digest = createHmac("sha512", "ed25519 seed").update(seed).digest();
  let key = digest.subarray(0, 32);
  let chainCode = digest.subarray(32);
  for (const index of [44, 501, 0, 0]) {
    const hardened = index + 0x80000000;
    const data = Buffer.alloc(37);
    data[0] = 0;
    key.copy(data, 1);
    data.writeUInt32BE(hardened, 33);
    digest = createHmac("sha512", chainCode).update(data).digest();
    key = digest.subarray(0, 32);
    chainCode = digest.subarray(32);
  }
  return key;
}

function solanaAddressFromMnemonic(mnemonic: string): string {
  return base58Encode(ed25519PublicKey(solanaSeedFromMnemonic(mnemonic)));
}

function solanaAddressFromCoreKey(value: string): string | undefined {
  try {
    let bytes: Uint8Array;
    if (value.startsWith("[")) {
      const parsed = JSON.parse(value) as unknown;
      if (
        !Array.isArray(parsed) ||
        !parsed.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)
      )
        return undefined;
      bytes = Uint8Array.from(parsed);
    } else {
      const hex = value.replace(/^0x/i, "");
      bytes = /^[0-9a-f]{128}$/i.test(hex) ? Buffer.from(hex, "hex") : base58Decode(value);
    }
    if (bytes.length !== 64) return undefined;
    const expectedPublic = ed25519PublicKey(bytes.subarray(0, 32));
    const storedPublic = bytes.subarray(32);
    if (!Buffer.from(expectedPublic).equals(Buffer.from(storedPublic))) return undefined;
    return base58Encode(storedPublic);
  } catch {
    return undefined;
  }
}

function ed25519PublicKey(seed: Uint8Array): Uint8Array {
  const privateDer = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const publicDer = createPublicKey(
    createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" }),
  ).export({ format: "der", type: "spki" });
  return Buffer.from(publicDer).subarray(-32);
}

function base58Encode(value: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let number = BigInt(`0x${Buffer.from(value).toString("hex")}`);
  let encoded = "";
  while (number > 0n) {
    const remainder = Number(number % 58n);
    encoded = alphabet[remainder] + encoded;
    number /= 58n;
  }
  for (const byte of value) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded || "1";
}

function base58Decode(value: string): Uint8Array {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let number = 0n;
  for (const character of value) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("Invalid base58 character");
    number = number * 58n + BigInt(index);
  }
  let hex = number.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const decoded = number === 0n ? Buffer.alloc(0) : Buffer.from(hex, "hex");
  let leadingZeros = 0;
  while (leadingZeros < value.length && value[leadingZeros] === "1") leadingZeros += 1;
  return Buffer.concat([Buffer.alloc(leadingZeros), decoded]);
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
