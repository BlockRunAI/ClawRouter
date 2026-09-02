/**
 * BlockRun Doctor - AI-Powered Diagnostics
 *
 * Collects system diagnostics and sends to Claude Opus 4.8 for analysis.
 * Works independently of OpenClaw - direct x402 payment to BlockRun API.
 */

import { platform, arch, freemem, totalmem } from "node:os";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { existsSync, readFileSync } from "node:fs";
import {
  resolveOrGenerateWalletKey,
  resolvePaymentChain,
  WALLET_FILE,
  CORE_WALLET_FILE,
  MNEMONIC_FILE,
} from "./auth.js";
import { BalanceMonitor } from "./balance.js";
import {
  resolveApiKey,
  maskApiKey,
  BLOCKRUN_API_KEY_API,
  PORTAL_CREDITS_URL,
  PORTAL_KEYS_URL,
} from "./api-key.js";
import { getSolanaAddress } from "./wallet.js";
import { getStats } from "./stats.js";
import { getProxyPort } from "./proxy.js";
import { getSharedSpendControl, registerSpendPolicyHook, SpendControl } from "./spend-control.js";
import { VERSION } from "./version.js";

// Types
interface SystemInfo {
  os: string;
  arch: string;
  nodeVersion: string;
  memoryFree: string;
  memoryTotal: string;
}

interface WalletInfo {
  exists: boolean;
  valid: boolean;
  address: string | null;
  solanaAddress: string | null;
  balance: string | null;
  isLow: boolean;
  isEmpty: boolean;
  source: "core" | "saved" | "env" | "config" | "generated" | null;
  paymentChain: "base" | "solana";
}

/** Set only when this install pays with a `brk_…` key instead of a wallet. */
interface ApiKeyInfo {
  configured: boolean;
  masked: string | null;
  source: "env" | "core" | "saved" | "config" | null;
  gateway: string;
  /** Did api.blockrun.ai accept the key? null = not checked (no key). */
  accepted: boolean | null;
}

interface NetworkInfo {
  blockrunApi: { reachable: boolean; latencyMs: number | null };
  localProxy: { running: boolean; port: number };
}

interface LogInfo {
  requestsLast24h: number;
  costLast24h: string;
  errorsFound: number;
}

interface DiagnosticResult {
  version: string;
  latestVersion: string | null;
  timestamp: string;
  system: SystemInfo;
  apiKey: ApiKeyInfo;
  wallet: WalletInfo;
  network: NetworkInfo;
  logs: LogInfo;
  issues: string[];
}

// Helpers
function formatBytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  return `${gb.toFixed(1)}GB`;
}

function green(text: string): string {
  return `\x1b[32m✓\x1b[0m ${text}`;
}

function red(text: string): string {
  return `\x1b[31m✗\x1b[0m ${text}`;
}

function yellow(text: string): string {
  return `\x1b[33m⚠\x1b[0m ${text}`;
}

