/**
 * Opt-in TWZRD AutoGate on the existing x402 onBeforePaymentCreation chain.
 *
 * Default OFF. SpendControl remains the vendor-neutral path (#205 / #268 / #304).
 * This is not a re-open of withdrawn #218 (default-on vendor lock).
 *
 * When TWZRD_AUTO_GATE=1 (or TWZRD_GATE_ENABLED=true), compose
 * installTwzrdAutoGate / createTwzrdBeforePaymentHook AFTER registerSpendPolicyHook
 * so a wash payTo is refused before sign. Identity header:
 *   X-Twzrd-Caller: clawrouter/<version>
 *
 * Fail closed on a real module error; fail open only when twzrd-x402-gate itself
 * is missing (optionalDependency — forks may omit it). That is LOAD time.
 *
 * PAYMENT time is the opposite default, deliberately. Reputation scoring is
 * Solana-only (Base/EVM classifies as `network_not_scored` / `unknown` under
 * `unsupportedNetworkMode: "observe"`). As of twzrd-x402-gate@0.9.4, observe
 * is not a wash bypass: refuseWashFlagged still GETs merchant_card on Base.
 * The Solana preflight is a synchronous POST to intel.twzrd.xyz with NO
 * timeout of its own. The package defaults to `failOpen: false`, so an
 * outage there would refuse every paid Solana call — the exact shape of the
 * v0.12.271 outage, where an unreachable third party made every Solana
 * payment fail with a bare `fetch failed`. This gate is ADDITIONAL cover on
 * top of SpendControl, which is unaffected by it, so an outage in it must
 * not stop payments. We pass `failOpen: true` and bound the hook with a
 * timeout. `TWZRD_FAIL_OPEN=false` opts back into refusing.
 */

import { randomUUID } from "node:crypto";
import { VERSION } from "./version.js";

export const TWZRD_GATE_PACKAGE = "twzrd-x402-gate";

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

export type BeforePaymentCreationResult = void | { abort: true; reason: string };

export type BeforePaymentCreationContext = {
  selectedRequirements: Record<string, unknown>;
  paymentRequired?: unknown;
};

export type X402ClientLike = {
  onBeforePaymentCreation: (
    hook: (context: BeforePaymentCreationContext) => Promise<BeforePaymentCreationResult>,
  ) => unknown;
};

export type TwzrdGateInstallOptions = {
  refuseWashFlagged: boolean;
  gateOnCanSpend: boolean;
  unsupportedNetworkMode: "observe" | "strict";
  failOpen: boolean;
  attribution: { integration: string; runId: string };
};

export type TwzrdGateModule = {
  installTwzrdAutoGate?: (client: X402ClientLike, options?: TwzrdGateInstallOptions) => unknown;
  createTwzrdBeforePaymentHook?: (
    options?: TwzrdGateInstallOptions,
  ) => (
    requirements: Record<string, unknown>,
    context?: unknown,
  ) => Promise<BeforePaymentCreationResult>;
};

export type LoadTwzrdGate = () => Promise<TwzrdGateModule>;

export type ComposeTwzrdAutoGateResult =
  | { status: "skipped" }
  | { status: "composed"; via: "installTwzrdAutoGate" | "createTwzrdBeforePaymentHook" }
  | { status: "unavailable"; reason: string };

function normalizeFlag(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * True only when an operator explicitly opts in. Unset is off.
 * An explicit disable (`0` / `false` / `no` / `off`) on either flag wins.
 */
export function isTwzrdAutoGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const auto = normalizeFlag(env.TWZRD_AUTO_GATE);
  const gate = normalizeFlag(env.TWZRD_GATE_ENABLED);
  if ((auto !== undefined && FALSY.has(auto)) || (gate !== undefined && FALSY.has(gate))) {
    return false;
  }
  return (auto !== undefined && TRUTHY.has(auto)) || (gate !== undefined && TRUTHY.has(gate));
}

