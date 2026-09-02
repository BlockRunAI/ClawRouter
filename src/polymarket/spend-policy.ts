// src/polymarket/spend-policy.ts
//
// Every Polymarket path that signs something that moves the user's capital —
// fund (EIP-3009 on Base), buy/sell (CLOB order on Polygon), withdraw (pUSD →
// USDC on Base) — consults the SAME spend policy the proxy enforces on x402
// payments, BEFORE the signer runs. Until this existed the operator's
// allow/deny lists in ~/.openclaw/blockrun/spending.json governed LLM calls
// only; the agent could still route capital to any counterparty from here.
//
// Refusal is the proxy's SpendPolicyError, thrown before the signing function
// is ever called. Amount windows apply too, so signed notional is recorded
// against the shared ledger (fail-closed when an amount cannot be parsed and
// a cap is configured — see assertSpendPolicyAllows).
//
// DELIBERATELY NOT GATED: the one-time approval batch in setup.ts
// (`sendWalletBatch(buildApprovalCalls(...))`). It signs ERC-20 `approve` and
// ERC-1155 `setApprovalForAll`, which grant authority rather than move capital,
// and gating it would be actively harmful: the spenders are Polymarket's own
// exchange contracts, so an operator running a tight `allowedPayees` list that
// (correctly) names only their payout addresses would have setup refused. It is
// already bounded — targets come from `readApprovals()`, never from agent input,
// and the batch is `confirm`-gated behind an explicit preview.
import {
  assertSpendPolicyAllows,
  getSharedSpendControl,
  SpendControl,
  type QuotedRequirements,
} from "../spend-control.js";

export interface PolymarketSpendDeps {
  /** Default: the process-wide policy at ~/.openclaw/blockrun/spending.json. Inject in tests. */
  spendControl?: SpendControl;
}

/** One instance per process so session windows and reservations span tool calls, as in the proxy. */
function resolveSpendControl(deps?: PolymarketSpendDeps): SpendControl {
  return deps?.spendControl ?? getSharedSpendControl();
}

/**
 * USD → canonical micro-USDC string. Rounds UP so float slack can never clear
 * a cap; NaN/Infinity/negative produce a non-canonical string, which
 * assertSpendPolicyAllows refuses when any amount limit is configured.
 */
export function usdToMicros(usd: number): string {
  return String(Math.ceil(usd * 1_000_000));
}

/**
 * Run `sign` only if policy allows the counterparty and amount. Throws
 * SpendPolicyError before `sign` is called when refused; settles the
 * reservation once `sign` resolves (signed = spend, as in the x402 hook) and
 * releases it if `sign` throws so a failed submit does not consume budget.
 */
export async function signUnderSpendPolicy<T>(
  deps: PolymarketSpendDeps | undefined,
  quote: QuotedRequirements,
  action: string,
  sign: () => Promise<T>,
): Promise<T> {
  const control = resolveSpendControl(deps);
  const reservation = assertSpendPolicyAllows(control, quote);
  try {
    const signed = await sign();
    if (reservation !== undefined) control.settleReservation(reservation, { action });
    return signed;
  } catch (err) {
    if (reservation !== undefined) control.releaseReservation(reservation);
    throw err;
  }
}
