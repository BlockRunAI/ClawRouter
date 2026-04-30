/**
 * BlockRun Doctor - AI-Powered Diagnostics
 *
 * Collects system diagnostics and sends to Claude Opus 4.6 for analysis.
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
  MNEMONIC_FILE,
} from "./auth.js";
import { BalanceMonitor } from "./balance.js";
import { getSolanaAddress } from "./wallet.js";
import { getStats } from "./stats.js";
import { getProxyPort } from "./proxy.js";
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
  source: "saved" | "env" | "config" | "generated" | "okx" | null;
  paymentChain: "base" | "solana";
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
    const res = await fetch("https://registry.npmjs.org/@blockrun/xclawrouter/latest", {
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

// Collect wallet info
async function collectWalletInfo(): Promise<WalletInfo> {
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
  if (!result.network.blockrunApi.reachable) {
    issues.push("Cannot reach BlockRun API - check internet connection");
  }
  if (!result.network.localProxy.running) {
    issues.push(`Local proxy not running on port ${result.network.localProxy.port}`);
  }
  if (result.latestVersion && result.latestVersion !== result.version) {
    issues.push(
      `Outdated version: running v${result.version}, latest is v${result.latestVersion}. Run: curl -fsSL https://blockrun.ai/xclawrouter-update | bash`,
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
      `  ${yellow(`Update:    curl -fsSL https://blockrun.ai/xclawrouter-update | bash`)}`,
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

  // Wallet
  console.log("\nWallet");
  if (result.wallet.exists && result.wallet.valid) {
    console.log(`  ${green(`Key: ${WALLET_FILE} (${result.wallet.source})`)}`);
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
    id: "anthropic/claude-opus-4.7",
    name: "Claude Opus 4.7",
    cost: "~$0.01",
  },
};

// Send to AI for analysis
async function analyzeWithAI(
  diagnostics: DiagnosticResult,
  userQuestion?: string,
  model: DoctorModel = "sonnet",
): Promise<void> {
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
    const account = privateKeyToAccount(key as `0x${string}`);
    const publicClient = createPublicClient({ chain: base, transport: http() });
    const evmSigner = toClientEvmSigner(account, publicClient);
    const x402 = new x402Client();
    registerExactEvmScheme(x402, { signer: evmSigner });

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
        messages: [
          {
            role: "system",
            content: `You are a technical support expert for BlockRun and XClawRouter.
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
        ],
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

// Main entry point
export async function runDoctor(
  userQuestion?: string,
  model: "sonnet" | "opus" = "sonnet",
): Promise<void> {
  console.log(`\n🩺 BlockRun Doctor v${VERSION}\n`);

  // Collect all diagnostics
  const [system, wallet, network, logs, latestVersion] = await Promise.all([
    collectSystemInfo(),
    collectWalletInfo(),
    collectNetworkInfo(),
    collectLogInfo(),
    fetchLatestVersion(),
  ]);

  const result: DiagnosticResult = {
    version: VERSION,
    latestVersion,
    timestamp: new Date().toISOString(),
    system,
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
