/**
 * Solana batch settlement at the payment layer: what registerSolanaBatchScheme
 * hands the SDK, and how createPayFetchWithPreAuth falls back to `exact`.
 *
 * Both schemes are fakes registered on a real x402Client, so the client's own
 * selection and policies run while nothing signs or touches the network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { x402Client } from "@x402/fetch";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { createPayFetchWithPreAuth } from "./payment-preauth.js";
import { SolanaBatchGuard, parseSolanaBatchConfig } from "./solana-batch.js";

const batchCtor = vi.fn();
vi.mock("@x402/svm/batch-settlement/client", () => ({
  BatchSvmScheme: class {
    readonly scheme = "batch-settlement";
    readonly paymentPolicy = (_v: number, accepts: unknown[]) => accepts;
    constructor(...args: unknown[]) {
      batchCtor(...args);
    }
  },
}));

const OPERATOR = "5YKPQUFjw5WQqhSUkEGKNNfYYVqnRRNbpYyL71qQ1vm3";
const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const accept = (scheme: string) => ({
  scheme,
  network: NETWORK,
  amount: "1000",
  asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  payTo: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  maxTimeoutSeconds: 300,
  extra: scheme === "batch-settlement" ? { voucherSigner: "server", operator: OPERATOR } : {},
});
const CHALLENGE = {
  x402Version: 2,
  accepts: [accept("batch-settlement"), accept("exact")],
  resource: { url: "https://sol.gw/api", description: "t", mimeType: "application/json" },
};

function challenge402(): Response {
  return new Response("{}", {
    status: 402,
    headers: { "payment-required": Buffer.from(JSON.stringify(CHALLENGE)).toString("base64") },
  });
}

/** A gateway that answers 402 without payment and records the scheme of each paid call. */
function gateway(onPaid: (scheme: string) => Response | Promise<Response>) {
  const paid: string[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const sig = req.headers.get("payment-signature");
    if (!sig) return challenge402();
    const scheme = decodePaymentSignatureHeader(sig).accepted.scheme;
    paid.push(scheme);
    return onPaid(scheme);
  });
  return { fn: fn as unknown as typeof fetch, paid };
}

function fakeScheme(scheme: string, fail?: () => Error) {
  return {
    scheme,
    createPaymentPayload: vi.fn(async (x402Version: number) => {
      if (fail) throw fail();
      return { x402Version, payload: { scheme } };
    }),
  };
}

function client(batchFails?: () => Error) {
  const x402 = new x402Client().setSpendControls(false);
  x402.register("solana:*", fakeScheme("exact"));
  x402.register("solana:*", fakeScheme("batch-settlement", batchFails));
  return x402;
}

const ok = () => new Response("{}", { status: 200 });
const URL = "https://sol.gw/api/v1/chat/completions";
const init = () => ({ method: "POST", body: JSON.stringify({ model: "m", messages: [] }) });

beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe("registerSolanaBatchScheme", () => {
  it("trusts only the configured operators, capped at one deposit", async () => {
    const { registerSolanaBatchScheme } = await import("./solana-batch.js");
    const x402 = new x402Client();
    const register = vi.spyOn(x402, "register");
    const registerPolicy = vi.spyOn(x402, "registerPolicy");
    const config = parseSolanaBatchConfig({
      CLAWROUTER_SOLANA_BATCH: "1",
      CLAWROUTER_SOLANA_BATCH_DEPOSIT_USDC: "2.5",
      CLAWROUTER_SOLANA_BATCH_OPERATORS: OPERATOR,
    });
    const signer = {} as never;
    const guard = await registerSolanaBatchScheme(x402, signer, config, {
      storeFile: "/nonexistent/channels.json",
      fetchAccount: async () => null,
    });

    expect(guard).toBeInstanceOf(SolanaBatchGuard);
    const [passedSigner, options] = batchCtor.mock.calls.at(-1)!;
    expect(passedSigner).toBe(signer);
    expect(options).toMatchObject({
      depositAmount: "2500000",
      serverSignedChannelsPolicy: { allowedOperators: [OPERATOR], maxDeposit: "$2.500000" },
    });
    expect(options.channelStorage.file).toBe("/nonexistent/channels.json");
    expect(register).toHaveBeenCalledWith(
      "solana:*",
      expect.objectContaining({ scheme: "batch-settlement" }),
    );
    expect(registerPolicy).toHaveBeenCalledWith(guard.policy);
  });

  it("refuses a config that is not on", async () => {
    const { registerSolanaBatchScheme } = await import("./solana-batch.js");
    const config = parseSolanaBatchConfig({ CLAWROUTER_SOLANA_BATCH: "1" });
    await expect(registerSolanaBatchScheme(new x402Client(), {} as never, config)).rejects.toThrow(
      /no-operator/,
    );
  });
});

describe("payment fallback to exact", () => {
  it("pays with batch when it works, and feeds the answer to the scheme", async () => {
    const x402 = client();
    const onResponse = vi.fn(async () => undefined);
    x402.onPaymentResponse(onResponse);
    const gw = gateway(ok);
    const res = await createPayFetchWithPreAuth(gw.fn, x402, undefined, { skipPreAuth: true })(
      URL,
      init(),
    );
    expect(res.status).toBe(200);
    expect(gw.paid).toEqual(["batch-settlement"]);
    expect(onResponse).toHaveBeenCalledOnce();
  });

  it("pays with exact when batch signing fails", async () => {
    const gw = gateway(ok);
    const pay = createPayFetchWithPreAuth(
      gw.fn,
      client(() => new Error("rpc down")),
      undefined,
      { skipPreAuth: true },
    );
    expect((await pay(URL, init())).status).toBe(200);
    expect(gw.paid).toEqual(["exact"]);
  });

  it("pays with exact when the gateway answers 402 to the batch payment", async () => {
    const gw = gateway((scheme) => (scheme === "exact" ? ok() : challenge402()));
    const pay = createPayFetchWithPreAuth(gw.fn, client(), undefined, { skipPreAuth: true });
    expect((await pay(URL, init())).status).toBe(200);
    expect(gw.paid).toEqual(["batch-settlement", "exact"]);
  });

  it("does not pay again when the batch send itself fails (the voucher may have landed)", async () => {
    const gw = gateway(() => {
      throw new TypeError("fetch failed: socket hang up");
    });
    const pay = createPayFetchWithPreAuth(gw.fn, client(), undefined, { skipPreAuth: true });
    await expect(pay(URL, init())).rejects.toThrow(/socket hang up/);
    expect(gw.paid).toEqual(["batch-settlement"]);
  });

  it("pays with exact once the guard has disabled batch", async () => {
    const x402 = client();
    const guard = new SolanaBatchGuard({ entries: async () => [] }, async () => null);
    x402.registerPolicy(guard.policy);
    vi.spyOn(console, "error").mockImplementation(() => {});
    guard.disable("test");
    const gw = gateway(ok);
    await createPayFetchWithPreAuth(gw.fn, x402, undefined, { skipPreAuth: true })(URL, init());
    expect(gw.paid).toEqual(["exact"]);
  });
});
