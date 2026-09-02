// src/utils/polymarket/withdraw.ts
//
// Cash out: pUSD in the deposit wallet → native USDC on Base, delivered to the
// BlockRun agent wallet (the same key/address that pays x402 AI fees) — closing
// the loop. Flow (Polymarket bridge):
//   1. POST /withdraw {address, toChainId, toTokenAddress, recipientAddr} → a
//      one-time EVM bridge address.
//   2. Transfer pUSD FROM the deposit wallet TO that bridge address (gasless
//      relayer WALLET batch; or a direct tx in EOA mode). The amount sent IS the
//      withdrawal amount.
//   3. The bridge unwraps pUSD → USDC (Collateral Offramp + Uniswap v3) and
//      sends it to recipientAddr on Base. Instant, no Polymarket fee (minor
//      swap slippage may apply).
import axios from "axios";
import { encodeFunctionData, formatUnits, http, createWalletClient, type Hex } from "viem";
import { polygon } from "viem/chains";
import {
  BASE_CHAIN_ID,
  BASE_USDC,
  BRIDGE_API_HOST,
  ERC20_ABI,
  getBuilderCode,
  getSigType,
  POLYGON_RPC_URLS,
  PUSD_COLLATERAL,
  PUSD_DECIMALS,
} from "./constants.js";
import { getPolymarketAccount } from "./client.js";
import type { ToolResult } from "./orders.js";
import { mapClobError } from "./orders.js";
import { getFundsAddress } from "./positions.js";
import { sendWalletBatch } from "./relayer.js";
import { getPublicClient } from "./setup.js";
import { signUnderSpendPolicy, type PolymarketSpendDeps } from "./spend-policy.js";

async function rawPusdBalance(owner: Hex): Promise<bigint> {
  return getPublicClient().readContract({
    address: PUSD_COLLATERAL as Hex,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [owner],
  });
}

interface WithdrawInput {
  amount_usd?: number;
  to_address?: string;
  confirm?: boolean;
}

export async function withdrawFunds(
  input: WithdrawInput,
  deps?: PolymarketSpendDeps,
): Promise<ToolResult> {
  let owner: Hex;
  try {
    owner = getFundsAddress();
  } catch (err) {
    return { text: err instanceof Error ? err.message : String(err), isError: true };
  }
  const recipient = (input.to_address as Hex) || getPolymarketAccount().address;

  try {
    // Amount: explicit amount_usd, else the full pUSD balance.
    const balanceRaw = await rawPusdBalance(owner);
    const balanceUsd = Number(formatUnits(balanceRaw, PUSD_DECIMALS));
    if (balanceRaw === 0n) {
      return {
        text: `No pUSD to withdraw — the deposit wallet ${owner} holds $0. (Redeem/sell a position first.)`,
        isError: true,
      };
    }
    const amountRaw =
      input.amount_usd !== undefined
        ? BigInt(Math.floor(input.amount_usd * 10 ** PUSD_DECIMALS))
        : balanceRaw;
    if (amountRaw > balanceRaw) {
      return {
        text: `Requested $${input.amount_usd} exceeds the pUSD balance of $${balanceUsd.toFixed(2)}.`,
        isError: true,
      };
    }
    const amountUsd = Number(formatUnits(amountRaw, PUSD_DECIMALS));

    if (input.confirm !== true) {
      return {
        text: [
          `DRY RUN — nothing withdrawn.`,
          `Withdraw $${amountUsd.toFixed(2)} pUSD → native USDC on Base`,
          `  from deposit wallet: ${owner}`,
          `  to (agent wallet): ${recipient}`,
          ``,
          `pUSD is unwrapped to USDC (Uniswap v3 — minor slippage may apply); instant, no Polymarket fee.`,
          `Re-call with confirm:true to execute.`,
        ].join("\n"),
        structured: {
          dryRun: true,
          amountUsd,
          from: owner,
          to: recipient,
          toChainId: BASE_CHAIN_ID,
          toToken: BASE_USDC,
        },
      };
    }

    // 1. Ask the bridge for a one-time deposit address for this withdrawal.
    const headers: Record<string, string> = { "content-type": "application/json" };
    const builderCode = getBuilderCode();
    if (builderCode) headers["X-Builder-Code"] = builderCode;
    const wres = await axios.post(
      `${BRIDGE_API_HOST}/withdraw`,
      {
        address: owner,
        toChainId: String(BASE_CHAIN_ID),
        toTokenAddress: BASE_USDC,
        recipientAddr: recipient,
      },
      { headers, timeout: 20_000 },
    );
    const bridgeEvm = (wres.data as { address?: { evm?: string } })?.address?.evm as
      Hex | undefined;
    if (!bridgeEvm) {
      return {
        text: `Bridge did not return a withdrawal address (got: ${JSON.stringify(wres.data)}).`,
        isError: true,
      };
    }

    // 2. Transfer pUSD from the deposit wallet to the bridge address.
    // Spend policy sees the DESTINATION leg — recipient, Base, USDC — not the
    // signed Polygon transfer: the bridge address is one-time and cannot be
    // allowlisted, while to_address is agent-chosen and is what an operator's
    // payee list must govern. Amount is the exact pUSD sent (6 dp = micros).
    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [bridgeEvm, amountRaw],
    });
    const eoa = getSigType() !== 3;
    const txHash = await signUnderSpendPolicy(
      deps,
      {
        payTo: recipient,
        network: `eip155:${BASE_CHAIN_ID}`,
        asset: BASE_USDC,
        amount: amountRaw.toString(),
      },
      "polymarket withdraw",
      async () => {
        if (!eoa) {
          const res = await sendWalletBatch(
            [{ target: PUSD_COLLATERAL, value: "0", data }],
            owner,
            "Withdraw",
          );
          return res.transactionHash;
        }
        const account = getPolymarketAccount();
        const wallet = createWalletClient({
          account,
          chain: polygon,
          transport: http(POLYGON_RPC_URLS[0]),
        });
        return wallet.sendTransaction({
          to: PUSD_COLLATERAL as Hex,
          data,
          chain: polygon,
          account,
        });
      },
    );
    // Signed = spend; the receipt wait sits outside so a slow confirmation
    // cannot release a reservation for a transfer that was already broadcast.
    if (eoa) await getPublicClient().waitForTransactionReceipt({ hash: txHash as Hex });

    return {
      text: [
        `✅ Withdrawal submitted: $${amountUsd.toFixed(2)} pUSD → USDC on Base`,
        `  to your agent wallet: ${recipient}`,
        ...(txHash ? [`  pUSD transfer tx: https://polygonscan.com/tx/${txHash}`] : []),
        `  The bridge unwraps + delivers USDC to Base (usually within a minute).`,
        `  Track: GET ${BRIDGE_API_HOST}/status/${owner}`,
      ].join("\n"),
      structured: {
        amountUsd,
        from: owner,
        to: recipient,
        toChainId: BASE_CHAIN_ID,
        toToken: BASE_USDC,
        bridgeAddress: bridgeEvm,
        transactionHash: txHash,
      },
    };
  } catch (err) {
    return { text: await mapClobError(err), isError: true };
  }
}
