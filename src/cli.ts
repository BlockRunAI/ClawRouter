#!/usr/bin/env node
/**
 * ClawRouter CLI
 *
 * Standalone proxy for deployed setups where the proxy needs to survive gateway restarts.
 *
 * Usage:
 *   npx @blockrun/clawrouter              # Start standalone proxy
 *   npx @blockrun/clawrouter --version    # Show version
 *   npx @blockrun/clawrouter --port 8402  # Custom port
 *
 * For production deployments, use with PM2:
 *   pm2 start "npx @blockrun/clawrouter" --name clawrouter
 */

import { startProxy, getProxyPort } from "./proxy.js";
import { resolveOrGenerateWalletKey } from "./auth.js";
import { BalanceMonitor } from "./balance.js";
import { VERSION } from "./version.js";

const CLAWCREDIT_DEFAULT_BASE_URL = "https://api.claw.credit";
const CLAWCREDIT_DEFAULT_CHAIN = "BASE";
const CLAWCREDIT_DEFAULT_ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function printHelp(): void {
  console.log(`
ClawRouter v${VERSION} - Smart LLM Router

Usage:
  clawrouter [options]

Options:
  --version, -v     Show version number
  --help, -h        Show this help message
  --port <number>   Port to listen on (default: ${getProxyPort()})

Examples:
  # Start standalone proxy (survives gateway restarts)
  npx @blockrun/clawrouter

  # Start on custom port
  npx @blockrun/clawrouter --port 9000

  # Production deployment with PM2
  pm2 start "npx @blockrun/clawrouter" --name clawrouter

Environment Variables:
  BLOCKRUN_WALLET_KEY     Private key for x402 payments (auto-generated if not set)
  BLOCKRUN_PAYMENT_MODE   wallet | clawcredit (default: wallet)
  CLAWCREDIT_API_TOKEN    Required when BLOCKRUN_PAYMENT_MODE=clawcredit
  CLAWCREDIT_BASE_URL     claw.credit API URL (default: https://api.claw.credit)
  CLAWCREDIT_PAYMENT_CHAIN Chain for claw.credit transaction (default: BASE)
  CLAWCREDIT_PAYMENT_ASSET Asset for claw.credit transaction (default: Base USDC)
  BLOCKRUN_PROXY_PORT     Default proxy port (default: 8402)

For more info: https://github.com/BlockRunAI/ClawRouter
`);
}

function parseArgs(args: string[]): { version: boolean; help: boolean; port?: number } {
  const result = { version: false, help: false, port: undefined as number | undefined };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--version" || arg === "-v") {
      result.version = true;
    } else if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else if (arg === "--port" && args[i + 1]) {
      result.port = parseInt(args[i + 1], 10);
      i++; // Skip next arg
    }
  }

  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.version) {
    console.log(VERSION);
    process.exit(0);
  }

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const paymentMode = (process.env.BLOCKRUN_PAYMENT_MODE || "wallet").trim().toLowerCase();
  const useClawCredit = paymentMode === "clawcredit";

  let address = "clawcredit";
  let walletKey: string | undefined;
  let clawCreditConfig:
    | { baseUrl: string; apiToken: string; chain: string; asset: string }
    | undefined;

  if (useClawCredit) {
    const apiToken = (process.env.CLAWCREDIT_API_TOKEN || "").trim();
    if (!apiToken) {
      throw new Error("CLAWCREDIT_API_TOKEN is required when BLOCKRUN_PAYMENT_MODE=clawcredit");
    }

    clawCreditConfig = {
      baseUrl: (process.env.CLAWCREDIT_BASE_URL || CLAWCREDIT_DEFAULT_BASE_URL).trim(),
      apiToken,
      chain: (process.env.CLAWCREDIT_PAYMENT_CHAIN || CLAWCREDIT_DEFAULT_CHAIN).trim().toUpperCase(),
      asset: (process.env.CLAWCREDIT_PAYMENT_ASSET || CLAWCREDIT_DEFAULT_ASSET).trim(),
    };
    console.log(
      `[ClawRouter] Using claw.credit mode (${clawCreditConfig.baseUrl}, ${clawCreditConfig.chain})`,
    );
  } else {
    // Resolve wallet key
    const resolved = await resolveOrGenerateWalletKey();
    walletKey = resolved.key;
    address = resolved.address;

    if (resolved.source === "generated") {
      console.log(`[ClawRouter] Generated new wallet: ${resolved.address}`);
    } else if (resolved.source === "saved") {
      console.log(`[ClawRouter] Using saved wallet: ${resolved.address}`);
    } else {
      console.log(`[ClawRouter] Using wallet from BLOCKRUN_WALLET_KEY: ${resolved.address}`);
    }
  }

  // Start the proxy
  const proxy = await startProxy({
    paymentMode: useClawCredit ? "clawcredit" : "wallet",
    walletKey,
    clawCredit: clawCreditConfig,
    port: args.port,
    onReady: (port) => {
      console.log(`[ClawRouter] Proxy listening on http://127.0.0.1:${port}`);
      console.log(`[ClawRouter] Health check: http://127.0.0.1:${port}/health`);
    },
    onError: (error) => {
      console.error(`[ClawRouter] Error: ${error.message}`);
    },
    onRouted: (decision) => {
      const cost = decision.costEstimate.toFixed(4);
      const saved = (decision.savings * 100).toFixed(0);
      console.log(`[ClawRouter] [${decision.tier}] ${decision.model} $${cost} (saved ${saved}%)`);
    },
    onLowBalance: (info) => {
      console.warn(`[ClawRouter] Low balance: ${info.balanceUSD}. Fund: ${info.walletAddress}`);
    },
    onInsufficientFunds: (info) => {
      console.error(
        `[ClawRouter] Insufficient funds. Balance: ${info.balanceUSD}, Need: ${info.requiredUSD}`,
      );
    },
  });

  if (!useClawCredit) {
    // Check balance
    const monitor = new BalanceMonitor(address);
    try {
      const balance = await monitor.checkBalance();
      if (balance.isEmpty) {
        console.log(`[ClawRouter] Wallet balance: $0.00 (using FREE model)`);
        console.log(`[ClawRouter] Fund wallet for premium models: ${address}`);
      } else if (balance.isLow) {
        console.log(`[ClawRouter] Wallet balance: ${balance.balanceUSD} (low)`);
      } else {
        console.log(`[ClawRouter] Wallet balance: ${balance.balanceUSD}`);
      }
    } catch {
      console.log(`[ClawRouter] Wallet: ${address} (balance check pending)`);
    }
  } else {
    console.log("[ClawRouter] Payments managed by claw.credit");
  }

  console.log(`[ClawRouter] Ready - Ctrl+C to stop`);

  // Handle graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[ClawRouter] Received ${signal}, shutting down...`);
    try {
      await proxy.close();
      console.log(`[ClawRouter] Proxy closed`);
      process.exit(0);
    } catch (err) {
      console.error(`[ClawRouter] Error during shutdown: ${err}`);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Keep process alive
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(`[ClawRouter] Fatal error: ${err.message}`);
  process.exit(1);
});
