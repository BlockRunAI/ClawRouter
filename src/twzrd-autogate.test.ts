import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { x402Client } from "@x402/fetch";

import { CAIP2_BASE, CAIP2_SOLANA_MAINNET } from "./spend-control.js";
import {
  isMissingTwzrdGateModule,
  isTwzrdAutoGateEnabled,
  maybeComposeTwzrdAutoGate,
  runTwzrdGateWithTimeout,
  twzrdAutoGateInstallOptions,
  twzrdGateFailOpen,
  twzrdGateTimeoutMs,
  TWZRD_GATE_PACKAGE,
  TWZRD_GATE_TIMEOUT_MS,
  type BeforePaymentCreationContext,
  type BeforePaymentCreationResult,
  type TwzrdGateInstallOptions,
  type X402ClientLike,
} from "./twzrd-autogate.js";
import { VERSION } from "./version.js";

function fakeClient(): {
  client: X402ClientLike;
  hooks: Array<(ctx: BeforePaymentCreationContext) => Promise<BeforePaymentCreationResult>>;
} {
  const hooks: Array<(ctx: BeforePaymentCreationContext) => Promise<BeforePaymentCreationResult>> =
    [];
  const client: X402ClientLike = {
    onBeforePaymentCreation(hook) {
      hooks.push(hook);
    },
  };
  return { client, hooks };
}

describe("isTwzrdAutoGateEnabled", () => {
  it("is off by default when both flags are unset", () => {
    expect(isTwzrdAutoGateEnabled({})).toBe(false);
  });

  it("opts in on TWZRD_AUTO_GATE=1", () => {
    expect(isTwzrdAutoGateEnabled({ TWZRD_AUTO_GATE: "1" })).toBe(true);
  });

  it("opts in on TWZRD_GATE_ENABLED=true", () => {
    expect(isTwzrdAutoGateEnabled({ TWZRD_GATE_ENABLED: "true" })).toBe(true);
  });

  it("treats true/yes/on as enable and 0/false as disable", () => {
    expect(isTwzrdAutoGateEnabled({ TWZRD_AUTO_GATE: "yes" })).toBe(true);
    expect(isTwzrdAutoGateEnabled({ TWZRD_AUTO_GATE: "on" })).toBe(true);
    expect(isTwzrdAutoGateEnabled({ TWZRD_AUTO_GATE: "0" })).toBe(false);
    expect(isTwzrdAutoGateEnabled({ TWZRD_AUTO_GATE: "false" })).toBe(false);
    expect(isTwzrdAutoGateEnabled({ TWZRD_GATE_ENABLED: "off" })).toBe(false);
  });

  it("lets an explicit disable win over an enable on the other flag", () => {
    expect(isTwzrdAutoGateEnabled({ TWZRD_AUTO_GATE: "1", TWZRD_GATE_ENABLED: "false" })).toBe(
      false,
    );
  });
});

describe("isMissingTwzrdGateModule", () => {
  it("matches only a missing twzrd-x402-gate package", () => {
    expect(
      isMissingTwzrdGateModule(
        Object.assign(
          new Error("Cannot find package 'twzrd-x402-gate' imported from /app/proxy.js"),
          {
            code: "ERR_MODULE_NOT_FOUND",
          },
        ),
      ),
    ).toBe(true);
    expect(
      isMissingTwzrdGateModule(
        Object.assign(
          new Error(
            "Cannot find package 'some-transitive-dep' imported from /app/node_modules/twzrd-x402-gate/index.js",
          ),
          { code: "ERR_MODULE_NOT_FOUND" },
        ),
      ),
    ).toBe(false);
    expect(isMissingTwzrdGateModule(new Error("boom unrelated"))).toBe(false);
  });
});

