// src/utils/polymarket/redeem.ts
//
// Claim winnings for a resolved market. Burns the ERC-1155 outcome tokens and
// credits collateral back to the funds wallet:
//   - POLY_1271: a gasless relayer WALLET batch executed BY the deposit wallet
//     (redeemPositions credits msg.sender, i.e. the deposit wallet).
//   - EOA mode: a direct transaction from the EOA (needs POL gas).
//
// Target contracts:
//   - standard binary markets → ConditionalTokens.redeemPositions(collateral,
//     0x0, conditionId, [1, 2])
//   - negRisk markets → NegRiskAdapter.redeemPositions(conditionId, [yesAmt,
//     noAmt]) (adapter must be CTF-approved — done in setup)
//
// Collateral note: V2-era conditions settle in pUSD; conditions prepared
// before the 2026-04-28 cutover may use legacy USDC.e collateral, in which
// case the standard redeem with pUSD reverts — the error message says so and
// the relayer batch simply fails without side effects.
import { createWalletClient, encodeFunctionData, http, type Hex } from "viem";
import { polygon } from "viem/chains";
import { getClobClient, getPolymarketAccount } from "./client.js";
import {
  CONDITIONAL_TOKENS,
  ERC1155_ABI,
  getSigType,
  NEG_RISK_ADAPTER,
  NEG_RISK_ADAPTER_ABI,
  POLYGON_CHAIN_ID,
  POLYGON_RPC_URLS,
  PUSD_COLLATERAL,
  PUSD_DECIMALS,
} from "./constants.js";
import type { ToolResult } from "./orders.js";
import { mapClobError } from "./orders.js";
import { getFundsAddress } from "./positions.js";
import { sendWalletBatch } from "./relayer.js";
import { getPublicClient, getPusdBalance } from "./setup.js";
import { signUnderSpendPolicy, type PolymarketSpendDeps } from "./spend-policy.js";

interface ClobMarketToken {
  token_id?: string;
  outcome?: string;
  winner?: boolean;
}

export async function redeemPosition(
  input: { condition_id?: string; confirm?: boolean },
  deps?: PolymarketSpendDeps,
): Promise<ToolResult> {
  if (!input.condition_id) {
    return {
      text: `Pass condition_id:"0x…" (see action:"positions" for redeemable markets).`,
      isError: true,
    };
  }
  const conditionId = input.condition_id as Hex;

  let owner: Hex;
  try {
    owner = getFundsAddress();
  } catch (err) {
    return { text: err instanceof Error ? err.message : String(err), isError: true };
  }

  try {
    // Market metadata (question, outcome tokens, negRisk) via the CLOB.
    const clob = await getClobClient();
    const market = (await clob.getMarket(conditionId)) as {
      question?: string;
      neg_risk?: boolean;
      closed?: boolean;
      tokens?: ClobMarketToken[];
    };
    const tokens = (market?.tokens ?? []).filter((t) => t.token_id);
    if (!tokens.length)
      return { text: `No tokens found for condition ${conditionId}.`, isError: true };

    // Exact on-chain balances per outcome token — the redeem amounts.
    const pc = getPublicClient();
    const balances: bigint[] = [];
    for (const t of tokens) {
      balances.push(
        await pc.readContract({
          address: CONDITIONAL_TOKENS as Hex,
          abi: ERC1155_ABI,
          functionName: "balanceOf",
          args: [owner, BigInt(t.token_id as string)],
        }),
      );
    }
    if (balances.every((b) => b === 0n)) {
      return {
        text: `Nothing to redeem: ${owner} holds no outcome tokens for "${market?.question ?? conditionId}".`,
        isError: true,
      };
    }

    const negRisk = Boolean(market?.neg_risk);
    const held = tokens
      .map((t, i) => ({
        outcome: t.outcome,
        winner: t.winner,
        shares: Number(balances[i]) / 10 ** PUSD_DECIMALS,
      }))
      .filter((h) => h.shares > 0);
    const heldText = held
      .map(
        (h) =>
          `  ${h.shares.toFixed(2)} × "${h.outcome}"${h.winner ? " (winner → pays $1/share)" : ""}`,
      )
      .join("\n");

    if (input.confirm !== true) {
      return {
        text: [
          `DRY RUN — nothing redeemed.`,
          `Market: ${market?.question ?? conditionId}${market?.closed === false ? " ⚠️ (not closed yet — redeem will revert until resolution)" : ""}`,
          `Holdings:`,
          heldText,
          ``,
          `Re-call with confirm:true to redeem the FULL balance (Polymarket redeems`,
          `everything for the condition; partial redemption is not supported).`,
        ].join("\n"),
        structured: { dryRun: true, conditionId, negRisk, holdings: held },
      };
    }

    const data = negRisk
      ? encodeFunctionData({
          abi: NEG_RISK_ADAPTER_ABI,
          functionName: "redeemPositions",
          args: [conditionId, balances],
        })
      : encodeFunctionData({
          abi: ERC1155_ABI,
          functionName: "redeemPositions",
          args: [
            PUSD_COLLATERAL as Hex,
            "0x0000000000000000000000000000000000000000000000000000000000000000",
            conditionId,
            [1n, 2n],
          ],
        });
    const target = (negRisk ? NEG_RISK_ADAPTER : CONDITIONAL_TOKENS) as Hex;

    // Spend policy sees the protocol contract being signed (ConditionalTokens
    // or NegRiskAdapter on Polygon) with amount 0: a redeem moves NO capital
    // out — it burns this wallet's own outcome tokens and credits collateral
    // back to the same wallet — so there is no spend to reserve. The check is
    // still required: an operator's payee/network lists are a total statement
    // about what may be signed, and this keeps every signing path under them.
    const eoa = getSigType() !== 3;
    const txHash = await signUnderSpendPolicy(
      deps,
      {
        payTo: target,
        network: `eip155:${POLYGON_CHAIN_ID}`,
        asset: PUSD_COLLATERAL,
        amount: "0",
      },
      "polymarket redeem",
      async () => {
        if (!eoa) {
          const res = await sendWalletBatch([{ target, value: "0", data }], owner, "Redeem");
          return res.transactionHash;
        }
        const account = getPolymarketAccount();
        const wallet = createWalletClient({
          account,
          chain: polygon,
          transport: http(POLYGON_RPC_URLS[0]),
        });
        return wallet.sendTransaction({ to: target, data, chain: polygon, account });
      },
    );
    if (!eoa) await pc.waitForTransactionReceipt({ hash: txHash as Hex });

    const balanceAfter = await getPusdBalance(owner).catch(() => null);
    return {
      text: [
        `✅ Redeemed "${market?.question ?? conditionId}".`,
        heldText,
        ...(txHash ? [`  tx: https://polygonscan.com/tx/${txHash}`] : []),
        ...(balanceAfter !== null
          ? [`  Funds wallet pUSD balance: $${balanceAfter.toFixed(2)}`]
          : []),
      ].join("\n"),
      structured: { conditionId, negRisk, transactionHash: txHash, pusdBalance: balanceAfter },
    };
  } catch (err) {
    const base = await mapClobError(err);
    const legacyHint =
      ` If this market predates the 2026-04-28 V2 cutover it may settle in legacy ` +
      `USDC.e collateral, which this tool does not auto-detect yet — redeem it once via the Polymarket UI.`;
    return {
      text: `${base}${/revert|execution reverted|failed/i.test(base) ? legacyHint : ""}`,
      isError: true,
    };
  }
}
