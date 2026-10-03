/**
 * Outcome memory: demote models that keep failing on a kind of request.
 *
 * The rate-limit and overload cooldowns forget a model after 15–60 seconds,
 * and nothing remembers a model that answers 200 with an empty turn, loops,
 * times out, or 5xxs on every tool-using request. Each of those costs the
 * caller a full attempt before the fallback chain moves on — on every request.
 *
 * This keeps the last few outcomes per (model, request kind) and moves a model
 * to the back of the chain while its recent failure rate is high. It is a hint,
 * not a filter: a demoted model is still tried if everything ahead of it fails,
 * entries expire so a recovered model gets its place back, and losing the
 * state (restart) only means routing starts cold.
 */

/** Coarse request kind. Tool-using turns fail differently from plain chat. */
export type RequestKind = "tools" | "chat";

type Outcome = { at: number; ok: boolean };

const WINDOW = 10; // outcomes kept per (model, kind)
const TTL_MS = 30 * 60_000; // outcomes older than this are forgotten
const MIN_FAILURES = 3; // never demote on fewer failures than this
const FAILURE_RATE = 0.5; // demote at or above this share of recent failures
const MAX_KEYS = 512; // bound memory: oldest key is evicted past this

const outcomes = new Map<string, Outcome[]>();

function key(model: string, kind: RequestKind): string {
  return `${model}|${kind}`;
}

function recent(k: string, now: number): Outcome[] {
  const list = outcomes.get(k);
  if (!list) return [];
  const live = list.filter((o) => now - o.at < TTL_MS);
  if (live.length === 0) outcomes.delete(k);
  else if (live.length !== list.length) outcomes.set(k, live);
  return live;
}

/** Record how one attempt on `model` went. */
export function recordOutcome(
  model: string,
  kind: RequestKind,
  ok: boolean,
  now = Date.now(),
): void {
  const k = key(model, kind);
  const list = recent(k, now);
  list.push({ at: now, ok });
  if (list.length > WINDOW) list.splice(0, list.length - WINDOW);
  // Re-insert so Map order tracks recency; evict the least recently touched.
  outcomes.delete(k);
  outcomes.set(k, list);
  if (outcomes.size > MAX_KEYS) {
    const oldest = outcomes.keys().next().value;
    if (oldest !== undefined) outcomes.delete(oldest);
  }
}

/** True while `model` has failed often enough on `kind` to be tried last. */
export function isUnreliable(model: string, kind: RequestKind, now = Date.now()): boolean {
  const list = recent(key(model, kind), now);
  const failures = list.filter((o) => !o.ok).length;
  return failures >= MIN_FAILURES && failures / list.length >= FAILURE_RATE;
}

/**
 * Move unreliable models behind the reliable ones, keeping order within each
 * group. `keep` (a user-pinned model) is never moved. If every model is
 * unreliable the chain is returned unchanged — there is nothing better to try.
 */
export function demoteUnreliable(
  models: string[],
  kind: RequestKind,
  keep?: string,
  now = Date.now(),
): { chain: string[]; demoted: string[] } {
  const reliable: string[] = [];
  const demoted: string[] = [];
  for (const m of models) {
    if (m !== keep && isUnreliable(m, kind, now)) demoted.push(m);
    else reliable.push(m);
  }
  if (reliable.length === 0) return { chain: models, demoted: [] };
  return { chain: [...reliable, ...demoted], demoted };
}

/** Test hook. */
export function resetOutcomeMemory(): void {
  outcomes.clear();
}
