/**
 * ORPHAN SWEEP — the decision core of the boot migration
 * (#57/#58, card agent-app-start-archives-the-e-2026-08-18).
 *
 * Incident 2026-08-18 ~15:17: an app start with zero live PTYs archived 43
 * agents including the entire vacation pool, because "no live PTY" was read as
 * evidence of orphanhood. It never is, on its own:
 *
 *  • `ptyToAgent` is process-local and populated only at spawn, so at boot NO
 *    agent owns a PTY. ZERO live PTYs is the universal fresh-boot state — it
 *    means "nothing is running yet", never "everyone is dead". The sweep is a
 *    no-op in that state.
 *  • A parked agent (`vacation:true`) has no PTY BY DESIGN. The vacation flag
 *    exempts an agent from the sweep in its own right — protection must not
 *    ride on the side-invariant `park ⇒ archived:true`, which divergent states
 *    (`vacation:true, archived:false`, possible under pre-M2 unarchive paths
 *    and hand edits) demonstrably break.
 *
 * The migration keeps its reason: when at least one hive agent HAS a live PTY
 * (the config:changeHome recover-in-place re-bootstrap, which re-runs the boot
 * sequence mid-session), a PTY-less, non-parked, non-archived entry is a stale
 * carry-over from a session that died without archiving — exactly what #57/#58
 * built the sweep for — and is returned for archiving. God and interns follow
 * the same single rule: god is exempt outright, an intern is an agent like any
 * other (disposability is `retired`, set at fire time, which the sweep already
 * respects via the archived flag `setRetired` maintains).
 *
 * Pure and dependency-free on purpose: index.ts's `archiveOrphanedAgents` is
 * untestable through Electron, so the DECISION lives here (vacationFlow
 * precedent) and the wiring (registry read, setArchived, logging) stays there.
 */

/** Structural subset of the registry the sweep decides over. */
export interface SweepRegistry {
  godId?: string | null;
  agents: {
    [id: string]: {
      archived?: boolean;
      vacation?: boolean;
      isGod?: boolean;
    };
  };
}

/**
 * The ids the boot sweep may archive. Rules, in order:
 *
 *  1. Zero live PTYs → nobody (nothing is running yet).
 *  2. God → never.
 *  3. Parked (`vacation:true`) → never, whatever `archived` says.
 *  4. Already archived → untouched (nothing to sweep).
 *  5. Has a live PTY → genuinely active.
 *  6. Anything else → stale orphan, return it.
 */
export function orphanedAgentIds(reg: SweepRegistry, liveAgentIds: ReadonlySet<string>): string[] {
  if (liveAgentIds.size === 0) return [];
  const ids: string[] = [];
  for (const [id, a] of Object.entries(reg.agents)) {
    if (id === reg.godId || a.isGod) continue;
    if (a.vacation) continue;
    if (a.archived) continue;
    if (liveAgentIds.has(id)) continue;
    ids.push(id);
  }
  return ids;
}
