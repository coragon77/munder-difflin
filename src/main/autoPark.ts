/**
 * Auto-park (card agent-auto-park-idle-agents-th-2026-08-19).
 *
 * The auto-park rule used to exist only as prose in god's instructions, so it
 * ran when god remembered — and on the night this card was cut it did not:
 * an agent reported done at 18:25 and held a floor seat for ~4h. The standup
 * could not have caught it either: a standup SKIPS ITSELF while the floor is
 * quiet, and quiet is exactly the state idle agents accumulate in. So the
 * sweep lives in the ephemeral-worker watcher tick (index.ts) — the 1.5s
 * always-on loop that processes spawn/fire/vacation requests — which has NO
 * quiet predicate at all. On a fully quiet floor it keeps sweeping; that is
 * the state it exists for.
 *
 * THE EVIDENCE GATE (unweakened): idle time alone is NEVER sufficient — the
 * machine-readable done-report is the DONE CARD. The engagement's done report
 * the prose rule asks for IS the agent flipping its own card to 'done' through
 * the sanctioned primitive (after gates+merge+report, per the worker
 * integration contract); that flip is verifiable without the agent's
 * cooperation and without an LLM judging prose. Deliberately STRICTER than
 * the prose rule: ANY non-done assigned card blocks (an assigned todo is
 * god having just remembered this agent — parking it only to auto-recall it
 * on dispatch is churn, and an assigned-but-idle todo is the standup's
 * todo-unattended anomaly, god's call). A standby report WITHOUT a card has
 * no machine-readable form and stays god's manual judgment — an honest gap,
 * not a weakened gate.
 *
 * Everything ambiguous fails toward NOT parking: no telemetry row (cannot
 * prove idle — absence is not age), pending background work (waiting ≠ idle,
 * standup precedent), undrained inbox (a dispatch god already dropped may be
 * sitting in it). The mid-conversation-with-the-operator case is guarded by
 * the conjunction: an operator discussion produces telemetry while it runs,
 * so only a ≥1h TOTAL silence after the agent's last reply can fire — and
 * the pin flag plus parkAgentCore's refusal ladder (pinned, intern, god,
 * retired, busy) stand behind every park this module proposes.
 */

/** The prose rule's horizon: idle ≥ 1 hour. Telemetry age (hook/OTLP
 *  lastActive — the same primary signal the park busy gate uses) is the
 *  measure; an idle claude TUI repaints its chrome, so PTY output would read
 *  an idle pane as busy forever (vacation-busy-check-tui-repaint). */
export const AUTO_PARK_IDLE_MS = 60 * 60_000;

/** Sweep cadence — the tick fires every 1.5s; registry+tasks+telemetry reads
 *  once a minute are plenty for an hour-scale rule (GC_SWEEP_MS precedent). */
export const AUTO_PARK_SWEEP_MS = 60_000;

/** One agent as the sweep sees it — every field the decision needs, nothing
 *  the decision cannot use (registry flags + telemetry age + inbox backlog +
 *  pending background work + the agent's assigned cards). */
export interface AutoParkCandidate {
  id: string;
  role?: string;
  isGod?: boolean;
  pinned?: boolean;
  archived?: boolean;
  vacation?: boolean;
  retired?: boolean;
  /** ms since the agent's last telemetry event (tool call / inference).
   *  undefined = no telemetry row → cannot prove idle → never parked. */
  telemetryAgeMs?: number;
  /** Finite background work spawned from the current conversation. */
  pendingBackgroundWork?: number;
  /** Pending mail files in the agent's inbox. */
  inboxBacklog?: number;
  /** Every card in tasks.json assigned to this agent. */
  cards: { id?: string; status?: string }[];
}

/** A park the sweep wants to perform. */
export interface AutoParkDecision {
  id: string;
  /** The measured idle time — lands in the log/mail so god sees WHY. */
  idleMs: number;
  /** The done cards that constitute the positive evidence, named. */
  evidence: string;
}

/** Who gets auto-parked. Pure on purpose — the whole evidence gate is
 *  testable without Electron (vacationBusy precedent). */
export function autoParkDecisions(candidates: AutoParkCandidate[]): AutoParkDecision[] {
  const out: AutoParkDecision[] = [];
  for (const c of candidates) {
    // Registry eligibility — parkAgentCore re-refuses all of these; checking
    // here keeps the sweep from even proposing (and logging) a dead candidate.
    if (c.isGod) continue;
    if (c.role === 'intern') continue; // interns are FIRED, never parked
    if (c.pinned) continue; // the operator's standing "never park this one"
    if (c.archived || c.vacation || c.retired) continue; // off the floor
    // Idle ≥ 1h, PROVABLE: a telemetry row that old. No row = absence, and
    // absence is ambiguous (fresh spawn? no-plane provider?) — fail toward
    // not parking.
    if (typeof c.telemetryAgeMs !== 'number') continue;
    if (c.telemetryAgeMs < AUTO_PARK_IDLE_MS) continue;
    // Waiting ≠ idle: pending finite background work keeps the seat honest.
    if ((c.pendingBackgroundWork ?? 0) > 0) continue;
    // Inbox drained: pending mail may be work god already dispatched.
    if ((c.inboxBacklog ?? 0) > 0) continue;
    // POSITIVE DONE EVIDENCE — the gate. At least one done card, and not a
    // single non-done one (doing/blocked per the prose rule, todo as the
    // stricter churn guard above). A missing card list is no evidence.
    const cards = c.cards ?? [];
    if (cards.length === 0) continue;
    if (!cards.every((card) => card?.status === 'done')) continue;
    out.push({
      id: c.id,
      idleMs: c.telemetryAgeMs,
      evidence: cards.map((card) => card.id ?? '?').join(', '),
    });
  }
  return out;
}

/** The reason string that rides the park: names every gate input so the log
 *  line, the vacation-request trail and god's mail all say WHY and WHEN. */
export function autoParkReason(d: AutoParkDecision): string {
  return (
    `auto-park: idle ${Math.round(d.idleMs / 60_000)}m (no tool call or inference), ` +
    `all assigned cards done (${d.evidence}), inbox drained, no pending background work`
  );
}