// Fetch latest published version from npm registry
async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch("https://registry.npmjs.org/@blockrun/clawrouter/latest", {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

// Collect system info
function collectSystemInfo(): SystemInfo {
  return {
    os: `${platform()} ${arch()}`,
    arch: arch(),
    nodeVersion: process.version,
    memoryFree: formatBytes(freemem()),
    memoryTotal: formatBytes(totalmem()),
  };
}

/**
 * Collect API-key state, and prove the key actually works.
 *
 * The live check matters more than the file check: the failure this command
 * exists to diagnose is "everything looks configured and every call 401s",
 * which a revoked or mistyped key produces and no amount of local inspection
 * detects. GET /v1/models is the cheapest authenticated call on the gateway —
 * it bills nothing and answers 401 for a bad key.
 */
async function collectApiKeyInfo(): Promise<ApiKeyInfo> {
  const resolved = await resolveApiKey();
  if (!resolved) {
    return {
      configured: false,
      masked: null,
      source: null,
      gateway: BLOCKRUN_API_KEY_API,
      accepted: null,
    };
  }

  let accepted: boolean | null = null;
  try {
    const response = await fetch(`${BLOCKRUN_API_KEY_API}/v1/models`, {
      headers: { authorization: `Bearer ${resolved.key}` },
      signal: AbortSignal.timeout(10000),
    });
    // 401 is the only answer that means "this key is bad". A 5xx or a network
    // failure says nothing about the key, so it stays unknown rather than
    // reporting a working key as broken.
    if (response.status === 401) accepted = false;
    else if (response.ok) accepted = true;
  } catch {
    // accepted stays null — unreachable is a network issue, reported below.
  }

  return {
    configured: true,
    masked: maskApiKey(resolved.key),
    source: resolved.source,
    gateway: BLOCKRUN_API_KEY_API,
    accepted,
  };
}

// Collect wallet info
async function collectWalletInfo(apiKeyConfigured: boolean): Promise<WalletInfo> {
  const empty: WalletInfo = {
    exists: false,
    valid: false,
    address: null,
    solanaAddress: null,
    balance: null,
    isLow: false,
    isEmpty: true,
    source: null,
    paymentChain: "base",
  };
  // With a key configured there is nothing to diagnose here, and
  // resolveOrGenerateWalletKey() would CREATE a wallet as a side effect —
  // running `doctor` must never mint a private key the user did not ask for.
  if (apiKeyConfigured) return { ...empty, isEmpty: false };

  try {
    const { key, address, source, solanaPrivateKeyBytes } = await resolveOrGenerateWalletKey();

    if (!key || !address) {
      return {
        exists: false,
        valid: false,
        address: null,
        solanaAddress: null,
        balance: null,
        isLow: false,
        isEmpty: true,
        source: null,
        paymentChain: "base",
      };
    }

    // Derive Solana address if mnemonic-based wallet
    let solanaAddress: string | null = null;
    if (solanaPrivateKeyBytes) {
      try {
        solanaAddress = await getSolanaAddress(solanaPrivateKeyBytes);
      } catch {
        // Non-fatal
      }
    }

    // Check balance on the active payment chain
    const paymentChain = await resolvePaymentChain();
    try {
      let balanceInfo: { balanceUSD: string; isLow: boolean; isEmpty: boolean };
      if (paymentChain === "solana" && solanaAddress) {
        const { SolanaBalanceMonitor } = await import("./solana-balance.js");
        const monitor = new SolanaBalanceMonitor(solanaAddress);
        balanceInfo = await monitor.checkBalance();
      } else {
        const monitor = new BalanceMonitor(address);
        balanceInfo = await monitor.checkBalance();
      }
      return {
        exists: true,
        valid: true,
        address,
        solanaAddress,
        balance: balanceInfo.balanceUSD,
        isLow: balanceInfo.isLow,
        isEmpty: balanceInfo.isEmpty,
        source,
        paymentChain,
      };
    } catch {
      return {
        exists: true,
        valid: true,
        address,
        solanaAddress,
        balance: null,
        isLow: false,
        isEmpty: false,
        source,
        paymentChain,
      };
    }
  } catch {
    return {
      exists: false,
      valid: false,
      address: null,
      solanaAddress: null,
      balance: null,
      isLow: false,
      isEmpty: true,
      source: null,
      paymentChain: "base",
    };
  }
}

// Collect network info
async function collectNetworkInfo(): Promise<NetworkInfo> {
  const port = getProxyPort();

  // Check BlockRun API
  let blockrunReachable = false;
  let blockrunLatency: number | null = null;
  try {
    const start = Date.now();
    const response = await fetch("https://blockrun.ai/api/v1/models", {
      method: "GET",
      signal: AbortSignal.timeout(10000),
    });
    blockrunLatency = Date.now() - start;
    blockrunReachable = response.ok || response.status === 402;
  } catch {
    // blockrunReachable already false
  }

  // Check local proxy
  let proxyRunning = false;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(3000),
    });
    proxyRunning = response.ok;
  } catch {
    // proxyRunning already false
  }

  return {
    blockrunApi: { reachable: blockrunReachable, latencyMs: blockrunLatency },
    localProxy: { running: proxyRunning, port },
  };
}

