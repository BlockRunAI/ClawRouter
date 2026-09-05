/**
 * `describeFetchError` — turning undici's three-word failure into a diagnosis.
 *
 * Reported against the Solana rail (ClawRouter-Hermes#38): every paid model
 * failed with HTTP 500 and a body of exactly "fetch failed", which named
 * neither the host that refused nor the reason. Signing a Solana payment
 * reaches a Solana RPC as well as the gateway, so that string covered two
 * unrelated faults and neither side could tell which one had happened.
 */

import { describe, expect, it } from "vitest";

import { describeFetchError } from "./errors.js";

/** Shapes undici actually throws: a TypeError whose `cause` holds the errno. */
function fetchFailure(cause: Error): TypeError {
  const err = new TypeError("fetch failed");
  (err as TypeError & { cause?: unknown }).cause = cause;
  return err;
}

describe("describeFetchError", () => {
  it("names the host DNS could not resolve", () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND api.mainnet-beta.solana.com"), {
      code: "ENOTFOUND",
      hostname: "api.mainnet-beta.solana.com",
    });

    expect(describeFetchError(fetchFailure(cause))).toBe(
      "fetch failed (ENOTFOUND api.mainnet-beta.solana.com)",
    );
  });

  it("names host and port when the connection was refused", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), {
      code: "ECONNREFUSED",
      address: "127.0.0.1",
      port: 9,
    });

    expect(describeFetchError(fetchFailure(cause))).toBe("fetch failed (ECONNREFUSED 127.0.0.1:9)");
  });

  it("falls back to the cause's message when it carries no errno", () => {
    expect(describeFetchError(fetchFailure(new TypeError("bad port")))).toBe(
      "fetch failed (bad port)",
    );
  });

  it("returns the bare message when there is no cause to unwrap", () => {
    expect(describeFetchError(new Error("boom"))).toBe("boom");
  });

  it("handles non-Error throws", () => {
    expect(describeFetchError("nope")).toBe("nope");
  });
});