describe("twzrdAutoGateInstallOptions", () => {
  it("stamps clawrouter/<version> so a refuse is attributable", () => {
    const opts = twzrdAutoGateInstallOptions({}, () => "run-1");
    expect(opts.attribution.integration).toBe(`clawrouter/${VERSION}`);
    expect(opts.attribution.runId).toBe("run-1");
    expect(opts.refuseWashFlagged).toBe(true);
    expect(opts.gateOnCanSpend).toBe(false);
    expect(opts.unsupportedNetworkMode).toBe("observe");
  });

  it("defaults to fail-open so a gate outage cannot stop payments", () => {
    expect(twzrdAutoGateInstallOptions({}, () => "r").failOpen).toBe(true);
    expect(twzrdGateFailOpen({})).toBe(true);
  });

  it("lets an operator opt into refusing when our wrapper times out or the gate throws", () => {
    // Only our wrapper reads this. The package's wash lookup stays fail-open —
    // see the real-package suite below.
    for (const v of ["0", "false", "no", "off", "OFF"]) {
      expect(twzrdGateFailOpen({ TWZRD_FAIL_OPEN: v })).toBe(false);
      expect(twzrdAutoGateInstallOptions({ TWZRD_FAIL_OPEN: v }, () => "r").failOpen).toBe(false);
    }
  });

  it("bounds the answer, and ignores a nonsense budget", () => {
    expect(twzrdGateTimeoutMs({})).toBe(TWZRD_GATE_TIMEOUT_MS);
    expect(twzrdGateTimeoutMs({ TWZRD_GATE_TIMEOUT_MS: "50" })).toBe(50);
    for (const bad of ["", "0", "-1", "abc"]) {
      expect(twzrdGateTimeoutMs({ TWZRD_GATE_TIMEOUT_MS: bad })).toBe(TWZRD_GATE_TIMEOUT_MS);
    }
  });
});

describe("runTwzrdGateWithTimeout", () => {
  const never = () => new Promise<BeforePaymentCreationResult>(() => {});

  it("passes a verdict straight through when the gate answers in time", async () => {
    const abort = { abort: true as const, reason: "wash" };
    await expect(
      runTwzrdGateWithTimeout(async () => abort, { timeoutMs: 500, failOpen: true }),
    ).resolves.toEqual(abort);
  });

  it("proceeds when the gate hangs — SpendControl still applies", async () => {
    const warn = vi.fn();
    const out = await runTwzrdGateWithTimeout(never, {
      timeoutMs: 10,
      failOpen: true,
      log: { log: vi.fn(), warn },
    });
    expect(out).toBeUndefined();
    expect(warn.mock.calls[0]?.[0]).toContain("did not answer within 10ms");
  });

  it("refuses when the gate hangs under TWZRD_FAIL_OPEN=false", async () => {
    const out = await runTwzrdGateWithTimeout(never, {
      timeoutMs: 10,
      failOpen: false,
      log: { log: vi.fn(), warn: vi.fn() },
    });
    expect(out).toEqual({
      abort: true,
      reason: "twzrd gate did not answer within 10ms",
    });
  });

  it("treats a throwing gate as a failure instead of propagating into x402", async () => {
    const warn = vi.fn();
    const out = await runTwzrdGateWithTimeout(
      async () => {
        throw new Error("intel.twzrd.xyz unreachable");
      },
      { timeoutMs: 500, failOpen: true, log: { log: vi.fn(), warn } },
    );
    expect(out).toBeUndefined();
    expect(warn.mock.calls[0]?.[0]).toContain("intel.twzrd.xyz unreachable");

    const refused = await runTwzrdGateWithTimeout(
      async () => {
        throw new Error("boom");
      },
      { timeoutMs: 500, failOpen: false, log: { log: vi.fn(), warn: vi.fn() } },
    );
    expect(refused).toEqual({ abort: true, reason: "twzrd gate threw: boom" });
  });

  it("does not leave a late rejection unhandled", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on("unhandledRejection", onUnhandled);
    try {
      await runTwzrdGateWithTimeout(
        () => new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 5)),
        { timeoutMs: 1, failOpen: true, log: { log: vi.fn(), warn: vi.fn() } },
      );
      await new Promise((r) => setTimeout(r, 30));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});