// Collect log info
async function collectLogInfo(): Promise<LogInfo> {
  try {
    const stats = await getStats(1); // Last 1 day
    return {
      requestsLast24h: stats.totalRequests,
      costLast24h: `$${stats.totalCost.toFixed(4)}`,
      errorsFound: 0, // TODO: parse error logs
    };
  } catch {
    return {
      requestsLast24h: 0,
      costLast24h: "$0.00",
      errorsFound: 0,
    };
  }
}

// Identify issues
function identifyIssues(result: DiagnosticResult): string[] {
  const issues: string[] = [];

  if (result.apiKey.configured) {
    if (result.apiKey.accepted === false) {
      issues.push(
        `BlockRun rejected the API key (${result.apiKey.masked}) — it may be revoked or mistyped. Mint a new one at ${PORTAL_KEYS_URL}`,
      );
    }
    // A wallet is neither expected nor used in this mode; every wallet check
    // below would report a false problem, so they are skipped entirely.
    return finishIssues(result, issues);
  }

  if (!result.wallet.exists) {
    issues.push("No wallet found");
  }
  if (result.wallet.isEmpty) {
    const chain = result.wallet.paymentChain === "solana" ? "Solana" : "Base";
    issues.push(`Wallet is empty - need to fund with USDC on ${chain}`);
    if (result.wallet.paymentChain === "base" && result.wallet.solanaAddress) {
      issues.push("Tip: if you funded Solana, run /wallet solana to switch chains");
    }
  } else if (result.wallet.isLow) {
    issues.push("Wallet balance is low (< $1.00)");
  }
  return finishIssues(result, issues);
}

/** The checks that apply whichever credential is in use. */
function finishIssues(result: DiagnosticResult, issues: string[]): string[] {
  if (!result.network.blockrunApi.reachable) {
    issues.push("Cannot reach BlockRun API - check internet connection");
  }
  if (!result.network.localProxy.running) {
    issues.push(`Local proxy not running on port ${result.network.localProxy.port}`);
  }
  if (result.latestVersion && result.latestVersion !== result.version) {
    issues.push(
      `Outdated version: running v${result.version}, latest is v${result.latestVersion}. Run: curl -fsSL https://blockrun.ai/ClawRouter-update | bash`,
    );
  }

  return issues;
}

