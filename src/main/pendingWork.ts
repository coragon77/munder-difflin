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
 * PERSISTENT EXCLUSION: never-completing monitors (the inbox-wake loop every
 * agent arms) would make the whole floor permanently busy, so they are
 * excluded by taskId, learned at arm time from PostToolUse(Monitor).
 * tool_response ({taskId, persistent}). `session_crons` (recurring wakeups)
 * are the same never-completing class and are never counted. Anything the
 * harness cannot classify COUNTS — the safe direction: a deferred clear costs
 * minutes, a fired one costs a context.
 *
 * STALENESS: the census is a snapshot from the last settle. Work that dies
 * WITHOUT waking the agent (a monitor killed by its timeout) produces no new
 * Stop, so the snapshot could wedge the gates forever. TTL bounds it: finite
 * monitors max out at claude's 1h timeout ceiling (3600000ms, MonitorInput
 * schema), so 75min covers every finite task with margin. Work whose
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
  private persistentMonitorIds = new Map<string, Set<string>>();

  constructor(private now: () => number = Date.now) {}

  /** PostToolUse(Monitor): classify one monitor task by its arm-time
   *  persistent flag (tool_response.taskId + tool_response.persistent). */
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
   *  Shape per claude 2.1.x Kjp(): {id, type, status, description, …}. */
  recordSettle(agentId: string, backgroundTasks: unknown): void {
    let count = 0;
    if (Array.isArray(backgroundTasks)) {
      const persistent = this.persistentMonitorIds.get(agentId);
      for (const t of backgroundTasks) {
        if (t && typeof t === 'object' && 'id' in t) {
          const id = (t as { id: unknown }).id;
          if (typeof id === 'string' && persistent?.has(id)) continue;
        }
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
   *  and the old session's persistent-monitor ids die with it. */
  resetAgent(agentId: string): void {
    this.settle.delete(agentId);
    this.persistentMonitorIds.delete(agentId);
  }
}