describe("maybeComposeTwzrdAutoGate", () => {
  const prevAuto = process.env.TWZRD_AUTO_GATE;
  const prevGate = process.env.TWZRD_GATE_ENABLED;

  afterEach(() => {
    if (prevAuto === undefined) delete process.env.TWZRD_AUTO_GATE;
    else process.env.TWZRD_AUTO_GATE = prevAuto;
    if (prevGate === undefined) delete process.env.TWZRD_GATE_ENABLED;
    else process.env.TWZRD_GATE_ENABLED = prevGate;
  });

  it("does not load or register anything on the default path", async () => {
    const loadGate = vi.fn();
    const { client, hooks } = fakeClient();
    const spendHook = async () => undefined;
    client.onBeforePaymentCreation(spendHook);

    const result = await maybeComposeTwzrdAutoGate(client, {
      env: {},
      loadGate,
      log: { log: vi.fn(), warn: vi.fn() },
    });

    expect(result).toEqual({ status: "skipped" });
    expect(loadGate).not.toHaveBeenCalled();
    expect(hooks).toEqual([spendHook]);
  });

  it("composes installTwzrdAutoGate after an existing SpendControl hook", async () => {
    const { client, hooks } = fakeClient();
    const spendHook = async () => undefined;
    client.onBeforePaymentCreation(spendHook);

    let invoked = 0;
    const installTwzrdAutoGate = vi.fn((x402: X402ClientLike, opts?: TwzrdGateInstallOptions) => {
      expect(opts?.attribution.integration).toBe(`clawrouter/${VERSION}`);
      x402.onBeforePaymentCreation(async () => {
        invoked += 1;
      });
    });

    const result = await maybeComposeTwzrdAutoGate(client, {
      env: { TWZRD_AUTO_GATE: "1" },
      loadGate: async () => ({ installTwzrdAutoGate }),
      log: { log: vi.fn(), warn: vi.fn() },
    });

    expect(result).toEqual({ status: "composed", via: "installTwzrdAutoGate" });
    expect(installTwzrdAutoGate).toHaveBeenCalledTimes(1);
    expect(hooks[0]).toBe(spendHook);
    expect(hooks).toHaveLength(2);

    await hooks[1]!({
      selectedRequirements: { payTo: "Seller1111111111111111111111111111111111111" },
    });
    expect(invoked).toBe(1);
  });

  it("registers createTwzrdBeforePaymentHook itself and invokes it", async () => {
    const { client, hooks } = fakeClient();
    const seen: unknown[] = [];
    const createTwzrdBeforePaymentHook = vi.fn(() => {
      return async (requirements: Record<string, unknown>) => {
        seen.push(requirements);
        return { abort: true as const, reason: "wash" };
      };
    });

    const result = await maybeComposeTwzrdAutoGate(client, {
      env: { TWZRD_AUTO_GATE: "1" },
      loadGate: async () => ({ createTwzrdBeforePaymentHook }),
      log: { log: vi.fn(), warn: vi.fn() },
    });

    expect(result).toEqual({ status: "composed", via: "createTwzrdBeforePaymentHook" });
    const abort = await hooks[0]!({ selectedRequirements: { payTo: "wash" } });
    expect(abort).toEqual({ abort: true, reason: "wash" });
    expect(seen).toEqual([{ payTo: "wash" }]);
  });

  it("prefers the hook factory over installTwzrdAutoGate, which replaces our registrar", async () => {
    // installTwzrdAutoGate monkey-patches client.onBeforePaymentCreation, so
    // every hook registered after it inherits a third-party kill switch. When
    // the gate offers both entry points we must take the one that does not.
    const { client } = fakeClient();
    const installTwzrdAutoGate = vi.fn();
    const createTwzrdBeforePaymentHook = vi.fn(() => async () => undefined);

    const result = await maybeComposeTwzrdAutoGate(client, {
      env: { TWZRD_AUTO_GATE: "1" },
      loadGate: async () => ({ installTwzrdAutoGate, createTwzrdBeforePaymentHook }),
      log: { log: vi.fn(), warn: vi.fn() },
    });

    expect(result).toEqual({ status: "composed", via: "createTwzrdBeforePaymentHook" });
    expect(installTwzrdAutoGate).not.toHaveBeenCalled();
  });

  it("time-boxes the composed hook so a hung gate cannot stall a payment", async () => {
    const { client, hooks } = fakeClient();
    const warn = vi.fn();

    await maybeComposeTwzrdAutoGate(client, {
      env: { TWZRD_AUTO_GATE: "1", TWZRD_GATE_TIMEOUT_MS: "10" },
      loadGate: async () => ({
        createTwzrdBeforePaymentHook: () => () =>
          new Promise<BeforePaymentCreationResult>(() => {}),
      }),
      log: { log: vi.fn(), warn },
    });

    const started = Date.now();
    const out = await hooks[0]!({ selectedRequirements: { payTo: "Seller111" } });
    expect(out).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(warn.mock.calls[0]?.[0]).toContain("did not answer within 10ms");
  });

  it("refuses a hung gate when the operator asked for fail-closed", async () => {
    const { client, hooks } = fakeClient();

    await maybeComposeTwzrdAutoGate(client, {
      env: { TWZRD_AUTO_GATE: "1", TWZRD_GATE_TIMEOUT_MS: "10", TWZRD_FAIL_OPEN: "false" },
      loadGate: async () => ({
        createTwzrdBeforePaymentHook: () => () =>
          new Promise<BeforePaymentCreationResult>(() => {}),
      }),
      log: { log: vi.fn(), warn: vi.fn() },
    });

    const out = await hooks[0]!({ selectedRequirements: { payTo: "Seller111" } });
    expect(out).toEqual({ abort: true, reason: "twzrd gate did not answer within 10ms" });
  });

  it("fails open only when twzrd-x402-gate itself is missing", async () => {
    const warn = vi.fn();
    const result = await maybeComposeTwzrdAutoGate(fakeClient().client, {
      env: { TWZRD_AUTO_GATE: "1" },
      loadGate: async () => {
        throw Object.assign(new Error("Cannot find package 'twzrd-x402-gate' imported from /app"), {
          code: "ERR_MODULE_NOT_FOUND",
        });
      },
      log: { log: vi.fn(), warn },
    });
    expect(result.status).toBe("unavailable");
    expect(warn).toHaveBeenCalled();
  });

  it("fails closed on a real module error", async () => {
    await expect(
      maybeComposeTwzrdAutoGate(fakeClient().client, {
        env: { TWZRD_AUTO_GATE: "1" },
        loadGate: async () => {
          throw new Error("unexpected gate init failure");
        },
        log: { log: vi.fn(), warn: vi.fn() },
      }),
    ).rejects.toThrow("unexpected gate init failure");
  });
});

