// src/utils/polymarket/orders.ts
//
// buy / sell / cancel / open-orders flows. Safety model:
//   - confirm:true is HARD-REQUIRED to place an order; without it the call
//     returns a dry-run preview and signs nothing.
//   - per-order notional capped by POLYMARKET_MAX_BET_USD (default $25).
//   - optional POLYMARKET_MAX_SESSION_USD cumulative cap, tracked in-memory
//     with per-agent attribution (agent_id).
//   - the operator's spend policy (spending.json payee/network/asset lists and
//     amount windows) is checked against the exchange contract on Polygon
//     BEFORE the order is signed — see spend-policy.ts. The two notional caps
//     above remain a separate in-memory ledger.
import {
  OrderType,
  Side,
  type ClobClient,
  type OrderBookSummary,
} from "@polymarket/clob-client-v2";
import { checkGeoblock, getClobClient, getPolymarketAccount, resetClobClient } from "./client.js";
import {
  CTF_EXCHANGE_V2,
  getMaxBetUsd,
  getMaxSessionUsd,
  NEG_RISK_CTF_EXCHANGE_V2,
  POLYGON_CHAIN_ID,
  PUSD_COLLATERAL,
} from "./constants.js";
import { invalidateL2Creds } from "./creds.js";
import { SpendPolicyError } from "../spend-control.js";
import { signUnderSpendPolicy, usdToMicros, type PolymarketSpendDeps } from "./spend-policy.js";

// --- Session bet ledger (in-memory; resets with the process) ---
const ledger = {
  totalUsd: 0,
  count: 0,
  perAgent: new Map<string, number>(),
};

export function getSessionLedger(): {
  totalUsd: number;
  count: number;
  perAgent: Record<string, number>;
} {
  return {
    totalUsd: ledger.totalUsd,
    count: ledger.count,
    perAgent: Object.fromEntries(ledger.perAgent),
  };
}

/** Reserve spend against the ledger before an awaited submit (no count yet). */
function reserveBet(usd: number, agentId?: string): void {
  ledger.totalUsd += usd;
  if (agentId) ledger.perAgent.set(agentId, (ledger.perAgent.get(agentId) ?? 0) + usd);
}

/** Undo a reservation when the order failed to place. */
function releaseBet(usd: number, agentId?: string): void {
  ledger.totalUsd -= usd;
  if (agentId) ledger.perAgent.set(agentId, (ledger.perAgent.get(agentId) ?? 0) - usd);
}

/** Confirm a placed order (bump the count; spend was already reserved). */
function commitBet(): void {
  ledger.count += 1;
}

// --- Helpers ---

/**
 * Round a probability price onto the market's tick grid, CONSERVATIVELY by side:
 * a BUY rounds DOWN and a SELL rounds UP, so the signed order is never priced
 * worse than the user's stated limit. (Plain Math.round could round a buy at
 * 0.556 up to 0.56 — signing above the limit; near the grid floor a buy at
 * 0.0051 would round up to a full tick, doubling notional.) A sub-tick buy
 * floors to 0, which the caller's range check then rejects with a clear error
 * rather than silently lifting it to the first tick.
 */
export function roundToTick(price: number, tickSize: string, side: "buy" | "sell" = "buy"): number {
  const tick = parseFloat(tickSize);
  const decimals = Math.max(0, (tickSize.split(".")[1] ?? "").length);
  const steps = side === "buy" ? Math.floor(price / tick) : Math.ceil(price / tick);
  return Number((steps * tick).toFixed(decimals));
}

interface ResolvedToken {
  tokenId: string;
  question?: string;
  outcome?: string;
  conditionId?: string;
  closed?: boolean;
  acceptingOrders?: boolean;
}

interface ClobMarketToken {
  token_id?: string;
  outcome?: string;
}
interface ClobMarket {
  question?: string;
  condition_id?: string;
  tokens?: ClobMarketToken[];
  closed?: boolean;
  accepting_orders?: boolean;
}

