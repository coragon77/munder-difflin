/** Floor departures — the pure half of the walk-out animation
 *  (card floor-departure-animation-20260816).
 *
 *  The roster row flips or disappears the moment the backend parks, fires or
 *  archives an agent, so the floor renderer detects the transition by diffing
 *  store snapshots and keeps a ghost sprite playing the walk to the door. This
 *  module holds only the diff logic and the bubble pools; OfficeFloor owns the
 *  sprites.
 */

/** The three departures that walk out through the bottom door. */
export type DepartureKind = 'vacation' | 'fired' | 'archive';

export interface Departure {
  id: string;
  kind: DepartureKind;
}

/** What a departing agent mutters on the way out, per departure kind.
 *  Seed lines are the operator-approved ones; the rest are variants. */
export const DEPARTURE_THOUGHTS: Record<DepartureKind, readonly string[]> = {
  vacation: [
    'Looking forward to that vacation',
    'see you in two weeks! 🏖️',
    'out-of-office: ON',
    "don't miss me too much",
  ],
  fired: [
    'I hope they hire me for real next time',
    'does this count as work experience?',
    'cleaning out my desk… it was never mine',
    "I'll put this on my résumé",
  ],
  archive: [
    'Moving on to new things',
    "it's been a good run",
    'last one out turns off the monitor',
    'off to bigger desks',
  ],
};

/** Minimal store shape the diff needs — structural, so tests can pass plain
 *  objects and OfficeFloor can pass store snapshots directly. */
export interface DepartureSnapshot {
  agents: ReadonlyArray<{ id: string }>;
  archivedAgents: ReadonlyArray<{ id: string; vacation?: boolean }>;
  restorableAgents: ReadonlyArray<{ id: string }>;
}

/** Which vanished roster rows are departures, and of what kind. An agent
 *  leaving `agents` is a departure UNLESS it landed in restorableAgents —
 *  that is a dead-PTY reconcile (crash/session end), which keeps the plain
 *  fade-out rather than a staged walk to the door.
 *
 *  Kind comes from where the row landed: vacation flag → parked on the
 *  VACATION shelf, unflagged archived copy → plain archive, gone from every
 *  list → fired (interns drop off entirely, no archived copy is kept). */
export function detectDepartures(prev: DepartureSnapshot, next: DepartureSnapshot): Departure[] {
  const out: Departure[] = [];
  for (const { id } of prev.agents) {
    if (next.agents.some((a) => a.id === id)) continue;
    const archived = next.archivedAgents.find((a) => a.id === id);
    if (archived) {
      out.push({ id, kind: archived.vacation ? 'vacation' : 'archive' });
    } else if (!next.restorableAgents.some((a) => a.id === id)) {
      out.push({ id, kind: 'fired' });
    }
  }
  return out;
}