// Print diagnostics to terminal
function printDiagnostics(result: DiagnosticResult): void {
  console.log("\n🔍 Collecting diagnostics...\n");

  // Version
  console.log("Version");
  if (result.latestVersion && result.latestVersion !== result.version) {
    console.log(`  ${red(`Installed: v${result.version} (outdated!)`)}`);
    console.log(`  ${yellow(`Latest:    v${result.latestVersion}`)}`);
    console.log(
      `  ${yellow(`Update:    curl -fsSL https://blockrun.ai/ClawRouter-update | bash`)}`,
    );
  } else if (result.latestVersion) {
    console.log(`  ${green(`v${result.version} (up to date)`)}`);
  } else {
    console.log(`  ${green(`v${result.version}`)}`);
  }

  // System
  console.log("\nSystem");
  console.log(`  ${green(`OS: ${result.system.os}`)}`);
  console.log(`  ${green(`Node: ${result.system.nodeVersion}`)}`);
  console.log(
    `  ${green(`Memory: ${result.system.memoryFree} free / ${result.system.memoryTotal}`)}`,
  );

  // Credential — an API key replaces the wallet entirely, so print one or the other.
  if (result.apiKey.configured) {
    console.log("\nBlockRun account (API key)");
    console.log(`  ${green(`Key: ${result.apiKey.masked} (from ${result.apiKey.source})`)}`);
    console.log(`  ${green(`Gateway: ${result.apiKey.gateway}`)}`);
    if (result.apiKey.accepted === true) {
      console.log(`  ${green("Key accepted by BlockRun")}`);
    } else if (result.apiKey.accepted === false) {
      console.log(`  ${red("Key REJECTED by BlockRun (401) — revoked or mistyped")}`);
      console.log(`  ${yellow(`Mint a new key: ${PORTAL_KEYS_URL}`)}`);
    } else {
      console.log(`  ${yellow("Could not verify the key (gateway unreachable)")}`);
    }
    console.log(`  ${green(`Credit: billed server-side — top up at ${PORTAL_CREDITS_URL}`)}`);
    printRestOfDiagnostics(result);
    return;
  }

  // Wallet
  console.log("\nWallet");
  if (result.wallet.exists && result.wallet.valid) {
    const walletPath = result.wallet.source === "core" ? CORE_WALLET_FILE : WALLET_FILE;
    console.log(`  ${green(`Key: ${walletPath} (${result.wallet.source})`)}`);
    console.log(`  ${green(`EVM Address:    ${result.wallet.address}`)}`);
    if (result.wallet.solanaAddress) {
      console.log(`  ${green(`Solana Address: ${result.wallet.solanaAddress}`)}`);
    }
    const chainLabel = result.wallet.paymentChain === "solana" ? "Solana" : "Base";
    console.log(`  ${green(`Chain: ${chainLabel}`)}`);
    if (result.wallet.isEmpty) {
      console.log(
        `  ${red(`Balance: $0.00 - NEED TO FUND WITH USDC ON ${chainLabel.toUpperCase()}!`)}`,
      );
      if (result.wallet.paymentChain === "base" && result.wallet.solanaAddress) {
        console.log(`  ${yellow(`Tip: funded Solana instead? Run /wallet solana to switch`)}`);
      }
    } else if (result.wallet.isLow) {
      console.log(`  ${yellow(`Balance: ${result.wallet.balance} (low)`)}`);
    } else if (result.wallet.balance) {
      console.log(`  ${green(`Balance: ${result.wallet.balance}`)}`);
    } else {
      console.log(`  ${yellow(`Balance: checking...`)}`);
    }
  } else {
    console.log(`  ${red("No wallet found")}`);
  }

  printRestOfDiagnostics(result);
}

/** Network, logs and the issue summary — identical in both auth modes. */
function printRestOfDiagnostics(result: DiagnosticResult): void {
  // Network
  console.log("\nNetwork");
  if (result.network.blockrunApi.reachable) {
    console.log(
      `  ${green(`BlockRun API: reachable (${result.network.blockrunApi.latencyMs}ms)`)}`,
    );
  } else {
    console.log(`  ${red("BlockRun API: unreachable")}`);
  }
  if (result.network.localProxy.running) {
    console.log(`  ${green(`Local proxy: running on :${result.network.localProxy.port}`)}`);
  } else {
    console.log(`  ${red(`Local proxy: not running on :${result.network.localProxy.port}`)}`);
  }

  // Logs
  console.log("\nLogs");
  console.log(
    `  ${green(`Last 24h: ${result.logs.requestsLast24h} requests, ${result.logs.costLast24h} spent`)}`,
  );
  if (result.logs.errorsFound > 0) {
    console.log(`  ${yellow(`${result.logs.errorsFound} errors found in logs`)}`);
  }

  // Issues summary
  if (result.issues.length > 0) {
    console.log("\n⚠️  Issues Found:");
    for (const issue of result.issues) {
      console.log(`  • ${issue}`);
    }
  }
}

// Model options for doctor command
type DoctorModel = "sonnet" | "opus";

const DOCTOR_MODELS: Record<DoctorModel, { id: string; name: string; cost: string }> = {
  sonnet: {
    id: "anthropic/claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
    cost: "~$0.003",
  },
  opus: {
    id: "anthropic/claude-opus-5",
    name: "Claude Opus 5",
    cost: "~$0.01",
  },
};

/**
 * Build the x402 client doctor pays with. The spend-policy hook is registered
 * here, before any signing scheme, exactly as startProxy does: doctor's paid
 * call (~$0.003-$0.01) must not be a way around the operator's allow/deny
 * lists. This is the only place doctor constructs an x402Client, so the test
 * that drives it pins the wiring, not just the helper.
 */