// ---------------------------------------------------------------------------
// The real package. Everything above mocks the gate module; these load the
// published twzrd-x402-gate through the adapter's own dynamic import and mock
// only HTTP, so they pin down what 0.9.4 actually does on the pre-sign path:
// a wash-only GET merchant_card/{payTo} on every network, refusal on wash AND
// on unknown coverage, and a fail-open inside the package that TWZRD_FAIL_OPEN
// cannot reach. The signer is the real x402Client's scheme client, as in
// spend-control.test.ts, so "never signed" means the client never got there.
//
// twzrd-x402-gate is an optionalDependency. `npm ci` installs it (CI does not
// pass --omit=optional), so this suite runs in CI; a fork that drops it skips.
// ---------------------------------------------------------------------------

const PINNED_GATE_VERSION = "0.9.4";
const testRequire = createRequire(import.meta.url);
const installedGate = (() => {
  try {
    return testRequire(`${TWZRD_GATE_PACKAGE}/package.json`) as {
      version: string;
      exports: Record<string, unknown>;
    };
  } catch {
    return undefined;
  }
})();

describe.skipIf(installedGate === undefined)(
  `${TWZRD_GATE_PACKAGE}@${PINNED_GATE_VERSION} (real package, mocked HTTP)`,
  () => {
    const INTEL_BASE = "https://intel.twzrd.xyz";
    const SOLANA_PAY_TO = "Se11er1111111111111111111111111111111111111";
    const BASE_PAY_TO = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    type Caip2 = `${string}:${string}`;
    const NETWORKS: Array<{ label: string; network: Caip2; payTo: string }> = [
      { label: "Solana", network: CAIP2_SOLANA_MAINNET, payTo: SOLANA_PAY_TO },
      { label: "Base", network: CAIP2_BASE, payTo: BASE_PAY_TO },
    ];
    const merchantCardUrl = (payTo: string) =>
      `${INTEL_BASE}/v1/intel/merchant_card/${encodeURIComponent(payTo)}`;

    // The package reads these straight off process.env (not our env object),
    // so an operator's shell must not leak into the assertions.
    const PACKAGE_ENV = [
      "TWZRD_INTEL_BASE",
      "TWZRD_REFUSE_WASH_FLAGGED",
      "TWZRD_WASH_MAX_USDC",
      "TWZRD_WASH_TIMEOUT_MS",
      "TWZRD_FAIL_OPEN",
      "TWZRD_AUTO_GATE",
      "TWZRD_GATE_ENABLED",
    ] as const;
    let savedEnv: Partial<Record<(typeof PACKAGE_ENV)[number], string | undefined>> = {};

    beforeEach(() => {
      savedEnv = {};
      for (const key of PACKAGE_ENV) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
      }
      // The package's own merchant_card timeout (default 3000ms) must outlive our
      // budget for the "hang" rows to reach our wrapper; keep it short so a
      // never-resolving fetch does not linger past the test.
      process.env.TWZRD_WASH_TIMEOUT_MS = "300";
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      for (const key of PACKAGE_ENV) {
        const prev = savedEnv[key];
        if (prev === undefined) delete process.env[key];
        else process.env[key] = prev;
      }
    });

    type FetchCall = { url: string; init: RequestInit | undefined };

    /** Replace globalThis.fetch (what the package uses) and record every call. */
    function stubIntel(respond: (call: FetchCall) => Promise<Response> | Response) {
      const calls: FetchCall[] = [];
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const call = { url: String(input), init };
        calls.push(call);
        return respond(call);
      });
      vi.stubGlobal("fetch", fetchMock);
      return { calls, fetchMock };
    }

    const card = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    /** A fetch that never answers, but does honour the package's abort signal. */
    const hang = (call: FetchCall) =>
      new Promise<Response>((_, reject) => {
        call.init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });

    const headerOf = (call: FetchCall, name: string) => new Headers(call.init?.headers).get(name);

    /**
     * Production shape: a real x402Client, SpendControl's slot taken by a spy
     * registered first, TWZRD composed through the adapter with NO loadGate
     * (so the adapter's own `import("twzrd-x402-gate")` runs), and a scheme
     * client whose createPaymentPayload stands in for the wallet signer.
     */
    async function gatedClient(env: NodeJS.ProcessEnv = {}) {
      const client = new x402Client();
      const spendHook = vi.fn(async () => undefined);
      client.onBeforePaymentCreation(spendHook);

      const log = { log: vi.fn(), warn: vi.fn() };
      const composed = await maybeComposeTwzrdAutoGate(client, {
        env: { TWZRD_AUTO_GATE: "1", ...env },
        log,
      });
      expect(composed).toEqual({ status: "composed", via: "createTwzrdBeforePaymentHook" });

      let signerCalls = 0;
      for (const { network } of NETWORKS) {
        client.register(network, {
          scheme: "exact",
          async createPaymentPayload() {
            signerCalls += 1;
            return { x402Version: 2, payload: {} };
          },
        });
      }
      return { client, spendHook, log, signer: () => signerCalls };
    }

    function pay(client: x402Client, network: Caip2, payTo: string) {
      return client.createPaymentPayload({
        x402Version: 2,
        resource: { url: "https://example.invalid/pay" },
        accepts: [
          {
            scheme: "exact",
            network,
            amount: "10000",
            asset: "USDC",
            payTo,
            maxTimeoutSeconds: 60,
            extra: {},
          },
        ],
      });
    }

    it(`is installed at exactly ${PINNED_GATE_VERSION}, the version the docs describe`, () => {
      const declared = (
        testRequire("../package.json") as { optionalDependencies: Record<string, string> }
      ).optionalDependencies[TWZRD_GATE_PACKAGE];
      expect(declared).toBe(PINNED_GATE_VERSION);
      expect(installedGate?.version).toBe(PINNED_GATE_VERSION);
      // 0.10.x shipped a "./unsafe" entry and is deprecated as unreproducible.
      expect(Object.keys(installedGate?.exports ?? {})).not.toContain("./unsafe");
    });

    it.each(NETWORKS)(
      "$label: clean payTo with full coverage → one GET merchant_card/{payTo}, attributed, then signs",
      async ({ network, payTo }) => {
        const { calls, fetchMock } = stubIntel(() =>
          card({ wash_flagged: false, wash_confidence: "full", ring_evaluated: true }),
        );
        const { client, spendHook, log, signer } = await gatedClient();

        await pay(client, network, payTo);

        expect(signer()).toBe(1);
        expect(spendHook).toHaveBeenCalledTimes(1);
        // SpendControl's slot runs before the gate's lookup.
        expect(spendHook.mock.invocationCallOrder[0]).toBeLessThan(
          fetchMock.mock.invocationCallOrder[0]!,
        );

        // Wash-only engine: exactly one lookup, and it is not the preflight POST.
        expect(calls).toHaveLength(1);
        const [call] = calls;
        expect(call!.url).toBe(merchantCardUrl(payTo));
        expect(call!.init?.method).toBe("GET");
        expect(call!.init?.body).toBeUndefined();

        expect(headerOf(call!, "X-Twzrd-Caller")).toBe(
          `clawrouter/${VERSION}@${PINNED_GATE_VERSION}`,
        );
        expect(headerOf(call!, "X-TWZRD-Integration")).toBe(`clawrouter/${VERSION}`);
        expect(headerOf(call!, "X-TWZRD-Run-Id")).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
        expect(headerOf(call!, "X-TWZRD-Client")).toBe(
          `${TWZRD_GATE_PACKAGE}/${PINNED_GATE_VERSION}`,
        );
        expect(log.warn).not.toHaveBeenCalled();
      },
    );

    it.each(NETWORKS)(
      "$label: wash_flagged=true → aborts before sign; signer never called",
      async ({ network, payTo }) => {
        stubIntel(() =>
          card({ wash_flagged: true, wash_confidence: "full", ring_evaluated: true }),
        );
        const { client, signer } = await gatedClient();

        await expect(pay(client, network, payTo)).rejects.toThrow(
          `Payment creation aborted: [twzrd] twzrd_wash_flagged payTo=${payTo}`,
        );
        expect(signer()).toBe(0);
      },
    );

    it.each([
      ["no wash_confidence", { wash_flagged: false }],
      ["partial", { wash_flagged: false, wash_confidence: "partial" }],
      ["base_2cycle", { wash_flagged: false, wash_confidence: "base_2cycle" }],
      [
        "ring not evaluated",
        { wash_flagged: false, wash_confidence: "full", ring_evaluated: false },
      ],
      ["stale", { wash_flagged: false, wash_confidence: "full", wash_stale: true }],
      ["card with no wash data", {}],
    ])(
      "wash_flagged=false with %s coverage → aborts with twzrd_wash_unknown; unknown is not clean",
      async (_label, body) => {
        stubIntel(() => card(body));
        const { client, signer } = await gatedClient();

        await expect(pay(client, CAIP2_BASE, BASE_PAY_TO)).rejects.toThrow(
          `Payment creation aborted: [twzrd] twzrd_wash_unknown payTo=${BASE_PAY_TO}`,
        );
        expect(signer()).toBe(0);
      },
    );

    // LIMITATION, documented on purpose: TWZRD_FAIL_OPEN=false governs only our
    // wrapper. The package converts a fast lookup failure into allow before our
    // wrapper sees anything, so refuse-on-outage is not fully enforced. A fix
    // belongs in the package, not here.
    it.each([
      ["a fast HTTP 503", () => new Response("upstream down", { status: 503 })],
      ["a 404 (no card)", () => new Response("not found", { status: 404 })],
      ["a network error (fetch failed)", () => Promise.reject(new TypeError("fetch failed"))],
      ["a 200 with a non-JSON body", () => new Response("<html>", { status: 200 })],
    ])(
      "%s with TWZRD_FAIL_OPEN=false → still allows (package-internal fail-open; not refuse-on-outage)",
      async (_label, respond) => {
        const { calls } = stubIntel(respond);
        const { client, log, signer } = await gatedClient({ TWZRD_FAIL_OPEN: "false" });

        await pay(client, CAIP2_SOLANA_MAINNET, SOLANA_PAY_TO);

        expect(signer()).toBe(1);
        expect(calls).toHaveLength(1);
        // Our wrapper saw a normal "proceed" answer, so it had nothing to refuse.
        expect(log.warn).not.toHaveBeenCalled();
      },
    );

    it("a lookup that hangs past our budget with TWZRD_FAIL_OPEN=false → aborts; signer never called", async () => {
      stubIntel(hang);
      const { client, log, signer } = await gatedClient({
        TWZRD_FAIL_OPEN: "false",
        TWZRD_GATE_TIMEOUT_MS: "20",
      });

      await expect(pay(client, CAIP2_SOLANA_MAINNET, SOLANA_PAY_TO)).rejects.toThrow(
        "Payment creation aborted: twzrd gate did not answer within 20ms",
      );
      expect(signer()).toBe(0);
      expect(log.warn.mock.calls[0]?.[0]).toContain("refusing the payment (TWZRD_FAIL_OPEN=false)");
    });

    it("a lookup that hangs past our budget with default config → allows with a warning", async () => {
      stubIntel(hang);
      const { client, log, signer } = await gatedClient({ TWZRD_GATE_TIMEOUT_MS: "20" });

      await pay(client, CAIP2_BASE, BASE_PAY_TO);

      expect(signer()).toBe(1);
      expect(log.warn.mock.calls[0]?.[0]).toContain("did not answer within 20ms — proceeding");
    });

    // Same limitation from the other side: the package's own merchant_card
    // timeout (TWZRD_WASH_TIMEOUT_MS, default 3000) also resolves to allow, so
    // TWZRD_FAIL_OPEN=false only bites while our budget is the shorter one.
    it("the package's own wash timeout, when shorter than our budget, allows even under TWZRD_FAIL_OPEN=false", async () => {
      process.env.TWZRD_WASH_TIMEOUT_MS = "10";
      stubIntel(hang);
      const { client, log, signer } = await gatedClient({
        TWZRD_FAIL_OPEN: "false",
        TWZRD_GATE_TIMEOUT_MS: "1000",
      });

      await pay(client, CAIP2_SOLANA_MAINNET, SOLANA_PAY_TO);

      expect(signer()).toBe(1);
      expect(log.warn).not.toHaveBeenCalled();
    });
  },
);
