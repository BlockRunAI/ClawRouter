/**
 * MPP (Machine Payments Protocol) upstream fetch — SPIKE.
 *
 * A third way to pay an upstream, beside the x402 wallet rail and the BlockRun API key: answer an
 * HTTP 402 `WWW-Authenticate: Payment` challenge (Tempo charge) with the `mppx` client and retry.
 * Same signature as the other rails' fetch, so the proxy handlers stay unaware of how a call is paid.
 *
 * Spend controls (opt-in via `opts.spend`) follow the wallet rail's signing hook, not the API-key
 * wrapper: the price is read from the QUOTED challenge before anything is signed, the policy is
 * fail-closed, and a signed credential counts as spend even if the request then fails (MPP settles
 * before the upstream responds); that failure is surfaced as MppPaidNoCompletionError (mpp-paid-failure.ts). The check lives in the method's `createCredential` (see `guardMethod`)
 * because mppx swallows errors thrown from its event handlers.
 *
 * The account is supplied by the caller; this module reads no env vars and no key files.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Mppx as MppxClient } from "mppx/client";
import type { Account } from "viem";
import {
  assertSpendPolicyAllows,
  SpendPolicyError,
  type PayFetch,
  type SpendControl,
  type SpendRecord,
} from "@twzrd1111/clawrouter";
import {
  creditFromChallenge,
  currentPaidCall,
  guardPaid,
  isPaidResponse,
  markSigned,
  rejectPaidNoCompletion,
} from "./mpp-paid-failure.js";
import { loadOptional, MPPX_RANGE } from "./mpp-optional.js";

export type { PayFetch };

/**
 * Tempo TIP-20 USD stablecoins priced here, lower-case, all 6 decimals (the challenge carries no
 * `decimals`). Any other asset cannot be priced, so it is refused while amount limits are set.
 *  - 0x20c0…0000   pathUSD (Moderato testnet 42431, also on mainnet 4217)
 *  - 0x20c0…b9537d11c60e8b50   fee token a Tempo-run MPP proxy quoted on mainnet 4217 (2026-11-03)
 *  - 0x20c0…f37de3740adec032   charge currency on that same OpenRouter challenge (6 decimals, 750 = 0.00075 USD)
 */
export const DEFAULT_TEMPO_USD_ASSETS: ReadonlySet<string> = new Set([
  "0x20c0000000000000000000000000000000000000",
  "0x20c000000000000000000000b9537d11c60e8b50",
  "0x20c000000000000000000000f37de3740adec032",
]);

export type MppFetchOptions = {
  /** When set, every challenge is checked against these limits before a credential is created. */
  spend?: SpendControl;
  /** Override the assets treated as 6-decimal USD (lower-case addresses). */
  usdAssets?: ReadonlySet<string>;
};

type ChallengeLike = { id: string; request?: Record<string, unknown> };

/** The quote as the spend-control layer understands it. `amount` stays undefined if unpriceable. */
export function quoteFromChallenge(
  challenge: ChallengeLike,
  usdAssets: ReadonlySet<string> = DEFAULT_TEMPO_USD_ASSETS,
) {
  const req = (challenge.request ?? {}) as {
    amount?: unknown;
    currency?: unknown;
    recipient?: unknown;
    methodDetails?: { chainId?: unknown };
  };
  const asset = typeof req.currency === "string" ? req.currency : undefined;
  const chainId = req.methodDetails?.chainId;
  const priceable =
    asset !== undefined && usdAssets.has(asset.toLowerCase()) && typeof req.amount === "string";
  return {
    payTo: typeof req.recipient === "string" ? req.recipient : undefined,
    network: typeof chainId === "number" ? `eip155:${chainId}` : undefined,
    asset,
    amount: priceable ? (req.amount as string) : undefined,
    priceable,
  };
}

// mppx method options are generic over the method's schema; the guard only reads `challenge`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MethodLike = { createCredential: (options: any) => Promise<string> };

/**
 * Put the spend policy in the signing path of an mppx method.
 *
 * mppx's `challenge.received` event is an observer: it runs each handler inside try/catch and goes on to
 * sign, so a handler cannot veto a payment by throwing (verified against mppx 0.17.0 and live, 2026-11-03).
 * `createCredential` is the one place a throw really aborts: reserve (fail-closed) -> sign -> settle,
 * and release the reservation if signing fails. A signed credential counts as spend even if the request
 * then fails, because MPP settles before the upstream responds.
 */