export function createDoctorX402Client(opts: {
  walletKey: string;
  /** Default: the same on-disk policy the proxy reads. Inject in tests. */
  spendControl?: SpendControl;
}): x402Client {
  const account = privateKeyToAccount(opts.walletKey as `0x${string}`);
  const publicClient = createPublicClient({ chain: base, transport: http() });
  const evmSigner = toClientEvmSigner(account, publicClient);
  const x402 = new x402Client();
  registerSpendPolicyHook(x402, opts.spendControl ?? getSharedSpendControl());
  registerExactEvmScheme(x402, { signer: evmSigner });
  return x402;
}

// Send to AI for analysis
async function analyzeWithAI(
  diagnostics: DiagnosticResult,
  userQuestion?: string,
  model: DoctorModel = "sonnet",
): Promise<void> {
  // API-key mode: no wallet, no x402, no local balance gate — one authenticated
  // POST to api.blockrun.ai, and the gateway refuses with a 402 if the account
  // is out of credit. Handled before the wallet checks below, all of which
  // would report an empty wallet this user does not have and does not need.
  if (diagnostics.apiKey.configured) {
    await analyzeWithApiKey(diagnostics, userQuestion, model);
    return;
  }

  // Check if wallet has funds
  if (diagnostics.wallet.isEmpty) {
    console.log("\n💳 Wallet is empty - cannot call AI for analysis.");
    console.log(`   Fund your EVM wallet with USDC on Base: ${diagnostics.wallet.address}`);
    if (diagnostics.wallet.solanaAddress) {
      console.log(`   Fund your Solana wallet with USDC: ${diagnostics.wallet.solanaAddress}`);
    }
    console.log("   Get USDC: https://www.coinbase.com/price/usd-coin");
    console.log("   Bridge to Base: https://bridge.base.org\n");
    return;
  }

  const modelConfig = DOCTOR_MODELS[model];
  console.log(`\n📤 Sending to ${modelConfig.name} (${modelConfig.cost})...\n`);

  try {
    const { key } = await resolveOrGenerateWalletKey();
    const x402 = createDoctorX402Client({ walletKey: key });

    // Register Solana scheme if user is on Solana chain
    const paymentChain = diagnostics.wallet.paymentChain;
    if (paymentChain === "solana") {
      try {
        if (!existsSync(MNEMONIC_FILE)) {
          throw new Error(`mnemonic file missing at ${MNEMONIC_FILE}`);
        }
        const mnemonic = readFileSync(MNEMONIC_FILE, "utf8").trim();
        if (!mnemonic) throw new Error("mnemonic file empty");
        const { deriveSolanaKeyBytes } = await import("./wallet.js");
        const { registerExactSvmScheme } = await import("@x402/svm/exact/client");
        const { createKeyPairSignerFromPrivateKeyBytes } = await import("@solana/kit");
        const solanaKeyBytes = deriveSolanaKeyBytes(mnemonic);
        const solanaSigner = await createKeyPairSignerFromPrivateKeyBytes(solanaKeyBytes);
        registerExactSvmScheme(x402, { signer: solanaSigner });
      } catch (err) {
        console.log(
          `  ⚠ Could not register Solana signer: ${err instanceof Error ? err.message : String(err)}`,
        );
        console.log(`  ⚠ Falling back to Base (EVM) — doctor request may fail on Solana chain\n`);
      }
    }

    const paymentFetch = wrapFetchWithPayment(fetch, x402);
    const apiUrl =
      paymentChain === "solana"
        ? "https://sol.blockrun.ai/api/v1/chat/completions"
        : "https://blockrun.ai/api/v1/chat/completions";

    const response = await paymentFetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelConfig.id,
        stream: false,
        messages: doctorMessages(diagnostics, userQuestion),
        max_tokens: 1000,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.log(`Error: ${response.status} - ${text}`);
      return;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (content) {
      console.log("🤖 AI Analysis:\n");
      console.log(content);
      console.log();
    } else {
      console.log("Error: No response from AI");
    }
  } catch (err) {
    console.log(`\nError calling AI: ${err instanceof Error ? err.message : String(err)}`);
    console.log("Try again or check your wallet balance.\n");
  }
}

