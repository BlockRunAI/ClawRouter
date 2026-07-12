/**
 * Optional TWZRD x402 pre-sign gate for ClawRouter.
 *
 * When enabled, registers TWZRD as `onBeforePaymentCreation` on the official
 * x402 client so each payment is scored against the **exact** selected
 * requirement (payTo / network / amount / resource) after the client chooses
 * it and **before** payload construction / wallet signing.
 *
 * Why this seat (not a probe-then-shell wrapper):
 *   probe request → score challenge A → second request → may sign challenge B
 * is a TOCTOU / challenge-swap gap. Lifecycle hooks bind the decision to the
 * same selectedRequirements the client is about to sign.
 *
 * Opt-in only — default ClawRouter behavior is unchanged.
 * Requires optional peer dep: `twzrd-x402-gate` (dynamic import).
 *
 * @see https://docs.x402.org/advanced-concepts/lifecycle-hooks
 * @see https://www.npmjs.com/package/twzrd-x402-gate
 * @see https://intel.twzrd.xyz
 */

/**
 * Minimal x402 client surface. Kept intentionally loose so it is assignable
 * from official `@x402/fetch` / `@x402/core` x402Client without depending on
 * exact hook return variance across SDK versions.
 */
export type TwzrdGateX402Client = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onBeforePaymentCreation: (hook: (...args: any[]) => any) => any;
};

export type InstallTwzrdPaymentGateResult =
  | { installed: true; mode: "decision-only" | "strict-can-spend" }
  | {
      installed: false;
      reason: "disabled" | "package-missing" | "import-error";
      detail?: string;
    };

export type TwzrdGateLoader = () => Promise<{
  installTwzrdX402ClientHook: (
    client: TwzrdGateX402Client,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    opts?: any,
  ) => unknown;
}>;

/**
 * True when CLAWROUTER_TWZRD / CLAWROUTER_TWZRD_ENABLED is set to a truthy flag.
 * Accepts: 1, true, yes, on (case-insensitive). Default: disabled.
 */
export function isTwzrdPaymentGateEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = (env.CLAWROUTER_TWZRD ?? env.CLAWROUTER_TWZRD_ENABLED ?? "")
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * Strict can_spend gating is a second opt-in (default decision-only):
 * only an explicit decision=block (and wash refuse) abort payments.
 * Set CLAWROUTER_TWZRD_GATE_ON_CAN_SPEND=1 (or TWZRD_GATE_ON_CAN_SPEND) for strict.
 */
export function isTwzrdGateOnCanSpend(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = (
    env.CLAWROUTER_TWZRD_GATE_ON_CAN_SPEND ??
    env.TWZRD_GATE_ON_CAN_SPEND ??
    ""
  )
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function resolveAttribution(
  env: NodeJS.ProcessEnv,
): { integration: string; runId: string } | undefined {
  const integration = env.TWZRD_ATTRIBUTION_INTEGRATION?.trim() || "clawrouter";
  const runId =
    env.TWZRD_ATTRIBUTION_RUN_ID?.trim() ||
    env.CLAWROUTER_TWZRD_RUN_ID?.trim() ||
    `clawrouter-${process.pid}`;
  if (!integration || !runId) return undefined;
  return { integration, runId };
}

/**
 * Install TWZRD onBeforePaymentCreation if env-enabled.
 * Safe no-op when disabled; logs and continues when package is absent.
 */
export async function maybeInstallTwzrdPaymentGate(
  client: TwzrdGateX402Client,
  options?: {
    env?: NodeJS.ProcessEnv;
    /** Override dynamic import (tests). */
    loadGate?: TwzrdGateLoader;
    log?: (msg: string) => void;
  },
): Promise<InstallTwzrdPaymentGateResult> {
  const env = options?.env ?? process.env;
  const log = options?.log ?? ((msg: string) => console.log(msg));

  if (!isTwzrdPaymentGateEnabled(env)) {
    return { installed: false, reason: "disabled" };
  }

  const gateOnCanSpend = isTwzrdGateOnCanSpend(env);
  const mode = gateOnCanSpend ? "strict-can-spend" : "decision-only";

  let installTwzrdX402ClientHook: (
    client: TwzrdGateX402Client,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    opts?: any,
  ) => unknown;

  try {
    if (options?.loadGate) {
      ({ installTwzrdX402ClientHook } = await options.loadGate());
    } else {
      // Optional peer — not bundled. Users: npm i twzrd-x402-gate
      // Ambient types in twzrd-x402-gate.d.ts (package may be absent at compile).
      const mod = await import("twzrd-x402-gate");
      installTwzrdX402ClientHook = mod.installTwzrdX402ClientHook;
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (
      detail.includes("Cannot find package") ||
      detail.includes("Cannot find module") ||
      detail.includes("ERR_MODULE_NOT_FOUND")
    ) {
      log(
        "[ClawRouter] CLAWROUTER_TWZRD is set but twzrd-x402-gate is not installed. " +
          "Run: npm i twzrd-x402-gate  (peer optional). Continuing without pre-sign gate.",
      );
      return { installed: false, reason: "package-missing", detail };
    }
    log(`[ClawRouter] TWZRD payment gate import failed: ${detail.slice(0, 200)}`);
    return { installed: false, reason: "import-error", detail };
  }

  const attribution = resolveAttribution(env);

  installTwzrdX402ClientHook(client, {
    // Decision-only default: decision=block + wash_flagged refuse.
    // Strict can_spend is a second opt-in (see isTwzrdGateOnCanSpend).
    gateOnCanSpend,
    refuseWashFlagged: true,
    attribution,
    onDecision: (detail: {
      approved: boolean;
      reason: string;
      verdict: string;
      payTo?: string;
      network?: string;
      amountMicro?: string;
    }) => {
      const pay = detail.payTo ?? "unknown";
      const net = detail.network ?? "unknown";
      const amt = detail.amountMicro
        ? `$${(Number(detail.amountMicro) / 1_000_000).toFixed(6)}`
        : "?";
      if (detail.approved) {
        log(
          `[ClawRouter] TWZRD pre-sign allow (${detail.verdict}) payTo=${pay} network=${net} ${amt}`,
        );
      } else {
        log(
          `[ClawRouter] TWZRD pre-sign BLOCK (${detail.reason}) payTo=${pay} network=${net} ${amt}`,
        );
      }
    },
  });

  log(
    `[ClawRouter] TWZRD x402 pre-sign gate ON (${mode}` +
      (attribution
        ? `, attribution=${attribution.integration}/${attribution.runId}`
        : "") +
      "). Scores selectedRequirements before wallet sign.",
  );

  return { installed: true, mode };
}
