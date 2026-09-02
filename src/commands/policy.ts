/**
 * /policy command — operator surface for SpendControl limits and counterparty lists.
 *
 * One implementation behind two entry points: the `clawrouter policy` CLI and
 * the OpenClaw `/policy` plugin command both call runPolicyCommand(), so the
 * validation lives in exactly one place. Fail-closed on input: every argument
 * is validated before anything is written, and a rejected argument writes
 * nothing. (Membership checks for `remove` need the current list, so they run
 * after a read-only open.)
 *
 * This edits spending.json. The proxy reads limits once, in the SpendControl
 * constructor, so a change takes effect on its next start.
 */
import type {
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
  PluginCommandResult,
} from "../types.js";
import {
  CAIP2_BASE,
  CAIP2_SOLANA_MAINNET,
  PAYABLE_NETWORKS,
  POLICY_LISTS,
  SpendControl,
  normalizePayee,
  type PolicyList,
  type SpendLimits,
  type SpendWindow,
} from "../spend-control.js";

const SPEND_WINDOWS: readonly SpendWindow[] = ["perRequest", "hourly", "daily", "session"];
/** Strict decimal: "5abc" and "1e3" are rejected, not truncated the way parseFloat would. */
const USD = /^\d+(\.\d+)?$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const LIST_ACTIONS = ["set", "add", "remove", "clear"] as const;
type ListAction = (typeof LIST_ACTIONS)[number];
const ALLOW_LISTS: readonly PolicyList[] = ["allowedPayees", "allowedNetworks", "allowedAssets"];

/**
 * What an unset key means for the guard. `check()` treats an absent or empty
 * allow-list as "no policy", so unsetting one is the loosest possible state —
 * every write that gets there has to say so in its first line, and the show
 * output must not render it like a list that was never configured.
 */
function unsetMeaning(key: PolicyList | SpendWindow): string {
  switch (key) {
    case "allowedPayees":
      return "every payee is permitted";
    case "allowedNetworks":
      return "every network is permitted";
    case "allowedAssets":
      return "every asset is permitted";
    case "blockedPayees":
      return "no payee is blocked";
    default:
      return `spend in the ${key} window is uncapped`;
  }
}

const USAGE = [
  "Usage:",
  "  policy                                 show limits and lists on disk",
  `  policy set|add|remove <list> <v>...    <list>: ${POLICY_LISTS.join(" | ")}`,
  "  policy clear <list>",
  `  policy limit <window> <usd>|clear      <window>: ${SPEND_WINDOWS.join(" | ")}`,
  `Networks are CAIP-2 ids: ${CAIP2_BASE} (Base) or ${CAIP2_SOLANA_MAINNET} (Solana mainnet).`,
].join("\n");
/**
 * Without a handle on the running proxy's SpendControl this command can only
 * edit spending.json, which the proxy reads once at startup. That must be the
 * FIRST thing an operator reads — blocking a draining payee mid-incident and
 * seeing "blockedPayees: [...]" while the live signer keeps paying it is the
 * wrong failure mode.
 */
const RESTART_REQUIRED =
  "NOT applied to a running proxy — it reads spending.json once at startup. Restart the proxy (or the OpenClaw gateway) for this to take effect.";
const APPLIED_LIVE = "Applied to the running proxy and saved to spending.json.";

type Plan =
  | { kind: "show" }
  | { kind: "limit"; window: SpendWindow; usd: number | undefined }
  | { kind: "list"; action: ListAction; list: PolicyList; values: string[] };

export interface PolicyCommandOptions {
  /** Fresh store from disk. Used for writes when no live instance is available, and always for the write-landed check. */
  openControl?: () => SpendControl;
  /**
   * The SpendControl the running proxy signs against, if this process has
   * one. Writes mutate it directly and persist through it, so the live
   * signer enforces the change with no restart.
   */
  liveControl?: () => SpendControl | undefined;
}

function fail(text: string): PluginCommandResult {
  return { text, isError: true };
}

function isPolicyList(v: string): v is PolicyList {
  return (POLICY_LISTS as readonly string[]).includes(v);
}

function isSpendWindow(v: string): v is SpendWindow {
  return (SPEND_WINDOWS as readonly string[]).includes(v);
}

