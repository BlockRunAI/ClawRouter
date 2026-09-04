// src/polymarket/tool.ts
//
// The `blockrun_polymarket` executable tool for ClawRouter. Unlike the partner
// data tools (thin HTTP proxies to /v1/*), this one runs a LOCAL trading engine:
// it signs Polymarket CLOB V2 orders (EIP-712) with ClawRouter's own EVM key and
// posts them to Polymarket (via a Tokyo egress relay by default). Ported from
// blockrun-mcp's `blockrun_polymarket` MCP tool; the dispatch mirrors that tool
// verbatim, reshaped into ClawRouter's PartnerToolDefinition contract.
//
// REAL MONEY: buy/sell/redeem/withdraw/fund move the user's own pUSD/USDC. The
// engine's guardrails (confirm:true hard gate, POLYMARKET_MAX_BET_USD per-order
// cap, optional session cap) are unchanged from the source.
import type { PartnerToolDefinition } from "../partners/tools.js";
import type { PolymarketSpendDeps } from "./spend-policy.js";
import {
  executeTrade,
  listOpenOrders,
  cancelOrdersAction,
  getSessionLedger,
  type ToolResult,
} from "./orders.js";
import { listPositions } from "./positions.js";
import { redeemPosition } from "./redeem.js";
import { runSetup } from "./setup.js";
import { withdrawFunds } from "./withdraw.js";
import { fundVault } from "./fund.js";

const DESCRIPTION = `Trade on Polymarket prediction markets (CLOB V2, Polygon). REAL MONEY — orders spend pUSD held in your Polymarket deposit wallet, signed locally by your ClawRouter wallet key (the same wallet that pays for LLM calls). Free tool (no BlockRun API charge); discover markets/prices/token IDs with blockrun_pm_* data tools first.

Run action:"setup" FIRST (and again after funding). It creates a gasless deposit wallet owned by your key, checks pUSD balance + exchange approvals, and prints funding instructions.

Actions:
- setup — create/inspect deposit wallet, funding, approvals (confirm:true to sign the approval batch), region check. Idempotent.
- fund — top up the deposit wallet from your OWN Base USDC, gasless (confirm:true). amount_usd required. BlockRun pays the gas + charges $0.01; you need no ETH. Non-custodial (USDC → Polymarket bridge → your vault).
- buy / sell — token_id (or condition_id+outcome) + either price+size (limit) or amount_usd (market buy) / size (market sell). confirm:true REQUIRED to place; omitting it returns a dry-run preview. Per-order cap: POLYMARKET_MAX_BET_USD (default $25).
- orders — list open orders (optional condition_id filter)
- cancel — order_id:"…" or all:true
- positions — holdings incl. redeemable winnings (free Data-API)
- redeem — claim resolved winnings for condition_id (confirm:true; gasless)
- withdraw — cash out pUSD → native USDC on Base to your agent wallet (confirm:true). amount_usd optional (default: full balance); to_address optional (default: your wallet).

Prices are probabilities 0–1 on the market's tick grid. token_id = clobTokenIds from Polymarket market data. Order placement is geoblocked in some regions (US/UK/EU are close-only; cancel/sell/redeem still work) — setup reports your status.`;

/**
 * Build the blockrun_polymarket tool. Registered alongside the partner tools in
 * src/index.ts via api.registerTool(). `deps` carries the process-wide
 * SpendControl from the wiring site so the tool's signing paths enforce the
 * SAME amount-window ledger the proxy records x402 payments against — omit it
 * and the tool functions resolve the same shared instance themselves.
 */