async function resolveToken(
  clob: ClobClient,
  input: { token_id?: string; condition_id?: string; outcome?: string },
): Promise<ResolvedToken> {
  if (input.token_id) return { tokenId: input.token_id };
  if (!input.condition_id) {
    throw new Error(
      `Provide token_id, or condition_id + outcome (find them via blockrun_markets).`,
    );
  }
  const market = (await clob.getMarket(input.condition_id)) as ClobMarket;
  const tokens = market?.tokens ?? [];
  if (!tokens.length) throw new Error(`No tokens found for condition ${input.condition_id}.`);
  const want = input.outcome?.toLowerCase();
  const match = want ? tokens.find((t) => t.outcome?.toLowerCase() === want) : undefined;
  if (!match?.token_id) {
    const available = tokens
      .map((t) => t.outcome)
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `Outcome ${input.outcome ? `'${input.outcome}'` : "(none given)"} not found for this market. ` +
        `Available outcomes: ${available}. Pass outcome (e.g. "Yes") with condition_id, or a token_id directly.`,
    );
  }
  return {
    tokenId: match.token_id,
    question: market.question,
    outcome: match.outcome,
    conditionId: market.condition_id ?? input.condition_id,
    closed: market.closed,
    acceptingOrders: market.accepting_orders,
  };
}

function bestQuote(book: OrderBookSummary, side: "buy" | "sell"): number | null {
  // Asks fill buys, bids fill sells. Books are not guaranteed sorted; scan.
  const levels = side === "buy" ? book.asks : book.bids;
  if (!levels?.length) return null;
  const prices = levels.map((l) => parseFloat(l.price)).filter((p) => Number.isFinite(p));
  if (!prices.length) return null;
  return side === "buy" ? Math.min(...prices) : Math.max(...prices);
}

/**
 * True when an error is a CLOB credential/auth failure worth re-deriving for
 * (the issue-#65 fingerprint, or a genuine auth rejection). Deliberately does
 * NOT scan response DATA for a bare "401": a token/condition id like
 * "0x8a401f…" or a fill line "filled 401 of 500" would false-positive and churn
 * valid creds. Auth signals are matched only in the human message; the HTTP
 * status (when present) is the authoritative 401 signal.
 */
function isCredsMismatchError(err: { message?: string; status?: number; data?: unknown }): boolean {
  const msg = (err.message ?? "").toLowerCase();
  const dataText =
    typeof err.data === "string"
      ? err.data.toLowerCase()
      : err.data
        ? JSON.stringify(err.data).toLowerCase()
        : "";
  // The #65 phrase is specific enough to trust anywhere (message or data body).
  if (`${msg} ${dataText}`.includes("order signer address has to be the address of the api key"))
    return true;
  if (err.status === 401) return true;
  return (
    msg.includes("unauthorized") ||
    msg.includes("api key not found") ||
    msg.includes("invalid api key")
  );
}

/** Map CLOB errors to actionable guidance. Exported for unit tests. */
export async function mapClobError(err: unknown): Promise<string> {
  if (err instanceof SpendPolicyError) {
    return `Refused by spend policy — nothing was signed. ${err.message} (see ~/.openclaw/blockrun/spending.json)`;
  }
  const e = err as { message?: string; status?: number; data?: unknown };
  const dataText = e?.data
    ? ` — ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}`
    : "";
  const message = `${e?.message ?? String(err)}${dataText}`;
  const m = message.toLowerCase();

  if (e?.status === 403 || /(^|[^0-9.])403($|[^0-9.])/.test(m)) {
    const geo = await checkGeoblock();
    const where = geo.country ? ` (egress country: ${geo.country})` : "";
    return (
      `Order rejected with 403 — Polymarket geoblocks order placement from this egress${where} ` +
      `(US/UK/EU and many regions are restricted; automated trading is allowed from unrestricted egress). ` +
      `Fix: set POLYMARKET_CLOB_PROXY / HTTPS_PROXY, or point POLYMARKET_CLOB_HOST + POLYMARKET_RELAYER_URL ` +
      `at a Tokyo relay (deploy/tokyo-egress). Raw: ${message}`
    );
  }
  if (m.includes("maker address not allowed") || m.includes("deposit wallet flow")) {
    return (
      `Polymarket rejected this maker address — CLOB V2 requires the deposit-wallet flow to place ` +
      `orders (a plain EOA maker is not accepted). Use the default deposit-wallet mode: unset ` +
      `POLYMARKET_SIG_TYPE (=3) and set relayer creds (POLYMARKET_RELAYER_API_KEY/_SECRET/_PASSPHRASE) so ` +
      `action:"setup" can create your deposit wallet. Raw: ${message}`
    );
  }
  if (isCredsMismatchError(e)) {
    return (
      `CLOB rejected the API credentials (${message}). Credentials were re-derived automatically; ` +
      `if this persists, run action:"setup", or set POLYMARKET_SIG_TYPE=0 to fall back to plain EOA mode ` +
      `(see clob-client-v2 issue #65).`
    );
  }
  if (m.includes("not enough balance") || m.includes("insufficient") || m.includes("allowance")) {
    return (
      `Not enough balance/allowance (${message}). The funds wallet needs pUSD and exchange approvals — ` +
      `run action:"setup" (it also refreshes the CLOB's balance cache if you just funded).`
    );
  }
  if (m.includes("invalid price") || m.includes("tick")) {
    return (
      `Price rejected (${message}). Prices are probabilities on the market's tick grid — ` +
      `this tool rounds automatically, so if you see this the market's tick size may have changed; retry.`
    );
  }
  if (m.includes("closed") || m.includes("resolved") || m.includes("not accepting")) {
    return (
      `Market is not accepting orders (${message}). If it resolved in your favor, use action:"positions" ` +
      `then action:"redeem".`
    );
  }
  if (m.includes("fok") || m.includes("killed") || m.includes("not filled")) {
    return (
      `Fill-or-kill order could not fill completely (${message}). Try order_type:"FAK" (fills what it can) ` +
      `or a limit order at the shown book price.`
    );
  }
  return `Polymarket CLOB error: ${message}`;
}

