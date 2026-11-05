/**
 * Solana MPP charge rail. Policy and credit facts are read from the complete
 * challenge before signing; the SDK builds the transaction and the seller submits it.
 * No environment variables, key files, or global fetch patches.
 */
import type { KeyPairSigner } from "@solana/kit";
import {
  assertSpendPolicyAllows,
  SpendPolicyError,
  type PayFetch,
  type SpendControl,
  type SpendRecord,
} from "@twzrd1111/clawrouter";
import {
  creditFromChallenge,
  guardPaid,
  isPaidResponse,
  markSigned,
  MppPaidNoCompletionError,
  paymentReference,
  rejectPaidNoCompletion,
} from "./mpp-paid-failure.js";
import { loadOptional, SOLANA_MPP_RANGE } from "./mpp-optional.js";

export const DEFAULT_SOLANA_USD_MINTS: ReadonlySet<string> = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);

type SolanaNetwork = "mainnet" | "devnet" | "localnet";
const CAIP2: Record<SolanaNetwork, string> = {
  mainnet: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  devnet: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  localnet: "solana:localnet",
};

export type SolanaMppFetchOptions = {
  signer: KeyPairSigner;
  rpcUrl: string;
  network: SolanaNetwork;
  spend?: SpendControl;
  usdMints?: Iterable<string>;
  /** Injectable transport; defaults to fetch. The SDK's RPC transport is separate. */
  fetch?: typeof fetch;
};

/** Official charge-method entry point. Tests replace only transaction construction. */
export const solanaChargeDeps = {
  load: () => loadOptional("@solana/mpp", SOLANA_MPP_RANGE, () => import("@solana/mpp/client")),
};

export async function createSolanaMppFetch(opts: SolanaMppFetchOptions): Promise<PayFetch> {
  const { charge, selectSolanaChargeChallengeFromResponse, resolveStablecoinMint } =
    await solanaChargeDeps.load();
  const base = opts.fetch ?? fetch;
  const usd = new Set([...DEFAULT_SOLANA_USD_MINTS, ...(opts.usdMints ?? [])]);
  const network = opts.network === "mainnet" ? "mainnet-beta" : opts.network;
  type Signed = { credential: string; payload: string; record?: SpendRecord };
  // Share construction of the same credential, including overlapping requests.
  const signedOnce = new Map<string, Promise<Signed>>();

  const payFetch: PayFetch = async (input, init) =>
    guardPaid(
      opts.spend,
      async () => {
        const request = new Request(input, init);
        const probe = await base(request.clone());
        if (probe.status !== 402) return probe;
        if (probe.redirected)
          throw new SpendPolicyError("Refusing a payment challenge reached through a redirect");
        const challenge = selectSolanaChargeChallengeFromResponse(probe);
        if (!challenge) return probe;
        const challengeNetwork = challenge.request.methodDetails.network ?? "mainnet";
        if (solanaNetworkId(challengeNetwork) !== CAIP2[opts.network]) {
          throw new SpendPolicyError(
            "Solana challenge network does not match the configured network",
          );
        }
        const credit = creditFromChallenge(challenge, opts.signer.address);
        if (!credit) throw new Error("challenge is missing amount or id");
        const quote = quoteFromSolanaChallenge(
          {
            request: {
              ...challenge.request,
              methodDetails: { ...challenge.request.methodDetails, network: challengeNetwork },
              currency:
                resolveStablecoinMint(challenge.request.currency, network) ??
                challenge.request.currency,
            },
          },
          usd,
        );
        const key = JSON.stringify([challenge.id, challenge.request]);
        let pending = signedOnce.get(key);
        if (!pending) {
          pending = (async (): Promise<Signed> => {
            const spend = opts.spend;
            if (spend && !quote.priceable && spend.hasAmountLimits()) {
              throw new SpendPolicyError(
                "MPP quote is in a mint ClawRouter cannot price; refusing to pay against a configured spend limit",
              );
            }
            const reservationId = spend ? assertSpendPolicyAllows(spend, quote) : undefined;
            let signed = false;
            let record: SpendRecord | undefined;
            let payload = "";
            try {
              const method = charge({
                signer: opts.signer,
                rpcUrl: opts.rpcUrl,
                expectedNetwork: challengeNetwork,
                broadcast: false,
                onProgress(event) {
                  if (event.type !== "signed") return;
                  signed = true;
                  payload = event.transaction;
                  if (spend && reservationId !== undefined) {
                    record = spend.settleReservation(reservationId, {
                      action: "mpp solana charge",
                    });
                  }
                  markSigned(payload, credit, record);
                },
              });
              const credential = await method.createCredential({ challenge });
              // Account for a compatible method which returns a credential without progress.
              if (!signed) {
                payload = credential;
                if (spend && reservationId !== undefined) {
                  record = spend.settleReservation(reservationId, { action: "mpp solana charge" });
                }
              }
              return { credential, payload, record };
            } catch (err) {
              if (signed) {
                throw new MppPaidNoCompletionError(
                  "Solana payment was signed but credential construction failed; refusing to sign again",
                  paymentReference(payload),
                  undefined,
                  { cause: err },
                );
              }
              if (!signed && spend && reservationId !== undefined)
                spend.releaseReservation(reservationId);
              throw err;
            }
          })();
          signedOnce.set(key, pending);
        }
        let result: Signed;
        try {
          result = await pending;
        } catch (err) {
          if (!(err instanceof MppPaidNoCompletionError) && signedOnce.get(key) === pending)
            signedOnce.delete(key);
          throw err;
        }
        markSigned(result.payload, credit, result.record);
        const headers = new Headers(request.headers);
        headers.set("authorization", result.credential);
        return base(new Request(request, { headers }));
      },
      opts.signer.address,
    );
  payFetch.enforcesSpend = opts.spend !== undefined;
  payFetch.deferStreamingHeaders = true;
  payFetch.supportsNativeStreaming = true;
  payFetch.onNoCompletion = rejectPaidNoCompletion;
  payFetch.isPaidResponse = isPaidResponse;
  return payFetch;
}

