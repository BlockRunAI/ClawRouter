/**
 * Failure AFTER an MPP payment was signed (buyer side).
 *
 * MPP charge settles before the upstream runs the model, so a seller error after the credential
 * went out means the buyer may have paid and got nothing. Three rules, enforced here for both rails:
 *  1. Never pay that request again: the call ends with `MppPaidNoCompletionError`, which the proxy
 *     treats like a payment in doubt (no retry, no fallback model).
 *  2. The spend ledger keeps the spend (a signed credential counts) and carries a note saying it
 *     returned no completion, so the loss is visible in `spending.json` and not only in a log.
 *  3. The error carries a reference for the payment, so a dispute has something to point at.
 *
 * "Signed" is not "settled": on Solana the seller submits the transaction, so a seller that dies
 * first costs nothing. The wording says "signed and sent" and the reference lets a human check.
 * `guardPaid` returns when streaming response headers arrive. If the body later errors or ends without
 * a completion, the host must call `rejectPaidNoCompletion` with that original Response object.
 */
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  PAYMENT_SETTLED_NO_COMPLETION,
  SpendPolicyError,
  type SpendControl,
  type SpendRecord,
} from "@twzrd1111/clawrouter";
import { CreditLedger, type CreditEntry } from "./credit-record.js";

export class MppPaidNoCompletionError extends Error {
  readonly reference: string;
  readonly status?: number;
  constructor(message: string, reference: string, status?: number, options?: { cause?: unknown }) {
    super(message, options);
    // The host proxy matches this name (see PayFetch in @twzrd1111/clawrouter), so it answers 502 and stops.
    this.name = PAYMENT_SETTLED_NO_COMPLETION;
    this.reference = reference;
    this.status = status;
  }
}

/**
 * Record one credit for a paid call that returned no completion.
 * A retry of the same payer and challenge returns the first row.
 * `sign`, when passed, is never called.
 */
export function creditPaidNoCompletion(
  ledger: CreditLedger,
  err: MppPaidNoCompletionError,
  fields: CreditEntry,
  hooks?: { sign?: () => Promise<unknown> },
): CreditEntry {
  if (!(err instanceof MppPaidNoCompletionError)) {
    throw new TypeError("credit requires MppPaidNoCompletionError");
  }
  void hooks;
  return ledger.recordOnce(fields);
}

export type PaidCall = {
  /** The paying account supplied to the rail, never the challenge recipient. */
  payer: string;
  /** A credential or transaction was produced for this call. */
  signed: boolean;
  /** Stable, non-secret handle for the payment (hash of what was sent), for disputes. */
  reference?: string;
  /** The ledger entry written when the payment was signed, if limits made one. */
  record?: SpendRecord;
  /** Payer, amount, and challenge known before the model runs. Reason is filled on failure. */
  credit?: Pick<CreditEntry, "payer" | "amount" | "challengeId">;
};

const credits = new CreditLedger();

/** Amount and id from the challenge, payer from the supplied account. No signer. */
export function creditFromChallenge(
  challenge: {
    id: string;
    request?: { amount?: unknown; recipient?: unknown } | Record<string, unknown>;
  },
  payer: string,
): CreditFacts | undefined {
  const request = challenge.request;
  const amount = request && "amount" in request ? request.amount : undefined;
  if (typeof amount !== "string" || !/^\d+$/.test(amount) || !payer || !challenge.id)
    return undefined;
  return { payer, amount, challengeId: challenge.id };
}

/** Rows written by `fail` when a signed call returns no completion. */
export function readCredits(ledger: CreditLedger = credits): readonly CreditEntry[] {
  return ledger.read();
}

const storage = new AsyncLocalStorage<PaidCall>();
const paidResponses = new WeakMap<Response, { spend: SpendControl | undefined; call: PaidCall }>();

/** Called by the host when a successful response or its body contains no usable completion. */
export function rejectPaidNoCompletion(response: Response, reason: string): void {
  const paid = paidResponses.get(response);
  if (paid) throw fail(paid.spend, paid.call, response.status, reason);
}

/** Whether this exact successful response belongs to a signed MPP payment. */
export function isPaidResponse(response: Response): boolean {
  return paidResponses.has(response);
}

