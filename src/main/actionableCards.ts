/**
 * ONE definition of "actionable" (card agent-actionablecards-one-shar-
 * 2026-08-18): a card god could dispatch right now — status todo, not
 * paused:true, not blocked, no owner already on it. God is EVENT-driven
 * while the board is STATE; this predicate is how the state reaches god:
 *
 *   - HiveManager.rosterContext renders it into god's per-prompt injection
 *     (ACTIONABLE line), slim AND full;
 *   - `hive-card actionable` lists it on demand (god's CLI answer);
 *   - the hive-dispatch hold gate refuses the held slice (cardHeld) — the
 *     load-bearing twin (card agent-hive-dispatch-must-be-th-2026-08-18):
 *     if the lister and the gate ever disagree, the injection names a card
 *     the gate refuses, god learns to skim the line, and the feature is
 *     dead. test/actionable-cards.test.cjs pins the agreement by executing
 *     the REAL generated CLIs against this predicate's output.
 *
 * SELF-CONTAINED BY DESIGN: these functions have no imports and do not call
 * each other — hive.ts serializes them verbatim (Function.prototype
 * .toString) into the generated bin/ CLIs, so main process, gate and lister
 * run byte-identical code even through the bundler's renames. (depWaiting's
 * expression is inlined into actionableCards for exactly that reason; the
 * equality is pinned by test.) The TWO deliberate asymmetries, both pinned
 * by test: an OWNED todo is excluded here (someone is already on it) but
 * still gate-legal — `hive-card update --assignee` + dispatch is a
 * documented flow; a DEP-WAITING todo is excluded (correctly waiting) but
 * still gate-legal — a dependency is an engineering fact between cards, not
 * an operator hold, and early stake-a-claim dispatch stays god's call. Held
 * cards (paused / blocked) have ZERO asymmetry: excluded here, refused there.
 */

/** The operator's hold on a card: paused:true or status blocked. */
export function cardHeld(t: unknown): boolean {
  const c = t as { paused?: unknown; status?: unknown } | null;
  return !!c && typeof c === 'object' && (c.paused === true || c.status === 'blocked');
}

/** The paused half of cardHeld, split out for the standup (card
 *  agent-standup-must-not-nag-god-2026-08-19): detectors that already select
 *  on status need the paused question ALONE — blocked-unowned sees only
 *  blocked cards, where cardHeld is always true and would kill the detector
 *  outright. cardHeld keeps its own inline copy of this expression because it
 *  is serialized verbatim into the generated bin/ CLIs (no cross-calls);
 *  cardPaused is main-process-only and never serialized. */
export function cardPaused(t: unknown): boolean {
  const c = t as { paused?: unknown } | null;
  return !!c && typeof c === 'object' && c.paused === true;
}

/**
 * The standup's dep-waiting interpretation, promoted to the ONE shared
 * definition (card agent-actionablecards-fold-dep-2026-08-18): a dep is
 * satisfied only when its card is 'done'; anything else (todo/doing/blocked,
 * unknown dep id) keeps the card CORRECTLY WAITING. standup.ts imports THIS
 * — there is no second interpretation. Junk (non-array) dependsOn reads as
 * no deps rather than throwing: the injection must survive a corrupt ledger.
 */
export function depWaiting(t: unknown, statusById: Map<string, string>): boolean {
  const c = t as { dependsOn?: unknown } | null;
  const deps = Array.isArray(c?.dependsOn) ? (c!.dependsOn as string[]) : [];
  return deps.some((d) => statusById.get(d) !== 'done');
}

/** The single definition of actionable — ids of dispatchable, unowned todos. */
export function actionableCards(data: unknown): string[] {
  const list = (data as { tasks?: unknown } | null | undefined)?.tasks;
  if (!Array.isArray(list)) return [];
  // Statuses for the dep check — same shape the standup feeds depWaiting.
  const statusById = new Map<string, string>();
  const rows: Array<{
    id: string;
    status?: unknown;
    paused?: unknown;
    assignee?: unknown;
    dependsOn?: unknown;
  }> = [];
  for (const t of list) {
    const c = t as { id?: unknown } | null;
    if (!c || typeof c !== 'object' || typeof c.id !== 'string') continue;
    rows.push(c as never);
    statusById.set(c.id, (c as { status?: unknown }).status as string);
  }
  const ids: string[] = [];
  for (const c of rows) {
    if (c.status !== 'todo') continue; // blocked/doing/done are not backlog
    if (c.paused === true) continue; // operator hold
    if (typeof c.assignee === 'string' && c.assignee.trim() !== '') continue; // owned
    // Dep-waiting is CORRECTLY WAITING, not actionable — the same expression
    // as depWaiting() above, inlined because this function is serialized
    // verbatim into the generated bin/ CLIs (pinned equal by test).
    const deps = Array.isArray(c.dependsOn) ? (c.dependsOn as string[]) : [];
    if (deps.some((d) => statusById.get(d) !== 'done')) continue;
    ids.push(c.id);
  }
  return ids;
}

/**
 * The rendered line. INFORMATION, not an instruction (deliberate, agreed
 * with the operator): a plain fact god can act on or ignore — a per-turn
 * directive would fight the discuss-don't-act stance. Zero renders as
 * "ACTIONABLE: 0" and correctly disappears from attention. Ids cap at 3
 * then "+K more" — a backlog must not bloat the slim line. The cap is a
 * literal, not a shared const, ON PURPOSE: this function is serialized
 * verbatim (toString) into the generated bin/ CLIs and must not reference
 * anything outside itself (a const reference silently becomes undefined in
 * the CLI — the test caught exactly that).
 */
export function renderActionableLine(ids: string[]): string {
  const cap = 3;
  const shown = ids.slice(0, cap).join(', ');
  const more = ids.length > cap ? ` (+${ids.length - cap} more)` : '';
  const named = shown ? ` - ${shown}` : '';
  return `ACTIONABLE: ${ids.length}${named}${more}`;
}
