/**
 * Per-request accounting for the `maxCostPerRun` session cap.
 *
 * The strict cap used to compare `recorded spend + this request's estimate`
 * with the limit, and record spend only after a successful upstream response.
 * Two ways past it followed (EmberTail report ET-CLAWROUTER-20261010):
 *
 *   - concurrency: N requests admitted at once all saw the same recorded
 *     spend, because nothing was reserved for requests still in flight —
 *     three concurrent $0.008 calls settled $0.024 against a $0.012 cap;
 *   - a paid failure: a payment that settled but whose response came back as
 *     a 502 was never recorded, so the proxy's own retry signed a second,
 *     fresh authorization — $0.016 against $0.012.
 *
 * The fix mirrors the wallet-level SpendControl, which contained both:
 *
 *   1. Admission reserves. `admit()` checks `spent + held by other in-flight
 *      requests + this estimate` and, in the same synchronous step, holds the
 *      estimate. A concurrent request sees the hold.
 *   2. Signing is spending. A signed payment is recorded against the session
 *      the moment it is created, whatever the response turns out to be:
 *      "never arrived" and "settled, response lost" look identical from here,
 *      so it counts. Only a 402 answer to the paid request — the gateway
 *      declining the payment, so nothing settled — takes it back (`voidLastSigned`).
 *   3. Every signature is re-checked. In strict mode `coverPayment()` runs
 *      before each payment is created (the retry, the fallback, the pre-auth),
 *      against the quoted amount, so a retry after a paid failure cannot sign
 *      past the cap.
 *
 * On a rail with no signature (the API key) there is nothing to sign, so a
 * successful attempt records the local estimate instead, as before.
 */

import type { SessionStore } from "./session.js";
import { SpendPolicyError } from "./spend-control.js";

/** Parse a canonical decimal micro-USDC string. Anything else is undefined. */
export function parseMicros(raw: string | undefined): bigint | undefined {
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  return BigInt(raw);
}

/** USD (as configured) to USDC micros. */
export function usdToMicros(usd: number): bigint {
  return BigInt(Math.round(usd * 1_000_000));
}

export function microsToUsd(micros: bigint): number {
  return Number(micros) / 1_000_000;
}

export type StrictAdmission =
  | { admitted: true; spend: SessionSpend }
  | { admitted: false; spentMicros: bigint; heldMicros: bigint; estimateMicros: bigint };

/**
 * One request's share of a session's budget.
 */
export class SessionSpend {
  /** Budget this request still holds against the session (strict mode only). */
  private heldMicros: bigint;
  /** Sum of payments signed by this request that still count. */
  private signedMicros = 0n;
  /** Each signature this request made, in order, at the amount that still counts. */
  private readonly signedLog: bigint[] = [];
  private released = false;

  private constructor(
    private readonly store: SessionStore,
    private readonly sessionId: string,
    /** Strict cap in micros; undefined in graceful mode (record, never refuse). */
    private readonly capMicros: bigint | undefined,
    holdMicros: bigint,
  ) {
    this.heldMicros = holdMicros;
    if (holdMicros > 0n) store.adjustSessionHold(sessionId, holdMicros);
  }

  /**
   * Strict mode: admit the request only if the session's spend, plus what its
   * other in-flight requests hold, plus this request's estimate fits the cap —
   * and hold the estimate in the same step.
   */
  static admit(
    store: SessionStore,
    sessionId: string,
    capMicros: bigint,
    estimateMicros: bigint,
  ): StrictAdmission {
    const spentMicros = store.getSessionCostMicros(sessionId);
    const heldMicros = store.getSessionHoldMicros(sessionId);
    if (spentMicros + heldMicros + estimateMicros > capMicros) {
      return { admitted: false, spentMicros, heldMicros, estimateMicros };
    }
    return {
      admitted: true,
      spend: new SessionSpend(store, sessionId, capMicros, estimateMicros),
    };
  }

  /** Graceful mode: track signed spend, enforce nothing. */
  static track(store: SessionStore, sessionId: string): SessionSpend {
    return new SessionSpend(store, sessionId, undefined, 0n);
  }

  get isStrict(): boolean {
    return this.capMicros !== undefined;
  }