/** The current call's payment state; undefined outside `guardPaid`. */
export function currentPaidCall(): PaidCall | undefined {
  return storage.getStore();
}

/** Short hash of the signed payload: identifies the payment without exposing it. */
export function paymentReference(payload: string): string {
  return `mpp-${createHash("sha256").update(payload).digest("hex").slice(0, 16)}`;
}

export type CreditFacts = Pick<CreditEntry, "payer" | "amount" | "challengeId">;

/** Record that this call produced a signed payment. Facts are required. First one wins. */
export function markSigned(
  payload: string,
  facts: CreditFacts | undefined,
  record?: SpendRecord,
): void {
  const call = storage.getStore();
  if (!call || call.signed) return;
  call.signed = true;
  call.reference = paymentReference(payload);
  call.record = record;
  call.credit = facts;
}

/**
 * Run one paid call. If it ends without a completion after a payment was signed, annotate the
 * ledger and throw `MppPaidNoCompletionError`; otherwise behave exactly like `run()`.
 * Local refusals (`SpendPolicyError`) and failures before signing pass through untouched.
 */
export async function guardPaid(
  spend: SpendControl | undefined,
  run: () => Promise<Response>,
  payer: string,
): Promise<Response> {
  const call: PaidCall = { signed: false, payer };
  let response: Response;
  try {
    response = await storage.run(call, run);
  } catch (err) {
    if (!call.signed || err instanceof SpendPolicyError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw fail(spend, call, undefined, detail, err);
  }
  if (call.signed && response.status >= 400) {
    throw fail(spend, call, response.status, await boundedSnippet(response));
  }
  if (call.signed) paidResponses.set(response, { spend, call });
  return response;
}

const SNIPPET_CHARS = 200;
const SNIPPET_MAX_BYTES = 1024;
const SNIPPET_TIMEOUT_MS = 1000;

/**
 * At most `SNIPPET_CHARS` characters of an error body, read from a clone with a byte cap and a timeout,
 * so a huge or never-ending body cannot delay the ledger note or the payment-in-doubt error.
 * Anything unreadable yields "": the status alone is enough.
 */
export async function boundedSnippet(
  response: Response,
  timeoutMs: number = SNIPPET_TIMEOUT_MS,
): Promise<string> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const body = response.clone().body;
    if (!body) return "";
    reader = body.getReader();
    const r = reader;
    const chunks: Uint8Array[] = [];
    let total = 0;
    const read = (async () => {
      while (total < SNIPPET_MAX_BYTES) {
        const { done, value } = await r.read();
        if (done || !value) break;
        chunks.push(value);
        total += value.byteLength;
      }
    })();
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    await Promise.race([read, timeout]);
    const bytes = new Uint8Array(Math.min(total, SNIPPET_MAX_BYTES));
    let at = 0;
    for (const c of chunks) {
      const n = Math.min(c.byteLength, bytes.byteLength - at);
      bytes.set(c.subarray(0, n), at);
      at += n;
    }
    return new TextDecoder().decode(bytes).slice(0, SNIPPET_CHARS);
  } catch {
    return "";
  } finally {
    if (timer) clearTimeout(timer);
    reader?.cancel().catch(() => {});
  }
}

function fail(
  spend: SpendControl | undefined,
  call: PaidCall,
  status: number | undefined,
  detail: string,
  cause?: unknown,
): MppPaidNoCompletionError {
  const reference = call.reference ?? "mpp-unknown";
  const why = status !== undefined ? `HTTP ${status}` : "request failed";
  if (spend && call.record) {
    spend.annotateRecord(call.record, `signed, no completion (${why}) ref ${reference}`);
  }
  const error = new MppPaidNoCompletionError(
    `MPP payment was signed and sent but no completion came back (${why}${detail ? `: ${detail}` : ""}). ` +
      `Not retrying, to avoid paying twice. Payment reference: ${reference}`,
    reference,
    status,
    { cause },
  );
  if (call.credit) {
    creditPaidNoCompletion(credits, error, { ...call.credit, reason: why });
  }
  return error;
}