/** USDC on Solana devnet. Priced as 6-decimal USD, same as `DEFAULT_SOLANA_USD_MINTS`. */
export const SOLANA_DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

export type SolanaChargeChallenge = {
  id: string;
  realm?: string;
  method: string;
  intent: string;
  request: {
    amount?: unknown;
    currency?: unknown;
    recipient?: unknown;
    methodDetails?: { network?: unknown };
  };
};

/** Map a challenge network (name or CAIP-2) onto the id `allowedNetworks` stores. */
function solanaNetworkId(value: string): string {
  if (value === "devnet" || value === CAIP2.devnet) return CAIP2.devnet;
  if (value === "mainnet" || value === "mainnet-beta" || value === CAIP2.mainnet)
    return CAIP2.mainnet;
  if (value === "localnet" || value === CAIP2.localnet) return CAIP2.localnet;
  return value;
}

/** The quote a Solana charge challenge presents to spend control. `amount` stays unset if unpriceable. */
export function quoteFromSolanaChallenge(
  challenge: { request?: SolanaChargeChallenge["request"] },
  usdMints: ReadonlySet<string> = DEFAULT_SOLANA_USD_MINTS,
) {
  const req = challenge.request ?? {};
  const asset = typeof req.currency === "string" ? req.currency : undefined;
  const rawNetwork = req.methodDetails?.network;
  const priceable = asset !== undefined && usdMints.has(asset) && typeof req.amount === "string";
  return {
    payTo: typeof req.recipient === "string" ? req.recipient : undefined,
    network: typeof rawNetwork === "string" ? solanaNetworkId(rawNetwork) : undefined,
    asset,
    amount: priceable ? (req.amount as string) : undefined,
    priceable,
  };
}

/** Parse one `WWW-Authenticate: Payment` charge header. Throws if the header is not that shape. */
export function parseSolanaChargeHeader(header: string): SolanaChargeChallenge {
  const pick = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(header)?.[1];
  const id = pick("id");
  const realm = pick("realm");
  const method = pick("method");
  const intent = pick("intent");
  const requestB64 = pick("request");
  if (!id || !method || !intent || !requestB64) throw new Error("unparsed Solana MPP challenge");
  const parsed: unknown = JSON.parse(Buffer.from(requestB64, "base64url").toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("unparsed Solana MPP challenge");
  }
  const request = parsed as SolanaChargeChallenge["request"];
  return { id, realm, method, intent, request };
}

export type SolanaFixtureFetchOptions = {
  /** Actual payer account, distinct from the seller recipient. */
  payer: string;
  /** When set, the challenge is checked and reserved before `sign` runs. */
  spend?: SpendControl;
  /** Extra mints to treat as 6-decimal USD. */
  usdMints?: Iterable<string>;
  /**
   * Produce the signed payload for this challenge. No key file and no RPC: the caller supplies it.
   * Called at most once per challenge quote; a later call resends the same credential.
   */
  sign: (challenge: SolanaChargeChallenge) => string | Promise<string>;
  /** Seller. Tests pass a stub; this helper never calls `globalThis.fetch`. */
  fetch: typeof fetch;
};

/**
 * Solana charge completion with a caller-supplied fixture signer.
 *
 * The SDK may need an RPC to build a transaction. This runs the same spend checks (price, network, asset,
 * payee, reserve, then settle) and attaches one cached `Payment` credential via `opts.fetch`.
 */
export function createSolanaFixtureFetch(opts: SolanaFixtureFetchOptions): PayFetch {
  const usd = new Set([...DEFAULT_SOLANA_USD_MINTS, ...(opts.usdMints ?? [])]);
  const signedOnce = new Map<string, { credential: string; record?: SpendRecord }>();
  const reuseKey = (challenge: SolanaChargeChallenge) => {
    const quote = quoteFromSolanaChallenge(challenge, usd);
    return `${challenge.id}|${quote.amount ?? ""}|${quote.asset ?? ""}|${quote.payTo ?? ""}|${quote.network ?? ""}`;
  };

  const credentialFor = async (challenge: SolanaChargeChallenge): Promise<string> => {
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
      const quote = quoteFromSolanaChallenge(challenge, usd);
      if (!quote.priceable && spend.hasAmountLimits()) {
        throw new SpendPolicyError(
          `MPP quote is in a mint ClawRouter cannot price (${quote.asset ?? "none"}); refusing to pay against a configured spend limit`,
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
        ? spend.settleReservation(reservationId, { action: "mpp solana charge" })
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
        let challenge: SolanaChargeChallenge;
        try {
          if (!header) return challengeRes;
          challenge = parseSolanaChargeHeader(header);
        } catch {
          return challengeRes;
        }
        if (challenge.method !== "solana" || challenge.intent !== "charge") return challengeRes;
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
