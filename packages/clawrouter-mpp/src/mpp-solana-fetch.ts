/**
 * MPP (Machine Payments Protocol) Solana charge upstream fetch — SPIKE.
 *
 * The Solana counterpart of `mpp-fetch.ts`: pays an HTTP 402 `WWW-Authenticate: Payment` challenge
 * (method `solana`, intent `charge`) with `@solana/pay-kit`'s client and retries. Same `PayFetch`
 * signature as every other rail.
 *
 * pay-kit builds its mppx client internally, so there is no `createCredential` seam like the Tempo rail
 * has. Two hooks it does expose are used instead, both called before anything is signed:
 *  - `permissions.authorize(candidate)`: called synchronously per payment candidate; a custom object
 *    here replaces pay-kit's default policy. This is where the amount, network and asset are checked
 *    against ClawRouter's `SpendControl` and the budget is reserved. A non-PermissionDenied throw
 *    propagates out of `client.fetch` (verified against pay-kit 0.13.1).
 *  - `onProgress({ type: "challenge", recipient })`: fires before the transaction is built, and is the
 *    only place the payee is visible, so payee lists are enforced here.
 * The reservation becomes spend on `signed` (the credential carries a signed transaction the server
 * will submit) and is released if the call ends without one.
 *
 * Reads no env vars and no key files: the signer is supplied by the caller.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { PaymentCandidate, SolanaNetwork } from "@solana/pay-kit/client";
import type { KeyPairSigner } from "@solana/kit";
import { guardPaid, markSigned } from "./mpp-paid-failure.js";
import { loadOptional, PAY_KIT_RANGE } from "./mpp-optional.js";
import {
  assertSpendPolicyAllows,
  SpendPolicyError,
  type PayFetch,
  type SpendControl,
} from "@blockrun/clawrouter";

/**
 * 6-decimal USD stablecoin mints priced here (from pay-kit 0.13.1's own tables). Any other mint cannot be
 * priced, so it is refused while amount limits are set. Pass `usdMints` to add e.g. a localnet test mint.
 */
export const DEFAULT_SOLANA_USD_MINTS: ReadonlySet<string> = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC mainnet
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", // USDC devnet
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT mainnet
]);

/** CAIP-2 ids the wallet rail and `allowedNetworks` use. localnet has no genesis constant. */
const CAIP2: Record<SolanaNetwork, string> = {
  mainnet: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  devnet: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  localnet: "solana:localnet",
};

export type SolanaMppFetchOptions = {
  signer: KeyPairSigner;
  rpcUrl: string;
  network: SolanaNetwork;
  /** When set, every payment is checked against these limits before it is signed. */
  spend?: SpendControl;
  /** Extra mints to treat as 6-decimal USD (e.g. a localnet test mint). */
  usdMints?: Iterable<string>;
};

type Call = {
  reservationId?: string;
  settled: boolean;
  /** The payee-aware check ran (the `challenge` event); signing without it is refused. */
  payeeChecked: boolean;
  quote?: { network: string; asset: string; amount?: string; priceable: boolean };
};

export async function createSolanaMppFetch(opts: SolanaMppFetchOptions): Promise<PayFetch> {
  const { spend, network } = opts;
  const usd = new Set([...DEFAULT_SOLANA_USD_MINTS, ...(opts.usdMints ?? [])]);
  const calls = new AsyncLocalStorage<Call>();

  // pay-kit's `ClientPermissions` has private fields, so a duck-typed object stands in for it (the
  // client only ever calls `authorize`). Without `spend`, pay-kit's own default policy stays in force.
  const permissions = spend
    ? {
        authorize(candidate: PaymentCandidate) {
          const call = calls.getStore();
          if (!call)
            throw new SpendPolicyError("Solana MPP payment attempted outside a guarded call");
          const priceable = usd.has(candidate.mint);
          if (!priceable && spend.hasAmountLimits()) {
            throw new SpendPolicyError(
              `MPP quote is in a mint ClawRouter cannot price (${candidate.mint}); refusing to pay against a configured spend limit`,
            );
          }
          const amount = priceable ? candidate.amount.toString() : undefined;
          call.quote = {
            network: CAIP2[candidate.network],
            asset: candidate.mint,
            amount,
            priceable,
          };
          // payTo is not in the candidate, so payee lists are deferred to the `challenge` progress event
          // below (which runs before the transaction is built). `signing` refuses if that never happened.
          call.reservationId = assertSpendPolicyAllows(spend, {
            network: call.quote.network,
            asset: candidate.mint,
            amount,
            payeeDeferred: true,
          });
          return { maxAmountAtomic: candidate.amount };
        },
      }
    : undefined;

  // `@solana/pay-kit` is an optional peer dependency (see mpp-optional.ts).
  const { PayKitClient } = await loadOptional(
    "@solana/pay-kit",
    PAY_KIT_RANGE,
    () => import("@solana/pay-kit/client"),
  );
  const client = await PayKitClient.builder()
    .signer(opts.signer)
    .rpcUrl(opts.rpcUrl)
    .network(network)
    .accept(["mpp"])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .permissions(permissions as any)
    .onProgress((event) => {
      const call = calls.getStore();
      const e = event as { type?: string; recipient?: string; transaction?: string };
      if (!call) return;
      if (!spend) {
        // No limits: nothing to reserve, but a signed payment still has to be tracked (mpp-paid-failure.ts).
        if (e.type === "signed" && typeof e.transaction === "string") markSigned(e.transaction);
        return;
      }
      if (e.type === "challenge" && call.quote) {
        // Payee lists only: cost 0, because this payment's own amount is already reserved and counting
        // it again would block a payment that fits. Throws here, before the transaction is built, abort it.
        const result = spend.check(0, {
          payTo: e.recipient,
          network: call.quote.network,
          asset: call.quote.asset,
        });
        if (!result.allowed) {
          throw new SpendPolicyError(result.reason ?? "blocked by spend policy", {
            blockedBy: result.blockedBy,
            blockedByPolicy: result.blockedByPolicy,
          });
        }
        call.payeeChecked = true;
      } else if (e.type === "signing") {
        if (!call.payeeChecked) {
          throw new SpendPolicyError("payee was never checked before signing; refusing to sign");
        }
      } else if (e.type === "signed" || e.type === "paid") {
        let record;
        if (call.reservationId !== undefined && !call.settled) {
          call.settled = true;
          record = spend.settleReservation(call.reservationId, { action: "mpp solana charge" });
        }
        if (e.type === "signed" && typeof e.transaction === "string")
          markSigned(e.transaction, record);
      }
    })
    .build();

  const payFetch: PayFetch = async (input, init) => {
    const call: Call = { settled: false, payeeChecked: false };
    try {
      // After a transaction is signed, a failed or non-2xx result ends in MppPaidNoCompletionError.
      return await guardPaid(spend, () => calls.run(call, () => client.fetch(input, init, "mpp")));
    } finally {
      // Never signed (denied, failed, or no payable option): free the held budget.
      if (spend && call.reservationId !== undefined && !call.settled) {
        spend.releaseReservation(call.reservationId);
      }
    }
  };
  payFetch.enforcesSpend = spend !== undefined;
  return payFetch;
}