export function guardMethod<M extends MethodLike>(
  method: M,
  control: SpendControl | undefined,
  usdAssets: ReadonlySet<string> = DEFAULT_TEMPO_USD_ASSETS,
): M {
  // One signed credential per challenge quote. A second call resends it and does not reserve or sign again.
  const signedOnce = new Map<
    string,
    { credential: string; record?: ReturnType<SpendControl["settleReservation"]> }
  >();
  const reuseKey = (challenge: ChallengeLike) => {
    const req = (challenge.request ?? {}) as {
      amount?: unknown;
      currency?: unknown;
      recipient?: unknown;
      methodDetails?: { chainId?: unknown };
    };
    const currency = typeof req.currency === "string" ? req.currency.toLowerCase() : "";
    const recipient = typeof req.recipient === "string" ? req.recipient.toLowerCase() : "";
    const chainId = req.methodDetails?.chainId;
    return `${challenge.id}|${req.amount ?? ""}|${currency}|${recipient}|${chainId ?? ""}`;
  };
  const guarded: MethodLike = {
    createCredential: async (options: { challenge: ChallengeLike }) => {
      const cached = signedOnce.get(reuseKey(options.challenge));
      const call = currentPaidCall();
      const credit = creditFromChallenge(options.challenge, call?.payer ?? "");
      if (call && !credit)
        throw new Error("challenge is missing amount or id, or payer is missing");
      if (cached) {
        markSigned(cached.credential, credit, cached.record);
        return cached.credential;
      }
      let reservationId: string | undefined;
      if (control) {
        const quote = quoteFromChallenge(options.challenge, usdAssets);
        if (!quote.priceable && control.hasAmountLimits()) {
          // An amount we cannot convert to USD cannot be compared to a configured cap.
          throw new SpendPolicyError(
            `MPP quote is in an asset or shape ClawRouter cannot price (${quote.asset ?? "none"}); refusing to pay against a configured spend limit`,
          );
        }
        reservationId = assertSpendPolicyAllows(control, quote);
      }
      let credential: string;
      try {
        credential = await method.createCredential(options);
      } catch (err) {
        if (control && reservationId !== undefined) control.releaseReservation(reservationId);
        throw err;
      }
      const record =
        control && reservationId !== undefined
          ? control.settleReservation(reservationId, { action: "mpp tempo charge" })
          : undefined;
      signedOnce.set(reuseKey(options.challenge), { credential, record });
      markSigned(credential, credit, record);
      return credential;
    },
  };
  return { ...method, ...guarded } as M;
}

export function createMppFetch(
  account: Account,
  base: typeof fetch = fetch,
  opts: MppFetchOptions = {},
): PayFetch {
  // Remember the last 402 the upstream sent. mppx throws "No method found for challenges" when a 402
  // offers nothing this client can pay (e.g. a non-MPP gateway); callers expect to see that 402, not
  // an exception, so the proxy can classify it as a payment error like the other rails do.
  // Kept per call (AsyncLocalStorage), not per fetch instance: concurrent requests share this fetch.
  const calls = new AsyncLocalStorage<{ last402?: Response }>();
  const recording: typeof fetch = async (input, init) => {
    const res = await base(input, init);
    const call = calls.getStore();
    if (call) call.last402 = res.status === 402 ? res.clone() : undefined;
    return res;
  };
  // polyfill:false keeps globalThis.fetch untouched: only calls routed through this wrapper can pay.
  // `mppx` is an optional peer dependency, loaded on the first paid call (see mpp-optional.ts).
  const { spend, usdAssets } = opts;
  let mppxPromise: Promise<ReturnType<typeof MppxClient.create>> | undefined;
  const getMppx = () =>
    (mppxPromise ??= loadOptional("mppx", MPPX_RANGE, () => import("mppx/client")).then(
      ({ Mppx, tempo }) =>
        Mppx.create({
          methods: tempo({ account }).map((m) => guardMethod(m, spend, usdAssets)),
          polyfill: false,
          fetch: recording,
        }),
    ));

  const payFetch: PayFetch = async (input, init) => {
    const call: { last402?: Response } = {};
    const mppx = await getMppx();
    try {
      // After a credential is signed, a failed or non-2xx result ends in MppPaidNoCompletionError.
      return await calls.run(call, () =>
        guardPaid(spend, () => mppx.fetch(input, init), account.address),
      );
    } catch (e) {
      if (call.last402 && /No method found for challenges/.test((e as Error).message)) {
        return call.last402;
      }
      throw e;
    }
  };
  payFetch.enforcesSpend = opts.spend !== undefined;
  payFetch.deferStreamingHeaders = true;
  payFetch.supportsNativeStreaming = true;
  payFetch.onNoCompletion = rejectPaidNoCompletion;
  payFetch.isPaidResponse = isPaidResponse;
  return payFetch;
}

export type TempoChargeChallenge = {
  id: string;
  realm?: string;
  method: string;
  intent: string;
  request: {
    amount?: string;
    currency?: string;
    recipient?: string;
    methodDetails?: { chainId?: number };
  };
};

