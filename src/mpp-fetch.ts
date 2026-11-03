/**
 * MPP (Machine Payments Protocol) upstream fetch — SPIKE.
 *
 * A third way to pay an upstream, beside the x402 wallet rail and the BlockRun API key: answer an
 * HTTP 402 `WWW-Authenticate: Payment` challenge (Tempo charge) with the `mppx` client and retry.
 * Same signature as the other rails' fetch, so the proxy handlers stay unaware of how a call is paid.
 *
 * The account is supplied by the caller; this module reads no env vars and no key files.
 */
import { Mppx, tempo } from "mppx/client";
import type { Account } from "viem";

export type PayFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function createMppFetch(account: Account, base: typeof fetch = fetch): PayFetch {
  // Remember the last 402 the upstream sent. mppx throws "No method found for challenges" when a 402
  // offers nothing this client can pay (e.g. a non-MPP gateway); callers expect to see that 402, not
  // an exception, so the proxy can classify it as a payment error like the other rails do.
  let last402: Response | undefined;
  const recording: typeof fetch = async (input, init) => {
    const res = await base(input, init);
    last402 = res.status === 402 ? res.clone() : undefined;
    return res;
  };
  // polyfill:false keeps globalThis.fetch untouched: only calls routed through this wrapper can pay.
  const mppx = Mppx.create({ methods: [tempo({ account })], polyfill: false, fetch: recording });
  return async (input, init) => {
    last402 = undefined;
    try {
      return await mppx.fetch(input, init);
    } catch (e) {
      if (last402 && /No method found for challenges/.test((e as Error).message)) return last402;
      throw e;
    }
  };
}
