/**
 * The pending-background-work census for the house busy signal (card
 * agent-harness-busy-signal-coun-2026-08-17).
 *
 * WHERE THE CENSUS COMES FROM: claude's own Stop hook payload carries
 * `background_tasks` — a live snapshot of its task registry, already filtered
 * upstream to running+backgrounded entries (types seen in 2.1.x: shell,
 * subagent, workflow, monitor, MCP task, teammate, dream, auto-mode scan,
 * cloud session). Every settle refreshes the census, which is exactly the
 * moment the idle gates (park, card-session clear) evaluate — an agent idle
 * at the prompt but waiting on a CI monitor reads busy, not idle.
 *
 * MONITORS NEVER COUNT (card agent-harness-fix-the-staging--2026-08-20):
 * recordSettle skips background_tasks entries of type 'monitor' outright.
 * Monitors are PROCESS-scoped — they survive compaction and in-place /clear —
 * while any arm-time bookkeeping is conversation-scoped: the old by-taskId
 * exclusion died at every SessionStart(compact/clear) while the monitors
 * lived on, so each orphaned monitor counted as pending finite work forever,
 * the busy signal wedged, and both delivery gates closed (six timeout
 * releases in one day; Stanley's pane verified with 2 live orphaned monitor
 * processes). Completion wakes the agent regardless, so "waiting ≠ idle"
 * never needed monitors in the census; the cost of skipping them is that an
 * agent idle-waiting on a FINITE monitor can be cleared/parked mid-wait —
 * rare, and the event still fires into whatever conversation is live.
 * `session_crons` (recurring wakeups) are the same never-completing class
 * and are never counted. Anything else the harness cannot classify COUNTS —
 * the safe direction: a deferred clear costs minutes, a fired one costs a
 * context.
 *
 * STALENESS: the census is a snapshot from the last settle. Work that dies
 * WITHOUT waking the agent (a background shell killed by its timeout)
 * produces no new Stop, so the snapshot could wedge the gates forever. TTL bounds it:
 * claude's 1h ceiling for timed background tasks (3600000ms, MonitorInput
 * schema — monitors themselves never count) leaves 75min covering every
 * finite task with margin. Work whose
 * completion DOES wake the agent self-heals — the wake produces activity, the
 * re-settle produces a fresh census.
 *
 * In-memory by design (vacationBusy precedent): a restart kills every PTY and
 * with it every session's background work; new sessions arm fresh monitors
 * whose PostToolUse re-populates the persistent set within minutes.
 */

/** Finite background work cannot outlive claude's 1h monitor timeout ceiling;
 *  +15min margin. A census older than this reads idle again. */
export const PENDING_CENSUS_TTL_MS = 75 * 60_000;

export class PendingWorkTracker {
  private settle = new Map<string, { count: number; ts: number }>();
  /** Persistent-monitor arm ids — NO LONGER the census exclusion (monitors
   *  are skipped by type at settle time; that session-scoped set wedged the
   *  floor when SessionStart wiped it while process-scoped monitors lived
   *  on). Its surviving consumer is the rearm-aware nudge (hooks.ts
   *  nudgeRearmFor): "has a persistent arm been seen since this session
   *  began" — session-scoped on purpose there. */
  private persistentMonitorIds = new Map<string, Set<string>>();

  constructor(private now: () => number = Date.now) {}

  /** PostToolUse(Monitor): classify one monitor task by its arm-time
   *  persistent flag (tool_response.taskId + tool_response.persistent).
   *  Feeds the rearm-aware nudge only (see persistentMonitorIds). */
  recordMonitorArm(agentId: string, taskId: unknown, persistent: boolean): void {
    if (typeof taskId !== 'string' || !taskId) return;
    let ids = this.persistentMonitorIds.get(agentId);
    if (!ids) {
      ids = new Set();
      this.persistentMonitorIds.set(agentId, ids);
    }
    if (persistent) ids.add(taskId);
    else ids.delete(taskId);
  }

  /** True when a persistent monitor arm has been seen since the CURRENT
   *  session began — SessionStart/End wipe the set (resetAgent) and a rearm
   *  repopulates it, so this is the session-scoped half of the rearm-aware
   *  nudge condition (card agent-harness-owned-wake-rearm-2026-08-19). */
  hasPersistentMonitor(agentId: string): boolean {
    return (this.persistentMonitorIds.get(agentId)?.size ?? 0) > 0;
  }

  /** Stop: record the live background-task snapshot as this agent's census.
   *  Shape per claude 2.1.x Kjp(): {id, type, status, description, …}.
   *  MONITORS NEVER COUNT — skipped by type (see the module header). */
  recordSettle(agentId: string, backgroundTasks: unknown): void {
    let count = 0;
    if (Array.isArray(backgroundTasks)) {
      for (const t of backgroundTasks) {
        if (t && typeof t === 'object' && (t as { type?: unknown }).type === 'monitor') continue;
        count++; // unclassifiable/shapeless entries count — the safe direction
      }
    }
    this.settle.set(agentId, { count, ts: this.now() });
  }

  /** The agent's pending finite background-work count (0 when absent or
   *  TTL-expired — expired reads idle, see the staleness note above). */
  countFor(agentId: string): number {
    const s = this.settle.get(agentId);
    if (!s) return 0;
    if (this.now() - s.ts > PENDING_CENSUS_TTL_MS) return 0;
    return s.count;
  }

  /** SessionStart/SessionEnd: a fresh conversation inherits no stale census,
   *  and the arm-id set resets so the rearm-aware nudge fires until the new
   *  session's own arm is seen. (The census no longer depends on this wipe —
   *  monitors are skipped by type — which is exactly what un-wedges it.) */
  resetAgent(agentId: string): void {
    this.settle.delete(agentId);
    this.persistentMonitorIds.delete(agentId);
  }
}