function bindAddressForCreds(): { address: string; sigType: 0 | 3 } {
  // CLOB API creds are ALWAYS bound to the owner EOA (sigType 0), even in
  // POLY_1271 mode — see the note in client.ts getClobClient. The on-401 retry
  // must invalidate that same key, not the deposit wallet's.
  return { address: getPolymarketAccount().address, sigType: 0 };
}

/**
 * Run a CLOB call; on a creds-mismatch/401 (stale or EOA-bound creds — the
 * issue-#65 signature), invalidate the cached creds, rebuild the client (which
 * re-derives with the 7739-wrapped headers) and retry exactly once.
 */
async function withCredsRetry<T>(fn: (clob: ClobClient) => Promise<T>): Promise<T> {
  const clob = await getClobClient();
  try {
    return await fn(clob);
  } catch (err) {
    if (!isCredsMismatchError(err as { message?: string; status?: number; data?: unknown }))
      throw err;
    const { address, sigType } = bindAddressForCreds();
    if (address) invalidateL2Creds(address, sigType);
    resetClobClient();
    const fresh = await getClobClient();
    return fn(fresh);
  }
}

// --- Trade (buy/sell) ---

export interface TradeInput {
  action: "buy" | "sell";
  token_id?: string;
  condition_id?: string;
  outcome?: string;
  price?: number;
  size?: number;
  amount_usd?: number;
  order_type?: "GTC" | "GTD" | "FOK" | "FAK";
  expires_at?: number;
  post_only?: boolean;
  confirm?: boolean;
  agent_id?: string;
}

export interface ToolResult {
  text: string;
  structured?: Record<string, unknown>;
  isError?: boolean;
}

