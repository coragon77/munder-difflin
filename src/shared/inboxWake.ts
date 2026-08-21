/**
 * Reconciler for the inbox-wake nudge (useHive effect #3, renderer).
 *
 * The old nudge was EDGE-TRIGGERED: it advanced a remembered `nudged` key at
 * ENQUEUE time and only reset it when the inbox read empty. A nudge can leave
 * the queue without ever reaching the agent's pane — three failed pty writes
 * (dead/mid-respawn pty), the user's clear-queue button, or delivered-but-
 * swallowed by a session transition ("Cause A": the pty write is ACKNOWLEDGED
 * yet the text is eaten). After any of those exits the mail is STILL in
 * inbox/ but `nudged` still matches the newest id, so the edge never re-fires
 * and the agent is silenced forever (57-minute incident, 2026-08-21).
 *
 * The fix is reconciler semantics: every 4s tick decides from OBSERVABLE
 * state — mail still in inbox/, a nudge sitting in the queue, or a nudge
 * DELIVERED (ack fired) within RENUDGE_TTL_MS. Nothing is remembered at
 * enqueue, so every unsafe exit self-heals on the next tick.
 */

/** How long a SUCCESSFULLY DELIVERED nudge suppresses re-nudging for the same
 * mail id. Past the TTL, mail still sitting unread in inbox/ means the nudge
 * was likely swallowed (Cause A — ack is NOT receipt) or ignored: re-nudge
 * the SAME id. A TTL re-nudge needs no fresh grace (the monitor already had
 * its head start when the id was first seen). */
export const RENUDGE_TTL_MS = 5 * 60_000;

/** A nudge whose delivery ACK has fired, keyed to the mail id it vouched for. */
export interface NudgeDelivery {
  id: string;
  /** wall-clock ms when the ack fired */
  at: number;
}

/** First-sighting of the newest actionable mail id — starts the per-provider
 * monitor head-start grace clock. */
export interface WakeSeen {
  id: string;
  since: number;
}

export interface InboxWakeInput {
  /** newest non-FYI inbox mail id, '' when the inbox is empty */
  newest: string;
  /** an inboxFor nudge is already sitting in this agent's queue */
  nudgeInQueue: boolean;
  /** per-provider monitor head start (0 for providers without a monitor) */
  graceMs: number;
  now: number;
  /** last nudge DELIVERED (ack fired) for this agent, if any */
  lastDelivery?: NudgeDelivery;
  /** first-seen tracking for the grace, keyed by mail id */
  wakeSeen?: WakeSeen;
  /** override for tests; defaults to RENUDGE_TTL_MS */
  ttlMs?: number;
}

export interface InboxWakeDecision {
  enqueue: boolean;
  /** persist as the agent's wakeSeen (undefined clears it) */
  wakeSeen?: WakeSeen;
  reason: 'empty' | 'recently-delivered' | 'grace' | 'in-flight' | 'unread';
}

export function decideInboxWake(input: InboxWakeInput): InboxWakeDecision {
  const ttl = input.ttlMs ?? RENUDGE_TTL_MS;
  if (!input.newest) return { enqueue: false, wakeSeen: undefined, reason: 'empty' };

  const lastDelivery = input.lastDelivery;
  // A nudge for THIS id was delivered recently: stay quiet. Past the TTL the
  // still-unread mail re-nudges — the ack may have been a swallow (Cause A).
  if (lastDelivery && lastDelivery.id === input.newest && input.now - lastDelivery.at < ttl) {
    return { enqueue: false, wakeSeen: input.wakeSeen, reason: 'recently-delivered' };
  }
  const fresh = !lastDelivery || lastDelivery.id !== input.newest;
  // Grace applies only to first-seen of a NEW id: the monitor-capable agent
  // gets its head start per mail id. A TTL re-nudge of an already-seen id
  // skips it (no fresh monitor wake to wait for).
  let wakeSeen = input.wakeSeen;
  if (fresh) {
    if (!wakeSeen || wakeSeen.id !== input.newest) {
      wakeSeen = { id: input.newest, since: input.now };
    }
    if (input.now - wakeSeen.since < input.graceMs) {
      return { enqueue: false, wakeSeen, reason: 'grace' };
    }
  }
  // ONE nudge in flight: its text is generic ("read your inbox") and covers
  // every unread message, so a second one would only duplicate the wake.
  if (input.nudgeInQueue) return { enqueue: false, wakeSeen, reason: 'in-flight' };
  return { enqueue: true, wakeSeen, reason: 'unread' };
}