/** Fail-open only when the absent package is the optional gate itself. */
export function isMissingTwzrdGateModule(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  const msg = err instanceof Error ? err.message : String(err);
  const missingModule =
    code === "ERR_MODULE_NOT_FOUND" ||
    code === "MODULE_NOT_FOUND" ||
    /Cannot find module/i.test(msg) ||
    /Cannot find package/i.test(msg);
  return missingModule && new RegExp(String.raw`['"]${TWZRD_GATE_PACKAGE}['"]`).test(msg);
}

/** Budget for the gate's answer. Its preflight sets no timeout of its own. */
export const TWZRD_GATE_TIMEOUT_MS = 2_000;

/** Operator override for the answer budget; falls back to the default. */
export function twzrdGateTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = normalizeFlag(env.TWZRD_GATE_TIMEOUT_MS);
  if (raw === undefined) return TWZRD_GATE_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : TWZRD_GATE_TIMEOUT_MS;
}

/**
 * Default true — see the note at the top of this file. `TWZRD_FAIL_OPEN=false`
 * (or 0/no/off) restores the package's own refuse-on-outage behaviour.
 */
export function twzrdGateFailOpen(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = normalizeFlag(env.TWZRD_FAIL_OPEN);
  return !(raw !== undefined && FALSY.has(raw));
}

export function twzrdAutoGateInstallOptions(
  env: NodeJS.ProcessEnv = process.env,
  runId: () => string = randomUUID,
): TwzrdGateInstallOptions {
  return {
    refuseWashFlagged: true,
    gateOnCanSpend: false,
    unsupportedNetworkMode: "observe",
    failOpen: twzrdGateFailOpen(env),
    attribution: {
      integration: `clawrouter/${VERSION}`,
      runId: runId(),
    },
  };
}

const TIMED_OUT = { __twzrdTimedOut: true } as const;
type TimedOut = typeof TIMED_OUT;

/**
 * Bound the gate's answer. A third party in the pre-sign path must not be able
 * to hang a payment: on expiry we proceed (or refuse, under TWZRD_FAIL_OPEN=false),
 * and a rejection is treated the same way rather than propagating into x402.
 */
export async function runTwzrdGateWithTimeout(
  run: () => Promise<BeforePaymentCreationResult>,
  opts: { timeoutMs: number; failOpen: boolean; log?: Pick<Console, "log" | "warn"> },
): Promise<BeforePaymentCreationResult> {
  const log = opts.log ?? console;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raced = await Promise.race<
      BeforePaymentCreationResult | TimedOut | { __twzrdError: unknown }
    >([
      // Swallow here, not at the race, so a late rejection never goes unhandled.
      Promise.resolve()
        .then(run)
        .catch((err: unknown) => ({ __twzrdError: err })),
      new Promise<TimedOut>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), opts.timeoutMs);
      }),
    ]);

    if (raced === TIMED_OUT) {
      return decideOnGateFailure(`did not answer within ${opts.timeoutMs}ms`, opts.failOpen, log);
    }
    if (raced && typeof raced === "object" && "__twzrdError" in raced) {
      const err = (raced as { __twzrdError: unknown }).__twzrdError;
      const msg = err instanceof Error ? err.message : String(err);
      return decideOnGateFailure(`threw: ${msg.slice(0, 120)}`, opts.failOpen, log);
    }
    return raced as BeforePaymentCreationResult;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function decideOnGateFailure(
  what: string,
  failOpen: boolean,
  log: Pick<Console, "log" | "warn">,
): BeforePaymentCreationResult {
  const reason = `twzrd gate ${what}`;
  if (failOpen) {
    log.warn(
      `[ClawRouter] ${reason} — proceeding. SpendControl still applied. Set TWZRD_FAIL_OPEN=false to refuse instead.`,
    );
    return undefined;
  }
  log.warn(`[ClawRouter] ${reason} — refusing the payment (TWZRD_FAIL_OPEN=false).`);
  return { abort: true, reason };
}