  /**
   * Before a payment is created: may this request sign `quoteMicros`?
   * Spend already recorded (including this request's own earlier signatures)
   * plus what OTHER in-flight requests hold, plus the quote, must fit the cap.
   * Always true in graceful mode.
   */
  coverPayment(quoteMicros: bigint): boolean {
    if (this.capMicros === undefined) return true;
    const spent = this.store.getSessionCostMicros(this.sessionId);
    const heldByOthers = this.store.getSessionHoldMicros(this.sessionId) - this.heldMicros;
    if (spent + heldByOthers + quoteMicros > this.capMicros) return false;
    // Reserve the quote in the same synchronous step as the check. Signing is
    // async (an RPC read on Solana), so without this two requests whose quotes
    // exceed their admission holds — a reused pre-auth, a pricier fallback, a
    // model with no local estimate — could both pass before either records.
    // If signing then fails, the extra hold lasts only until `release()`.
    if (quoteMicros > this.heldMicros) {
      this.store.adjustSessionHold(this.sessionId, quoteMicros - this.heldMicros);
      this.heldMicros = quoteMicros;
    }
    return true;
  }

  /** A payment was signed: it is spend now, and replaces part of the hold. */
  recordSigned(amountMicros: bigint): void {
    if (amountMicros <= 0n) return;
    this.signedMicros += amountMicros;
    this.signedLog.push(amountMicros);
    this.store.addSessionCost(this.sessionId, amountMicros);
    this.shrinkHold(amountMicros);
  }

  /**
   * The gateway answered the payment just signed with a 402: nothing settled.
   * Payments within one request are signed and sent one at a time, so the
   * decline always belongs to the latest signature. Undone at most once.
   */
  voidLastSigned(): void {
    this.adjustSigned(this.signedLog.length - 1, 0n);
  }

  /** A marker for {@link voidSignedSince}: how many signatures this request has made. */
  signatureMark(): number {
    return this.signedLog.length;
  }

  /**
   * Batch settlement reports one outcome for a whole `pay()`, which may sign
   * more than once (a 429 proven not charged, then a fresh payment). Every
   * signature since `mark` was not charged, except the last one when
   * `keepLast`: it was charged (or is in doubt) and keeps counting.
   */
  voidSignedSince(mark: number, keepLast: boolean): void {
    const end = keepLast ? this.signedLog.length - 1 : this.signedLog.length;
    for (let i = mark; i < end; i++) this.adjustSigned(i, 0n);
  }

  /**
   * The last signature was charged less than it authorized: batch settlement
   * signs the per-call ceiling and the gateway charges what the call cost.
   * Never raises what counts.
   */
  settleLastSigned(chargedMicros: bigint): void {
    const i = this.signedLog.length - 1;
    if (i >= 0 && chargedMicros >= 0n && chargedMicros < this.signedLog[i])
      this.adjustSigned(i, chargedMicros);
  }

  private adjustSigned(index: number, toMicros: bigint): void {
    if (index < 0 || index >= this.signedLog.length) return;
    const delta = toMicros - this.signedLog[index];
    if (delta === 0n) return;
    this.signedLog[index] = toMicros;
    this.signedMicros += delta;
    this.store.addSessionCost(this.sessionId, delta);
  }

  /**
   * An attempt succeeded. When nothing was signed for this request (the API
   * key rail), the local estimate is the only record of the spend. When a
   * payment was signed, it is already recorded at its real amount.
   */
  recordSuccess(estimateMicros: bigint): void {
    // Any signature at all means the spend is already on the books, at what
    // was signed or what a receipt settled it to (zero included).
    if (this.signedLog.length > 0 || estimateMicros <= 0n) return;
    this.store.addSessionCost(this.sessionId, estimateMicros);
    this.shrinkHold(estimateMicros);
  }

  /** The request is over: return whatever it still holds. Idempotent. */
  release(): void {
    if (this.released) return;
    this.released = true;
    this.shrinkHold(this.heldMicros);
  }

  private shrinkHold(byMicros: bigint): void {
    const drop = byMicros < this.heldMicros ? byMicros : this.heldMicros;
    if (drop <= 0n) return;
    this.heldMicros -= drop;
    this.store.adjustSessionHold(this.sessionId, -drop);
  }
}

/**
 * The strict cap refused to sign a payment. A SpendPolicyError so every layer
 * that already treats a policy refusal as final (pre-auth, the fallback loop)
 * does the same here: no second signature, no walk down the paid chain.
 */
export class CostCapError extends SpendPolicyError {
  /** A graceful-mode refusal: the budget ran out, and nothing cheaper may be swapped in. */
  readonly budgetExhausted: boolean;

  constructor(reason: string, budgetExhausted = false) {
    super(reason);
    this.name = "CostCapError";
    this.budgetExhausted = budgetExhausted;
  }
}

/** Why a $0 cap refused a call. */
export const ZERO_CAP_REFUSAL = "ClawRouter cost cap: maxCostPerRun is 0, so no paid call is made";
