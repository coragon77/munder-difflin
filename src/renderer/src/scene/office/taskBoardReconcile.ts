/**
 * Pixi-free task-board projection/reconciliation, kept separate so the focused
 * Node harness can pin the renderer's ledger-sync rules without building a scene.
 */

export const TASK_BOARD_RESYNC_EVENT = 'cth:resync-task-boards';

export interface BoardTask {
  status: string;
  assignee?: string;
}

export interface LedgerTask extends BoardTask {
  id: string;
}

/** Project ledger cards into the renderer-local board shape. */
export function taskBoardFromLedger(ledger: LedgerTask[]): Map<string, BoardTask> {
  return new Map(ledger.map((task) => [task.id, { status: task.status, assignee: task.assignee }]));
}

/** Restore ledger truth only after all queued/active board choreography lands. */
export function reconcileTaskBoard(
  current: Map<string, BoardTask>,
  ledger: LedgerTask[],
  movesInFlight: boolean,
): Map<string, BoardTask> {
  if (movesInFlight) return current;
  const expected = taskBoardFromLedger(ledger);
  const matchesLedger =
    current.size === expected.size &&
    [...expected].every(
      ([id, task]) =>
        current.get(id)?.status === task.status && current.get(id)?.assignee === task.assignee,
    );
  return matchesLedger ? current : expected;
}

/**
 * May this actor be CHOREOGRAPHED for a card move (walk to the boards), or
 * must the board update instantly instead?
 *
 * Only free-to-move agents walk: a busy one (mid-turn, thinking, compacting,
 * breaker-pinned, or waiting on the human at the door) must not leave its desk
 * for theatre — its body belongs to its work. Without this guard a dispatch
 * fan-out marches god (pinner of every new card) plus every assignee to the
 * board stands at once, and the floor reads "working agents standing around
 * the top of the map while every desk sits empty" (card
 * agent-floor-status-out-of-sync-2026-08-18).
 */
export function canChoreograph(status: string | undefined): boolean {
  return status === 'idle' || status === 'waiting' || status === 'success';
}