export async function executeTrade(
  input: TradeInput,
  deps?: PolymarketSpendDeps,
): Promise<ToolResult> {
  const side = input.action === "buy" ? Side.BUY : Side.SELL;
  const isLimit = input.price !== undefined;

  // Cross-field validation (zod schema is per-field; rules live here).
  if (isLimit && input.size === undefined) {
    return { text: `Limit orders need both price and size (shares).`, isError: true };
  }
  if (!isLimit && input.action === "buy" && input.amount_usd === undefined) {
    return {
      text: `Market buys need amount_usd (pUSD dollars to spend). For a limit order pass price + size.`,
      isError: true,
    };
  }
  // A non-positive amount_usd would otherwise become the order's notional
  // (see below) and, being additive, a negative value lets the ledger check
  // (`ledger.totalUsd + notional > sessionCap`) be satisfied by *reducing*
  // totalUsd instead of raising it — silently defeating POLYMARKET_MAX_SESSION_USD
  // for every order placed afterward. Reject before any network call, same as
  // fund.ts's amount_usd guard.
  //
  // Number.isFinite, not just `<= 0`: nothing validates this field at runtime.
  // tool.ts hands us `params.amount_usd as number | undefined`, a compile-time
  // cast over `Record<string, unknown>`, so NaN and strings arrive intact.
  // `NaN <= 0` and `"abc" <= 0` are both false, and a NaN notional poisons
  // ledger.totalUsd permanently (`totalUsd + NaN > cap` is false forever).
  if (
    !isLimit &&
    input.action === "buy" &&
    input.amount_usd !== undefined &&
    !(Number.isFinite(input.amount_usd) && input.amount_usd > 0)
  ) {
    return {
      text: `amount_usd must be a positive dollar amount to spend, got ${input.amount_usd}.`,
      isError: true,
    };
  }
  // Same class on the limit path, rejected before any network call. A negative
  // or NaN size makes notional (price * size) negative or NaN, which walks
  // through both the per-order and session caps. The later `minSize` check
  // cannot catch it: `book.min_order_size` is often absent, so
  // `parseFloat(undefined || "0")` is 0 and `minSize > 0` short-circuits.
  if (isLimit && input.size !== undefined && !(Number.isFinite(input.size) && input.size > 0)) {
    return {
      text: `size must be a positive number of shares, got ${input.size}.`,
      isError: true,
    };
  }
  if (!isLimit && input.action === "sell" && input.size === undefined) {
    return { text: `Market sells need size (shares to sell).`, isError: true };
  }
  if (input.order_type === "GTD" && input.expires_at === undefined) {
    return {
      text: `GTD orders need expires_at (unix seconds, at least ~3 minutes in the future).`,
      isError: true,
    };
  }
  if (isLimit && (input.order_type === "FOK" || input.order_type === "FAK")) {
    return {
      text: `FOK/FAK are market-order types — omit price for a market order, or use GTC/GTD for limits.`,
      isError: true,
    };
  }
  if (!isLimit && (input.order_type === "GTC" || input.order_type === "GTD")) {
    return {
      text: `GTC/GTD need a limit price. Pass price + size, or use FOK/FAK for market orders.`,
      isError: true,
    };
  }

  try {
    return await withCredsRetry(async (clob) => {
      const token = await resolveToken(clob, input);
      if (token.closed || token.acceptingOrders === false) {
        return {
          text:
            `Market "${token.question ?? token.conditionId}" is not accepting orders (closed/resolved). ` +
            `Use action:"positions" and action:"redeem" if you hold a winning position.`,
          isError: true,
        };
      }

      const book = await clob.getOrderBook(token.tokenId);
      const tickSize = book.tick_size as `${number}` | string;
      const negRisk = Boolean(book.neg_risk);
      const minSize = parseFloat(book.min_order_size || "0");
      const quote = bestQuote(book, input.action);

      // Normalize the order economics for validation + preview. Round
      // conservatively by side so the signed price never beats the user's limit.
      const price =
        input.price !== undefined ? roundToTick(input.price, tickSize, input.action) : undefined;
      const tick = parseFloat(tickSize);
      if (price !== undefined && (price < tick || price > 1 - tick)) {
        return {
          text:
            `Price ${input.price} rounds to ${price}, outside this market's valid range ` +
            `(${tick} – ${1 - tick}, tick ${tickSize}). A buy below one tick cannot cross any valid ask.`,
          isError: true,
        };
      }
      const size = input.size;

      // A market SELL's notional depends on the live best bid; if the book has
      // no parseable bid we cannot bound the spend, so REJECT rather than let a
      // $0 notional silently bypass the caps (the SDK would still fill it).
      if (!isLimit && input.action === "sell" && !quote) {
        return {
          text:
            `Cannot price a market sell right now — the order book has no bid to estimate against. ` +
            `Retry shortly, or place a limit sell with an explicit price.`,
          isError: true,
        };
      }

      const notional = isLimit
        ? (price as number) * (size as number)
        : input.action === "buy"
          ? (input.amount_usd as number)
          : (size as number) * (quote as number);

      if (isLimit && minSize > 0 && (size as number) < minSize) {
        return {
          text: `Size ${size} is below this market's minimum order size of ${minSize} shares.`,
          isError: true,
        };
      }

      const maxBet = getMaxBetUsd();
      if (notional > maxBet) {
        return {
          text:
            `Order notional ~$${notional.toFixed(2)} exceeds the per-order cap of $${maxBet} ` +
            `(POLYMARKET_MAX_BET_USD). Reduce the order or raise the cap explicitly.`,
          isError: true,
        };
      }
      // Reserve against the session cap ATOMICALLY, before the awaited submit,
      // so two concurrent orders can't both pass the check against a stale total
      // and jointly overshoot. Rolled back below if the order fails to place.
      const sessionCap = getMaxSessionUsd();
      if (sessionCap !== null && ledger.totalUsd + notional > sessionCap) {
        return {
          text:
            `Session betting total would reach $${(ledger.totalUsd + notional).toFixed(2)}, over the ` +
            `POLYMARKET_MAX_SESSION_USD cap of $${sessionCap} (spent so far: $${ledger.totalUsd.toFixed(2)}).`,
          isError: true,
        };
      }

      const orderKind = isLimit ? (input.order_type ?? "GTC") : (input.order_type ?? "FOK");
      const summary = [
        `${input.action.toUpperCase()} ${token.outcome ? `"${token.outcome}"` : `token ${token.tokenId.slice(0, 12)}…`}` +
          (token.question ? ` — ${token.question}` : ""),
        isLimit
          ? `  Limit ${orderKind}: ${size} shares @ ${price} (notional $${notional.toFixed(2)})`
          : input.action === "buy"
            ? `  Market ${orderKind}: spend $${(input.amount_usd as number).toFixed(2)}${quote ? ` (best ask ${quote})` : ""}`
            : `  Market ${orderKind}: sell ${size} shares${quote ? ` (best bid ${quote}, est. $${notional.toFixed(2)})` : ""}`,
        `  Tick ${tickSize} · negRisk ${negRisk} · min size ${minSize || "n/a"} · fees are taker-only`,
      ].join("\n");

      // Dry-run: no confirm → preview only, nothing is signed.
      if (input.confirm !== true) {
        return {
          text: `DRY RUN — no order placed.\n${summary}\n\nRe-call with confirm:true to sign and submit.`,
          structured: {
            dryRun: true,
            action: input.action,
            tokenId: token.tokenId,
            price,
            size,
            amountUsd: input.amount_usd,
            orderType: orderKind,
            notionalUsd: notional,
            tickSize,
            negRisk,
          },
        };
      }

      const options = { tickSize: tickSize as never, negRisk };

      // Reserve now (before the await) so a concurrent order sees this spend;
      // roll back if the submit throws so a failed order doesn't consume budget.
      reserveBet(notional, input.agent_id);
      // Counterparty for policy: the exchange the SDK signs the order for
      // (negRisk markets use the NegRisk exchange). Notional is quoted and
      // settles in pUSD on both sides, so the collateral is the asset checked.
      const policyQuote = {
        payTo: negRisk ? NEG_RISK_CTF_EXCHANGE_V2 : CTF_EXCHANGE_V2,
        network: `eip155:${POLYGON_CHAIN_ID}`,
        asset: PUSD_COLLATERAL,
        amount: usdToMicros(notional),
      };
      type ClobOrderResponse = {
        success?: boolean;
        errorMsg?: string;
        orderID?: string;
        status?: string;
        transactionsHashes?: string[];
        tradeIDs?: string[];
        takingAmount?: string;
        makingAmount?: string;
      };
      let r: ClobOrderResponse;
      try {
        r = await signUnderSpendPolicy(deps, policyQuote, "polymarket order", async () => {
          const res = (await (isLimit
            ? clob.createAndPostOrder(
                {
                  tokenID: token.tokenId,
                  price: price as number,
                  size: size as number,
                  side,
                  ...(orderKind === "GTD" && input.expires_at
                    ? { expiration: input.expires_at }
                    : {}),
                },
                options,
                orderKind === "GTD" ? OrderType.GTD : OrderType.GTC,
                input.post_only ?? false,
              )
            : clob.createAndPostMarketOrder(
                {
                  tokenID: token.tokenId,
                  amount: input.action === "buy" ? (input.amount_usd as number) : (size as number),
                  side,
                  orderType: orderKind === "FAK" ? OrderType.FAK : OrderType.FOK,
                },
                options,
                orderKind === "FAK" ? OrderType.FAK : OrderType.FOK,
              ))) as ClobOrderResponse;
          // The order is placed unless the CLOB explicitly says success:false (or
          // returns an error with no orderID). A non-empty errorMsg WITH success and
          // an orderID is informational — e.g. status "delayed", "order match delayed
          // due to market conditions" — the order IS live, so don't roll it back or a
          // retrying agent double-submits.
          const placed = res?.success !== false && (res?.orderID || res?.status === "matched");
          // Thrown from inside the policy callback on purpose: a resolved-but-
          // rejected CLOB response must release the spend-policy reservation
          // too, not only the session bet ledger below.
          if (!placed) throw new Error(res?.errorMsg || "order rejected");
          return res;
        });
      } catch (submitErr) {
        releaseBet(notional, input.agent_id);
        throw submitErr;
      }
      commitBet();

      const filled = r?.status === "matched" || (r?.transactionsHashes?.length ?? 0) > 0;
      return {
        text: [
          `✅ Order submitted.\n${summary}`,
          `  orderID: ${r?.orderID ?? "n/a"}`,
          `  status: ${r?.status ?? "submitted"}${filled ? "" : " (resting in the book until filled or cancelled)"}`,
          ...(r?.errorMsg ? [`  note: ${r.errorMsg}`] : []),
          ...(r?.transactionsHashes?.length ? [`  tx: ${r.transactionsHashes.join(", ")}`] : []),
          `  Session bets so far: $${ledger.totalUsd.toFixed(2)} across ${ledger.count} order(s).`,
        ].join("\n"),
        structured: {
          orderID: r?.orderID,
          status: r?.status,
          success: true,
          transactionsHashes: r?.transactionsHashes,
          tradeIDs: r?.tradeIDs,
          takingAmount: r?.takingAmount,
          makingAmount: r?.makingAmount,
          notionalUsd: notional,
          session: getSessionLedger(),
        },
      };
    });
  } catch (err) {
    return { text: await mapClobError(err), isError: true };
  }
}