function isListAction(v: string): v is ListAction {
  return (LIST_ACTIONS as readonly string[]).includes(v);
}

/** Why `value` must not enter `list`, or undefined when it may. */
function rejectValue(list: PolicyList, value: string): string | undefined {
  if (list === "allowedNetworks") {
    return PAYABLE_NETWORKS.includes(value)
      ? undefined
      : `"${value}" is not a network the proxy can pay on — allowedNetworks accepts only ${CAIP2_BASE} (Base) or ${CAIP2_SOLANA_MAINNET} (Solana mainnet), not a nickname. Other CAIP-2 ids are well formed but cannot appear in a payment quote, so allowlisting one would only block payments`;
  }
  if (/^0x/i.test(value) && !EVM_ADDRESS.test(value)) {
    return `"${value}" starts with 0x but is not 0x followed by exactly 40 hex characters`;
  }
  return undefined;
}

/** Turn argv into a plan or a rejection. Pure: nothing is read or written here. */
function parsePolicyArgs(argv: readonly string[]): Plan | PluginCommandResult {
  const [sub = "", target = "", ...values] = argv;
  const action = sub.toLowerCase();
  if (action === "") return { kind: "show" };

  if (action === "limit") {
    if (!isSpendWindow(target)) {
      return fail(
        `Unknown window "${target}"; expected one of: ${SPEND_WINDOWS.join(", ")}\n${USAGE}`,
      );
    }
    const raw = values[0];
    if (raw === undefined || values.length !== 1) {
      return fail(`policy limit takes exactly one amount (or "clear")\n${USAGE}`);
    }
    if (raw === "clear") return { kind: "limit", window: target, usd: undefined };
    const usd = Number(raw);
    if (!USD.test(raw) || !Number.isFinite(usd) || usd <= 0) {
      return fail(
        `Rejected amount "${raw}": must be a positive decimal USD value such as 0.10 or 5`,
      );
    }
    return { kind: "limit", window: target, usd };
  }

  if (!isListAction(action)) return fail(`Unknown subcommand "${sub}"\n${USAGE}`);
  if (!isPolicyList(target)) {
    return fail(`Unknown list "${target}"; expected one of: ${POLICY_LISTS.join(", ")}\n${USAGE}`);
  }
  if (action === "clear" ? values.length !== 0 : values.length === 0) {
    return fail(
      `policy ${action} <list> ${action === "clear" ? "takes no values" : "needs at least one value"}\n${USAGE}`,
    );
  }
  for (const v of values) {
    const why = rejectValue(target, v);
    if (why !== undefined) return fail(`Rejected ${target} entry: ${why}`);
  }
  return { kind: "list", action, list: target, values };
}

/** The value `plan.list` must hold afterwards (undefined = not configured), or a rejection. */
function nextListValue(
  current: string[] | undefined,
  plan: Extract<Plan, { kind: "list" }>,
): { next: string[] | undefined } | { reject: string } {
  const have = current ?? [];
  // normalizePayee lowercases EVM addresses so "0xAbC…" and "0xabc…" dedupe; it is a no-op on CAIP-2 ids.
  const wanted = [...new Set(plan.values.map(normalizePayee))];
  switch (plan.action) {
    case "set":
      return { next: wanted };
    case "clear":
      return { next: undefined };
    case "add":
      return { next: [...new Set([...have, ...wanted])] };
    case "remove": {
      if (have.length === 0) return { reject: `${plan.list} is not configured; nothing to remove` };
      const missing = wanted.filter((v) => !have.includes(v));
      if (missing.length > 0) return { reject: `not in ${plan.list}: ${missing.join(", ")}` };
      const next = have.filter((v) => !wanted.includes(v));
      if (next.length === 0 && ALLOW_LISTS.includes(plan.list)) {
        // check() gates on presence AND length, so an emptied allow-list is
        // not "allow nothing" — it is "allow everything". A remove must never
        // flip the guard off as a side effect; unsetting is an explicit clear.
        return {
          reject: `removing the last ${plan.list} entry would unset the list, and then ${unsetMeaning(plan.list)}. Use "policy clear ${plan.list}" if that is what you want`,
        };
      }
      // An emptied blockedPayees routes to clearPolicy(): setPolicy([]) throws by design.
      return { next: next.length > 0 ? next : undefined };
    }
  }
}