export async function defaultLoadTwzrdGate(): Promise<TwzrdGateModule> {
  // Variable specifier so tsup/esbuild cannot statically inline the optional dep
  // (the build uses noExternal: [/.*/]).
  const specifier: string = TWZRD_GATE_PACKAGE;
  return import(specifier) as Promise<TwzrdGateModule>;
}

/**
 * Compose TWZRD onto an x402 client that already has SpendControl registered.
 * Does nothing unless the opt-in flag is set. Never replaces SpendControl.
 */
export async function maybeComposeTwzrdAutoGate(
  x402: X402ClientLike,
  options?: {
    env?: NodeJS.ProcessEnv;
    loadGate?: LoadTwzrdGate;
    log?: Pick<Console, "log" | "warn">;
  },
): Promise<ComposeTwzrdAutoGateResult> {
  const env = options?.env ?? process.env;
  const log = options?.log ?? console;
  if (!isTwzrdAutoGateEnabled(env)) {
    return { status: "skipped" };
  }

  const load = options?.loadGate ?? defaultLoadTwzrdGate;
  let gate: TwzrdGateModule;
  try {
    gate = await load();
  } catch (err) {
    if (isMissingTwzrdGateModule(err)) {
      const reason = `${TWZRD_GATE_PACKAGE} is not installed`;
      log.warn(
        `[ClawRouter] TWZRD AutoGate opted in but ${reason} — skipping. npm i ${TWZRD_GATE_PACKAGE}@0.9.4`,
      );
      return { status: "unavailable", reason };
    }
    throw err;
  }

  const installOpts = twzrdAutoGateInstallOptions(env);
  const timeoutMs = twzrdGateTimeoutMs(env);
  const ready = (via: string) =>
    log.log(
      `[ClawRouter] TWZRD AutoGate ON (opt-in, after SpendControl, ${via}; ` +
        `${timeoutMs}ms budget, failOpen=${installOpts.failOpen}). ` +
        "Unset TWZRD_AUTO_GATE to disable.",
    );

  // Prefer the plain hook factory. installTwzrdAutoGate REPLACES
  // client.onBeforePaymentCreation with its own wrapper, so every hook
  // registered afterwards silently inherits a third-party kill switch
  // (TWZRD_AUTO_GATE=0 would then skip OUR hooks too), and its internal
  // registration leaves nowhere to bound the call. Registering the hook
  // ourselves keeps the client's registrar ours and the answer time-boxed.
  if (typeof gate.createTwzrdBeforePaymentHook === "function") {
    const hook = gate.createTwzrdBeforePaymentHook(installOpts);
    x402.onBeforePaymentCreation(async (ctx) =>
      runTwzrdGateWithTimeout(() => hook(ctx.selectedRequirements, ctx), {
        timeoutMs,
        failOpen: installOpts.failOpen,
        log,
      }),
    );
    ready("createTwzrdBeforePaymentHook");
    return { status: "composed", via: "createTwzrdBeforePaymentHook" };
  }

  if (typeof gate.installTwzrdAutoGate === "function") {
    gate.installTwzrdAutoGate(x402, installOpts);
    log.warn(
      "[ClawRouter] TWZRD AutoGate installed via installTwzrdAutoGate — that entry point " +
        "registers its own hook, so the timeout budget does not apply and it replaces " +
        "onBeforePaymentCreation on this client. Prefer a gate build exporting " +
        "createTwzrdBeforePaymentHook.",
    );
    ready("installTwzrdAutoGate");
    return { status: "composed", via: "installTwzrdAutoGate" };
  }

  throw new Error(
    `[ClawRouter] ${TWZRD_GATE_PACKAGE} is installed but exports neither installTwzrdAutoGate nor createTwzrdBeforePaymentHook`,
  );
}
