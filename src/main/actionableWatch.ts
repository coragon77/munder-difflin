/**
 * The actionable-card watch's pure core (card agent-actionable-card-watch-fi-
 * 2026-08-19), defect (B): god is event-driven but the board is state, and
 * nothing woke god when dispatchable cards appeared. This module is the
 * testable seam — the mission ARMS in src/main/index.ts (which the test
 * harness cannot load: it imports electron), so the transition logic lives
 * here and the arm stays thin glue: read the mission's reported set, diff
 * via newActionableIds, send via hive.send, persist the CURRENT set.
 *
 * Reuses the ONE predicate from ./actionableCards — never a second
 * definition (the caller passes its output in as `current`).
 */

/** Ids appearing in `current` that were absent from `prev` (the last-reported
 *  set). Empty result ⇒ nothing to say: no mail, no state write. `prev` is
 *  the CURRENT set as of the last change, so a card that left todo and
 *  returned counts as new again — correct, it is new work. */
export function newActionableIds(prev: string[] | undefined, current: string[]): string[] {
  const seen = new Set(prev ?? []);
  return current.filter((id) => !seen.has(id));
}

/** The mail body — names the new ids and the free-seat count, and says what
 *  an assigned-but-still-todo card means (the predicate fix's whole point).
 *  A nominated id also names its nominee (card agent-hive-dispatch-
 *  nomination-2026-08-19): the watch is exactly where an invisible
 *  nomination became a silent-steal path, so ownership is stated, not left
 *  for god to go look up. `nomineeById` is optional — omitted, ids render
 *  bare. */
export function actionableWatchBody(
  newIds: string[],
  freeSeats: number,
  nomineeById?: Record<string, string>,
): string {
  const plural = newIds.length === 1 ? '' : 's';
  const byId = nomineeById || {};
  const named = newIds.map((id) => (byId[id] ? `${id} (nominated: ${byId[id]})` : id)).join(', ');
  return (
    `Actionable-card watch: new dispatchable card${plural}: ${named}. ` +
    `Free floor seats: ${freeSeats}. ` +
    `A todo that already carries an assignee is nominated but never dispatched — ` +
    `hive-dispatch it (the only todo->doing path) or park it deliberately. ` +
    `Each id fires once; a card that leaves todo and returns re-fires.`
  );
}