// --- Open orders / cancel ---

export async function listOpenOrders(input: { condition_id?: string }): Promise<ToolResult> {
  try {
    return await withCredsRetry(async (clob) => {
      const orders = await clob.getOpenOrders(
        input.condition_id ? { market: input.condition_id } : undefined,
      );
      if (!orders?.length) {
        return { text: `No open orders.`, structured: { orders: [] } };
      }
      const lines = orders.map(
        (o) =>
          `  ${o.side} ${o.original_size} @ ${o.price} (${o.outcome ?? o.asset_id?.slice(0, 10)}) — ` +
          `filled ${o.size_matched ?? "0"} · ${o.order_type} · id ${o.id}`,
      );
      return {
        text: `Open orders (${orders.length}):\n${lines.join("\n")}\n\nCancel with action:"cancel" order_id:"…" (or all:true).`,
        structured: { orders },
      };
    });
  } catch (err) {
    return { text: await mapClobError(err), isError: true };
  }
}

export async function cancelOrdersAction(input: {
  order_id?: string;
  all?: boolean;
}): Promise<ToolResult> {
  if (!input.order_id && input.all !== true) {
    return { text: `Pass order_id:"…" or all:true.`, isError: true };
  }
  try {
    return await withCredsRetry(async (clob) => {
      const result = (
        input.all === true
          ? await clob.cancelAll()
          : await clob.cancelOrder({ orderID: input.order_id as string })
      ) as {
        canceled?: string[];
        not_canceled?: Record<string, string>;
      };
      // The CLOB reports per-order outcomes: {canceled:[...], not_canceled:{id:reason}}.
      // Don't claim success blindly — an order mid-settlement stays live and the
      // agent must know it still has exposure.
      const canceled = result?.canceled ?? [];
      const notCanceled = result?.not_canceled ?? {};
      const failedIds = Object.keys(notCanceled);
      if (failedIds.length) {
        const detail = failedIds.map((id) => `${id}: ${notCanceled[id]}`).join("; ");
        return {
          text:
            `⚠️ Cancelled ${canceled.length} order(s); ${failedIds.length} could NOT be cancelled ` +
            `(still live — you retain exposure): ${detail}`,
          structured: { canceled, notCanceled },
          isError: true,
        };
      }
      return {
        text:
          input.all === true
            ? `✅ Cancelled all open orders${canceled.length ? ` (${canceled.length})` : ""}.`
            : `✅ Cancelled order ${input.order_id}.`,
        structured: { result },
      };
    });
  } catch (err) {
    return { text: await mapClobError(err), isError: true };
  }
}