/** Parse one `WWW-Authenticate: Payment` Tempo charge header. Throws if the header is not that shape. */
export function parseTempoChargeHeader(header: string): TempoChargeChallenge {
  const pick = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(header)?.[1];
  const id = pick("id");
  const realm = pick("realm");
  const method = pick("method");
  const intent = pick("intent");
  const requestB64 = pick("request");
  if (!id || !method || !intent || !requestB64) throw new Error("unparsed Tempo MPP challenge");
  const parsed: unknown = JSON.parse(Buffer.from(requestB64, "base64url").toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("unparsed Tempo MPP challenge");
  }
  return { id, realm, method, intent, request: parsed as TempoChargeChallenge["request"] };
}

export type TempoFixtureFetchOptions = {
  /** Actual payer identity supplied by the caller, distinct from the seller recipient. */
  payer: string;
  /** When set, the challenge is checked and reserved before `sign` runs. */
  spend?: SpendControl;
  /** Extra TIP-20 assets to treat as 6-decimal USD. */
  usdAssets?: Iterable<string>;
  /**
   * Produce the signed payload for this challenge. No key file and no network: the caller supplies it.
   * Called at most once per challenge quote; a later call resends the same credential.
   */
  sign: (challenge: TempoChargeChallenge) => string | Promise<string>;
  /** Seller. Tests pass a stub; this helper never calls `globalThis.fetch`. */
  fetch: typeof fetch;
};

/**
 * Tempo charge completion without mppx.
 *
 * `createMppFetch` loads mppx and signs with a viem account. This runs the same spend checks
 * (price, network, asset, payee, reserve, then settle) and attaches one cached `Payment`
 * credential via `opts.fetch`.
 */
export function createTempoFixtureFetch(opts: TempoFixtureFetchOptions): PayFetch {
  const usd = new Set(
    [...DEFAULT_TEMPO_USD_ASSETS, ...(opts.usdAssets ?? [])].map((a) => a.toLowerCase()),
  );
  const signedOnce = new Map<string, { credential: string; record?: SpendRecord }>();
  const reuseKey = (challenge: TempoChargeChallenge) => {
    const quote = quoteFromChallenge(challenge, usd);
    return `${challenge.id}|${quote.amount ?? ""}|${quote.asset ?? ""}|${quote.payTo ?? ""}|${quote.network ?? ""}`;
  };

  const credentialFor = async (challenge: TempoChargeChallenge): Promise<string> => {
    const cached = signedOnce.get(reuseKey(challenge));
    const credit = creditFromChallenge(challenge, opts.payer);
    if (!credit) throw new Error("challenge is missing payer, amount, or id");
    if (cached) {
      markSigned(cached.credential, credit, cached.record);
      return cached.credential;
    }
    const { spend } = opts;
    let reservationId: string | undefined;
    if (spend) {
      const quote = quoteFromChallenge(challenge, usd);
      if (!quote.priceable && spend.hasAmountLimits()) {
        throw new SpendPolicyError(
          `MPP quote is in an asset or shape ClawRouter cannot price (${quote.asset ?? "none"}); refusing to pay against a configured spend limit`,
        );
      }
      reservationId = assertSpendPolicyAllows(spend, {
        payTo: quote.payTo,
        network: quote.network,
        asset: quote.asset,
        amount: quote.amount,
      });
    }
    let payload: string;
    try {
      payload = await opts.sign(challenge);
    } catch (err) {
      if (spend && reservationId !== undefined) spend.releaseReservation(reservationId);
      throw err;
    }
    const credential = payload.startsWith("Payment ") ? payload : `Payment ${payload}`;
    const record =
      spend && reservationId !== undefined
        ? spend.settleReservation(reservationId, { action: "mpp tempo charge" })
        : undefined;
    signedOnce.set(reuseKey(challenge), { credential, record });
    markSigned(credential, credit, record);
    return credential;
  };

  const payFetch: PayFetch = async (input, init) =>
    guardPaid(
      opts.spend,
      async () => {
        const challengeRes = await opts.fetch(input, init);
        if (challengeRes.status !== 402) return challengeRes;
        const header = challengeRes.headers.get("www-authenticate");
        let challenge: TempoChargeChallenge;
        try {
          if (!header) return challengeRes;
          challenge = parseTempoChargeHeader(header);
        } catch {
          return challengeRes;
        }
        if (challenge.method !== "tempo" || challenge.intent !== "charge") return challengeRes;
        const credential = await credentialFor(challenge);
        const headers = new Headers(init?.headers);
        headers.set("authorization", credential);
        return opts.fetch(input, { ...init, headers });
      },
      opts.payer,
    );
  payFetch.enforcesSpend = opts.spend !== undefined;
  payFetch.deferStreamingHeaders = true;
  payFetch.supportsNativeStreaming = true;
  payFetch.onNoCompletion = rejectPaidNoCompletion;
  payFetch.isPaidResponse = isPaidResponse;
  return payFetch;
}