/**
 * The API-key twin of analyzeWithAI's x402 path.
 *
 * Shares the prompt with the wallet path and nothing else — there is no client
 * to build, no scheme to register and no chain to pick, so threading a flag
 * through the payment machinery above would add branches to code whose only
 * job is signing.
 */
async function analyzeWithApiKey(
  diagnostics: DiagnosticResult,
  userQuestion: string | undefined,
  model: DoctorModel,
): Promise<void> {
  const resolved = await resolveApiKey();
  if (!resolved) return; // collectApiKeyInfo saw one; a race here is not worth guessing at

  const modelConfig = DOCTOR_MODELS[model];
  console.log(`\n📤 Sending to ${modelConfig.name} (${modelConfig.cost})...\n`);

  try {
    const response = await fetch(`${BLOCKRUN_API_KEY_API}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: `Bearer ${resolved.key}`,
      },
      body: JSON.stringify({
        model: modelConfig.id,
        stream: false,
        messages: doctorMessages(diagnostics, userQuestion),
        max_tokens: 1000,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.log(`Error: ${response.status} - ${text}`);
      if (response.status === 402) {
        console.log(`\nYour BlockRun credit is exhausted. Top up: ${PORTAL_CREDITS_URL}\n`);
      } else if (response.status === 401) {
        console.log(`\nBlockRun rejected the key. Mint a new one: ${PORTAL_KEYS_URL}\n`);
      }
      return;
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (content) {
      console.log("🤖 AI Analysis:\n");
      console.log(content);
      console.log();
    } else {
      console.log("Error: No response from AI");
    }
  } catch (err) {
    console.log(`\nError calling AI: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`Try again, or check your credit at ${PORTAL_CREDITS_URL}\n`);
  }
}

/** The doctor prompt, shared by both auth modes so they cannot drift apart. */
function doctorMessages(
  diagnostics: DiagnosticResult,
  userQuestion: string | undefined,
): Array<{ role: string; content: string }> {
  return [
    {
      role: "system",
      content: `You are a technical support expert for BlockRun and ClawRouter.
Analyze the diagnostics and:
1. Identify the root cause of any issues
2. Provide specific, actionable fix commands (bash)
3. Explain why the issue occurred briefly
4. Be concise but thorough
5. Format commands in code blocks`,
    },
    {
      role: "user",
      content: userQuestion
        ? `Here are my system diagnostics:\n\n${JSON.stringify(diagnostics, null, 2)}\n\nUser's question: ${userQuestion}`
        : `Here are my system diagnostics:\n\n${JSON.stringify(diagnostics, null, 2)}\n\nPlease analyze and help me fix any issues.`,
    },
  ];
}

// Main entry point
export async function runDoctor(
  userQuestion?: string,
  model: "sonnet" | "opus" = "sonnet",
): Promise<void> {
  console.log(`\n🩺 BlockRun Doctor v${VERSION}\n`);

  // Collect all diagnostics
  // The key is resolved first: it decides whether a wallet is even relevant.
  const apiKey = await collectApiKeyInfo();
  const [system, wallet, network, logs, latestVersion] = await Promise.all([
    collectSystemInfo(),
    collectWalletInfo(apiKey.configured),
    collectNetworkInfo(),
    collectLogInfo(),
    fetchLatestVersion(),
  ]);

  const result: DiagnosticResult = {
    version: VERSION,
    latestVersion,
    timestamp: new Date().toISOString(),
    system,
    apiKey,
    wallet,
    network,
    logs,
    issues: [],
  };

  // Identify issues
  result.issues = identifyIssues(result);

  // Print to terminal
  printDiagnostics(result);

  // Send to AI for analysis
  await analyzeWithAI(result, userQuestion, model);
}