function formatPolicy(limits: SpendLimits): string {
  const lines = ["Spend limits (USD):"];
  for (const w of SPEND_WINDOWS) {
    const v = limits[w];
    lines.push(`  ${w}: ${v === undefined ? `(unset — ${unsetMeaning(w)})` : `$${v}`}`);
  }
  lines.push("Policy lists:");
  for (const l of POLICY_LISTS) {
    const v = limits[l];
    lines.push(`  ${l}: ${v && v.length > 0 ? v.join(", ") : `(unset — ${unsetMeaning(l)})`}`);
  }
  return lines.join("\n");
}

export function runPolicyCommand(
  argv: readonly string[],
  options?: PolicyCommandOptions,
): PluginCommandResult {
  const plan = parsePolicyArgs(argv);
  if (!("kind" in plan)) return plan;

  const openControl = options?.openControl ?? (() => new SpendControl());
  const live = options?.liveControl?.();
  const control = live ?? openControl();
  const broken = control.getPolicyFileError();
  if (broken !== undefined) {
    return fail(`${broken}\nNothing was written; repair or delete spending.json, then retry.`);
  }
  if (plan.kind === "show") return { text: formatPolicy(control.getLimits()) };
  // What disk held before this write — the baseline the landed-check compares
  // every key against, not just the one being changed.
  const before = openControl().getLimits();

  const key: PolicyList | SpendWindow = plan.kind === "limit" ? plan.window : plan.list;
  let expected: number | string[] | undefined;
  try {
    if (plan.kind === "limit") {
      expected = plan.usd;
      if (plan.usd === undefined) control.clearLimit(plan.window);
      else control.setLimit(plan.window, plan.usd);
    } else {
      const outcome = nextListValue(control.getLimits()[plan.list], plan);
      if ("reject" in outcome) return fail(`${outcome.reject}; nothing written`);
      expected = outcome.next;
      if (outcome.next === undefined) control.clearPolicy(plan.list);
      else control.setPolicy(plan.list, outcome.next);
    }
  } catch (err) {
    return fail(`Nothing was written: ${err instanceof Error ? err.message : String(err)}`);
  }

  // FileSpendControlStorage.save() logs and swallows write failures, so a setter
  // returning is not proof of persistence. Re-open the store and compare EVERY
  // key against disk-before-write plus the one change: a limits write is a
  // whole-object replace, so an instance holding a stale copy (a CLI opened
  // before another edit landed, or a proxy that never re-reads) silently drops
  // sibling keys. Surface that rather than report success.
  const expectedAll = { ...before } as Record<string, unknown>;
  if (expected === undefined) delete expectedAll[key];
  else expectedAll[key] = expected;
  const after = openControl().getLimits() as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after), key])];
  const drift = keys.filter((k) => JSON.stringify(after[k]) !== JSON.stringify(expectedAll[k]));
  if (drift.length > 0) {
    const show = (v: unknown) => (v === undefined ? "(unset)" : JSON.stringify(v));
    const detail = drift.map((k) => `${k} ${show(after[k])} vs ${show(expectedAll[k])}`).join("; ");
    return fail(
      `Write did not land cleanly — on disk vs expected: ${detail}. Another write may have raced this one; run "policy" to see what disk holds now`,
    );
  }
  const headline =
    expected === undefined
      ? `${key} is now unset — ${unsetMeaning(key)}.`
      : `${key}: ${JSON.stringify(expected)}`;
  return {
    text: live ? `${headline}\n${APPLIED_LIVE}` : `${RESTART_REQUIRED}\n${headline}`,
  };
}

export function createPolicyCommand(
  options?: PolicyCommandOptions,
): OpenClawPluginCommandDefinition {
  return {
    name: "policy",
    description:
      "Spend limits and counterparty policy — /policy [set|add|remove|clear <list> ...] [limit <window> <usd>|clear]",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: PluginCommandContext) =>
      runPolicyCommand((ctx.args ?? "").trim().split(/\s+/).filter(Boolean), options),
  };
}
