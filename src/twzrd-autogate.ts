/**
 * Opt-in TWZRD AutoGate on an x402 client (#355).
 *
 * Default OFF. Set TWZRD_AUTO_GATE=1 (or "true"/"on") to compose
 * `installTwzrdAutoGate` into the existing onBeforePaymentCreation chain
 * AFTER SpendControl. This is not a re-open of default-on #218.
 *
 * Missing `twzrd-x402-gate` with the env set: warn and continue (fail open).
 * Any other load/register error: throw (fail closed — do not boot unguarded
 * after the operator asked for the gate).
 */
export type X402ClientLike = {
  onBeforePaymentCreation: (...args: never[]) => unknown;
};

export type TwzrdAutoGateOutcome = "skipped" | "missing" | "installed";

export type GateModule = {
  installTwzrdAutoGate: (client: unknown, options?: unknown) => unknown;
};

export type MaybeInstallTwzrdAutoGateDeps = {
  /** Injectable for tests. Default: dynamic import("twzrd-x402-gate"). */
  loadGate?: () => Promise<GateModule>;
};

/** True only for an explicit opt-in. Unset / 0 / false / off → skipped. */
export function isTwzrdAutoGateRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.TWZRD_AUTO_GATE ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on";
}

/** Soft-skip only when the absent package is twzrd-x402-gate itself. */
export function isTwzrdGateSoftSkip(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  const msg = err instanceof Error ? err.message : String(err);
  const missingModule =
    code === "ERR_MODULE_NOT_FOUND" ||
    code === "MODULE_NOT_FOUND" ||
    /Cannot find module/i.test(msg) ||
    /Cannot find package/i.test(msg);
  return Boolean(missingModule && /['"]twzrd-x402-gate['"]/i.test(msg));
}

async function defaultLoadGate(): Promise<GateModule> {
  return import("twzrd-x402-gate") as Promise<GateModule>;
}

export async function maybeInstallTwzrdAutoGate(
  client: X402ClientLike,
  deps: MaybeInstallTwzrdAutoGateDeps = {},
): Promise<TwzrdAutoGateOutcome> {
  if (!isTwzrdAutoGateRequested()) {
    return "skipped";
  }
  let gate: GateModule;
  try {
    gate = await (deps.loadGate ?? defaultLoadGate)();
  } catch (err) {
    if (isTwzrdGateSoftSkip(err)) {
      console.warn(
        "[ClawRouter] TWZRD_AUTO_GATE=1 but twzrd-x402-gate is not installed — payments unguarded. npm i twzrd-x402-gate@0.9.3",
      );
      return "missing";
    }
    throw err;
  }
  gate.installTwzrdAutoGate(client, {
    refuseWashFlagged: true,
    gateOnCanSpend: false,
    unsupportedNetworkMode: "observe",
    attribution: {
      integration: "clawrouter",
      runId: process.env.TWZRD_RUN_ID || "clawrouter",
    },
  });
  console.log("[ClawRouter] TWZRD AutoGate ON (opt-in). Kill: unset TWZRD_AUTO_GATE");
  return "installed";
}
