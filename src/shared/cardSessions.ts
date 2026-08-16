// ─── card-session delivery staleness (card-session-stamp-never-fires-20260816)
// Shared between the main-process watcher (which MINTS the marker) and the
// renderer's queue-drain (which revalidates it at DELIVERY) — same pattern as
// the inbox nudge's inboxFor. A card-session action may park in a BUSY pane's
// queue for a long time; the card it was decided against can flip
// blocked/done/reassign underneath it. Re-decide against the CURRENT card
// before typing anything destructive into the pane.

/** What the watcher knew when it queued a card-session pane action. Minted by
 *  cardSessionDecisions, carried through realtime:enqueue → QueuedMessage. */
export interface CardSessionMarker {
  cardId: string;
  agentId: string;
  kind: 'clear' | 'resume' | 'adopt';
  /** The card.sessionId the action was decided against: the resume target, or
   *  the adopted conversation for an adopt lead. Undefined for a clear. */
  session?: string;
}

/** Structural card subset the validity check needs (main's CardLike shape). */
export interface CardSnapshotLike {
  id?: string;
  assignee?: string;
  status?: string;
  sessionId?: string;
}

/** True when a queued card-session action may still be delivered against the
 *  card's CURRENT state. False = stale, drop silently (the watcher re-fires on
 *  the next transition if the card still needs steering). */
export function cardSessionActionStillValid(
  card: CardSnapshotLike | undefined,
  marker: CardSessionMarker
): boolean {
  if (!card || card.status !== 'doing' || card.assignee !== marker.agentId) return false;
  if (marker.kind === 'clear' && card.sessionId) return false; // a conversation already started — a late clear would wipe it
  if (marker.kind !== 'clear' && marker.session && card.sessionId && card.sessionId !== marker.session) {
    return false; // re-stamped to a different conversation meanwhile
  }
  return true;
}
