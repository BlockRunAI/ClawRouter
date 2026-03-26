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
import { resolveOrGenerateWalletKey, resolvePaymentChain, WALLET_FILE } from "./auth.js";
import { BalanceMonitor } from "./balance.js";
import {
  DEFAULT_BASE_PAYMENT_ASSET,
  fetchBasePaymentAsset,
  type BasePaymentAsset,
} from "./payment-asset.js";
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
  source: "saved" | "env" | "generated" | null;
  paymentChain: "base" | "solana";
  paymentAsset: BasePaymentAsset;
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

function getBuyLinkForAsset(symbol: string): { label: string; url: string } {
  const normalized = symbol.trim().toUpperCase();
  const knownLinks: Record<string, string> = {
    USDC: "https://www.coinbase.com/price/usd-coin",
    EURC: "https://www.coinbase.com/price/euro-coin",
  };
  const knownUrl = knownLinks[normalized];
  if (knownUrl) {
    return { label: `Get ${normalized}`, url: knownUrl };
  }
  return {
    label: `Find ${normalized} on Coinbase`,
    url: `https://www.coinbase.com/search?q=${encodeURIComponent(normalized)}`,
  };
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
        paymentAsset: DEFAULT_BASE_PAYMENT_ASSET,
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
    let paymentAsset = DEFAULT_BASE_PAYMENT_ASSET;
    try {
      let balanceInfo: { balanceUSD: string; isLow: boolean; isEmpty: boolean };
      if (paymentChain === "solana" && solanaAddress) {
        const { SolanaBalanceMonitor } = await import("./solana-balance.js");
        const monitor = new SolanaBalanceMonitor(solanaAddress);
        balanceInfo = await monitor.checkBalance();
      } else {
        paymentAsset =
          (await fetchBasePaymentAsset("https://blockrun.ai/api").catch(() => undefined)) ??
          DEFAULT_BASE_PAYMENT_ASSET;
        const monitor = new BalanceMonitor(address, paymentAsset);
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
        paymentAsset,
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
        paymentAsset,
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
      paymentAsset: DEFAULT_BASE_PAYMENT_ASSET,
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
    if (result.wallet.paymentChain === "solana") {
      issues.push("Wallet is empty - need to fund with USDC on Solana");
    } else {
      issues.push(`Wallet is empty - need to fund with ${result.wallet.paymentAsset.symbol} on Base`);
    }
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

  return issues;
}

// Print diagnostics to terminal
function printDiagnostics(result: DiagnosticResult): void {
  console.log("\n🔍 Collecting diagnostics...\n");

  // System
  console.log("System");
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
    const assetLabel = result.wallet.paymentChain === "solana" ? "USDC" : result.wallet.paymentAsset.symbol;
    console.log(`  ${green(`Chain: ${chainLabel}`)}`);
    if (result.wallet.isEmpty) {
      console.log(
        `  ${red(`Balance: $0.00 - NEED TO FUND WITH ${assetLabel} ON ${chainLabel.toUpperCase()}!`)}`,
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
    id: "anthropic/claude-opus-4.6",
    name: "Claude Opus 4.6",
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
    const paymentAsset = diagnostics.wallet.paymentAsset;
    const buyLink = getBuyLinkForAsset(paymentAsset.symbol);
    console.log("\n💳 Wallet is empty - cannot call AI for analysis.");
    console.log(
      diagnostics.wallet.paymentChain === "solana"
        ? `   Fund your Solana wallet with USDC: ${diagnostics.wallet.solanaAddress ?? diagnostics.wallet.address}`
        : `   Fund your EVM wallet with ${paymentAsset.symbol} on Base: ${diagnostics.wallet.address}`,
    );
    if (diagnostics.wallet.paymentChain === "base" && diagnostics.wallet.solanaAddress) {
      console.log(`   Fund your Solana wallet with USDC: ${diagnostics.wallet.solanaAddress}`);
    }
    console.log(
      diagnostics.wallet.paymentChain === "solana"
        ? "   Get USDC: https://www.coinbase.com/price/usd-coin"
        : `   ${buyLink.label}: ${buyLink.url}`,
    );
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
    const paymentFetch = wrapFetchWithPayment(fetch, x402);

    const response = await paymentFetch("https://blockrun.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelConfig.id,
        stream: false,
        messages: [
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
  const [system, wallet, network, logs] = await Promise.all([
    collectSystemInfo(),
    collectWalletInfo(),
    collectNetworkInfo(),
    collectLogInfo(),
  ]);

  const result: DiagnosticResult = {
    version: VERSION,
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