export function buildPolymarketTool(deps?: PolymarketSpendDeps): PartnerToolDefinition {
  return {
    name: "blockrun_polymarket",
    description: DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "setup",
            "fund",
            "buy",
            "sell",
            "cancel",
            "orders",
            "positions",
            "redeem",
            "withdraw",
          ],
          description: "Operation to perform",
        },
        token_id: {
          type: "string",
          description: "Outcome token ID (decimal ERC-1155 id from Polymarket clobTokenIds)",
        },
        condition_id: {
          type: "string",
          description:
            "Market condition ID (0x…). With `outcome` it resolves token_id; required for redeem.",
        },
        outcome: {
          type: "string",
          description:
            "Outcome label (e.g. 'Yes') — used with condition_id when token_id is omitted",
        },
        price: {
          type: "number",
          description: "Limit price as probability (0–1, exclusive). Omit for a market order.",
        },
        size: {
          type: "number",
          description: "Shares — required for limit orders and market sells",
        },
        amount_usd: {
          type: "number",
          description:
            "pUSD dollars — to spend (market buy) or to cash out (withdraw; default full balance)",
        },
        order_type: {
          type: "string",
          enum: ["GTC", "GTD", "FOK", "FAK"],
          description: "Default: GTC for limit orders, FOK for market orders",
        },
        expires_at: {
          type: "number",
          description: "Unix seconds expiry (GTD only, ≥ ~3 min in the future)",
        },
        post_only: {
          type: "boolean",
          description: "Maker-only limit order (rejected if it would cross the book)",
        },
        order_id: { type: "string", description: "Order ID to cancel" },
        all: { type: "boolean", description: "cancel: cancel ALL open orders" },
        to_address: {
          type: "string",
          description: "withdraw: destination address on Base (default: your agent wallet)",
        },
        confirm: {
          type: "boolean",
          description:
            "Must be true to place orders / sign approvals / redeem. Omit for a dry-run preview.",
        },
        agent_id: {
          type: "string",
          description:
            "Tag for the session betting ledger (bets do NOT draw from the x402 API budget)",
        },
      },
      required: ["action"],
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      const action = params.action as string;
      const confirm = params.confirm === true;
      let result: ToolResult;
      switch (action) {
        case "setup":
          result = await runSetup({ confirm });
          break;
        case "fund":
          result = await fundVault(
            {
              amount_usd: params.amount_usd as number | undefined,
              confirm,
            },
            deps,
          );
          break;
        case "buy":
        case "sell":
          result = await executeTrade(
            {
              action,
              token_id: params.token_id as string | undefined,
              condition_id: params.condition_id as string | undefined,
              outcome: params.outcome as string | undefined,
              price: params.price as number | undefined,
              size: params.size as number | undefined,
              amount_usd: params.amount_usd as number | undefined,
              order_type: params.order_type as "GTC" | "GTD" | "FOK" | "FAK" | undefined,
              expires_at: params.expires_at as number | undefined,
              post_only: params.post_only as boolean | undefined,
              confirm,
            },
            deps,
          );
          break;
        case "orders":
          result = await listOpenOrders({
            condition_id: params.condition_id as string | undefined,
          });
          break;
        case "cancel":
          result = await cancelOrdersAction({
            order_id: params.order_id as string | undefined,
            all: params.all as boolean | undefined,
          });
          break;
        case "positions":
          result = await listPositions();
          break;
        case "redeem":
          result = await redeemPosition(
            {
              condition_id: params.condition_id as string | undefined,
              confirm,
            },
            deps,
          );
          break;
        case "withdraw":
          result = await withdrawFunds(
            {
              amount_usd: params.amount_usd as number | undefined,
              to_address: params.to_address as string | undefined,
              confirm,
            },
            deps,
          );
          break;
        default:
          throw new Error(`Unknown blockrun_polymarket action: ${action}`);
      }

      // Polymarket error texts are already actionable (setup/proxy/region
      // guidance) — surface them as text rather than throwing, so the guidance
      // reaches the agent instead of a generic tool-failure wrapper.
      const text = result.isError ? `Error: ${result.text}` : result.text;
      return {
        content: [{ type: "text", text }],
        details: result.structured ?? { session: getSessionLedger() },
      };
    },
  };
}
