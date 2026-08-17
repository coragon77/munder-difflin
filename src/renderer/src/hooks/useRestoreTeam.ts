import { useEffect, useSyncExternalStore } from 'react';
import { spawnIdentity } from '@/scene/office/spawnIdentity';
import { useStore, type Agent } from '@/store/store';
import {
  buildSpawnCommand,
  inferAgentProvider,
  tokenizeCommand,
  type HarnessConfig,
} from '@/store/config';

/** "Restore team" — respawn every worker from the previous session.
 *
 *  Lives here rather than inside AgentStrip because the floor strip is hidden in
 *  fullscreen, which used to mean the restore button (and the list of restorable
 *  agents) simply vanished when you went fullscreen. Both mount points share the
 *  progress state below, so a restore kicked off from one view shows as running
 *  in the other and can't be double-started. */

let restoring = false;
let note: string | null = null;
/** True only while the AUTOMATIC boot restore is in flight, so the UI can say
 *  "this is happening on its own" rather than looking like a click you don't
 *  remember making. */
let autoRestoring = false;
/** Latched the moment the automatic restore starts. Module-level, not per
 *  component: `useRestoreTeam` is mounted from both the floor strip and the
 *  fullscreen rail, and without this each of them would kick off its own. */
let autoStarted = false;
const listeners = new Set<() => void>();

/** How long to wait after boot before restoring on our own.
 *
 *  App.tsx reconciles the persisted roster against the PTYs actually alive in
 *  the main process, and that is an async round trip. Firing before it lands
 *  would read a restorable list that still contains agents whose terminals are
 *  already running, and try to spawn duplicates of them. The delay is also the
 *  window in which you can hit a dismiss ✕ if you don't want an agent back. */
export const AUTO_RESTORE_DELAY_MS = 2500;

function emit(): void {
  for (const l of [...listeners]) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// useSyncExternalStore requires a stable snapshot identity — returning a fresh
// object each call would loop forever, so the two fields are read separately.
const getRestoring = (): boolean => restoring;
const getNote = (): string | null => note;
const getAutoRestoring = (): boolean => autoRestoring;

/** Ids currently on vacation, per the registry. Pulled out of restoreTeam so it
 *  can be unit-tested without mounting the hook (see vacation-restore-skip.test.cjs). */
export function parkedAgentIds(reg: {
  agents: Record<string, { vacation?: boolean }>;
}): Set<string> {
  return new Set(
    Object.entries(reg.agents)
      .filter(([, a]) => a.vacation)
      .map(([id]) => id),
  );
}

/** Clamp into the office's physical range (1..16 workplaces) — same rule as
 *  main's normalizeFloorMaxAgents, repeated here because renderer can't import
 *  main (the two config mirrors are already hand-synced the same way). */
export function clampFloorCap(n: number): number {
  return Number.isFinite(n) ? Math.min(16, Math.max(1, Math.floor(n))) : 16;
}

/** Split a restorable list against free floor seats (card
 *  agent-harness-floormaxagents-s-2026-08-17): the first `freeSeats` agents in
 *  roster order restore; the rest are HELD — they stay on the restorable list
 *  (retryable once a seat frees) and the caller surfaces a note. Pure on
 *  purpose so the cap behavior is testable without mounting the hook. */
export function capRestorables<T>(
  restorable: T[],
  freeSeats: number,
): { restoring: T[]; held: number } {
  const free = Math.max(0, Math.floor(freeSeats));
  return { restoring: restorable.slice(0, free), held: Math.max(0, restorable.length - free) };
}

export interface RestoreTeamState {
  restoring: boolean;
  /** True when the run in flight was started automatically at boot, not by a
   *  click. Drives the "restoring your team…" banner. */
  autoRestoring: boolean;
  /** Outcome of the last run ("restored 3 · 1 failed — …"), or null. */
  restoreNote: string | null;
  restoreTeam: () => Promise<void>;
}

/**
 * @param config used only to rebuild a spawn command for a restorable agent
 *        persisted before the `command` field existed.
 */
export function useRestoreTeam(config?: HarnessConfig | null): RestoreTeamState {
  const isRestoring = useSyncExternalStore(subscribe, getRestoring, getRestoring);
  const restoreNote = useSyncExternalStore(subscribe, getNote, getNote);
  const isAutoRestoring = useSyncExternalStore(subscribe, getAutoRestoring, getAutoRestoring);

  /** Respawn every worker from the previous session with its ORIGINAL agent id,
   *  cwd, model and command — the hive workspace (memory.md, inbox, registry
   *  entry) reattaches by itself, no memory transplant needed. */
  const restoreTeam = async (): Promise<void> => {
    if (restoring) return;
    restoring = true;
    note = null;
    emit();
    const prevSel = useStore.getState().selectedId;
    // A VACATIONER MUST NOT COME BACK ON ITS OWN. Restore-team also runs
    // automatically at boot, so without this a restart would walk the whole
    // parked pool back onto the floor — the resurrection class of bug `retired`
    // was given its own flag to stop (445d135). The registry is the authority;
    // the renderer's own copy can be stale after a crash mid-park.
    //
    // This is the SOLE defense — spawnAgentCore refuses `retired` ids but has
    // no vacation check of its own — so a registry read failure must fail
    // SAFE, not open. Spawning everyone when we can't tell who's parked would
    // silently resurrect the parked pool, and that risk peaks right here:
    // restore-team also runs unattended at boot, exactly when a startup IPC
    // race is most likely. A visible no-op beats an invisible revival.
    let parked: Set<string>;
    try {
      const reg = await window.cth.hiveRegistry();
      parked = parkedAgentIds(reg);
    } catch {
      restoring = false;
      note = "couldn't verify vacation status — restore skipped, try again";
      emit();
      return;
    }
    const restorableAgents = useStore.getState().restorableAgents.filter((a) => !parked.has(a.id));
    // FLOOR CAP (card agent-harness-floormaxagents-s-2026-08-17): when the floor
    // has fewer free seats than restorable agents — e.g. the operator downsized
    // floorMaxAgents below the registry size — restore in ROSTER ORDER up to the
    // cap and HOLD the rest. Held agents stay restorable (retry once a seat
    // frees) and the note below says why they didn't come back. The main-side
    // spawn gate is the backstop; this is the proposal the operator sees.
    const floorCap = clampFloorCap(
      typeof config?.floorMaxAgents === 'number' ? config.floorMaxAgents : 16,
    );
    const liveOnFloor = useStore.getState().agents.filter((a) => !a.isGod).length;
    const { restoring: toRestore, held: heldByCap } = capRestorables(
      restorableAgents,
      floorCap - liveOnFloor,
    );
    // Tally every agent's outcome so the run ALWAYS leaves a visible trace — the
    // original bug was that every failure path was console-only, so a click that
    // couldn't spawn anything looked like a dead button.
    let restored = 0;
    let alreadyLive = 0;
    const failures: string[] = [];
    try {
      // Restore every agent CONCURRENTLY. Each spawn is keyed by its own ptyId and
      // touches no cross-agent state in the renderer, and in the main process the
      // whole `pty:spawn` handler (hive registry read-modify-write included) runs
      // synchronously between awaits, so concurrent handlers can't interleave
      // mid-update. Serially this cost the sum of every agent's git probe + spawn;
      // a 6-agent team took ~6× one agent for no reason.
      // Spawns run concurrently but agents are ADDED in roster order afterwards.
      // Calling addAgent from inside each spawn made completion timing decide
      // the roster order — and that order is persisted, so a slow provider or a
      // slow git probe silently overwrote the sequence the user had dragged the
      // cards into.
      const restoredInOrder = await Promise.all(
        [...toRestore].map(async (a): Promise<Agent | null> => {
          // Per-agent guard: one agent's failure (or a rejected IPC call) must NEVER
          // abort the others — an unhandled rejection here used to make the
          // entire restore a silent no-op after the first bad agent.
          try {
            const provider = inferAgentProvider(a.command, a.provider);
            const command =
              (a.command ?? '').trim() ||
              (config ? buildSpawnCommand(config, a.model, provider) : '');
            if (!command || !a.cwd) {
              // No spawn recipe (an old entry persisted before `command`, with no
              // config to rebuild one). Keep it restorable and SAY why rather than
              // silently dropping it — silent removal read as "nothing happened".
              failures.push(`${a.name}: no saved command`);
              return null;
            }
            const [exe, ...args] = tokenizeCommand(command);
            const ptyId = a.ptyId ?? `pty-${a.id}`;
            // ROLE IS IDENTITY, SET AT HIRE — a respawn must NOT echo the
            // renderer `description` (a live status field: usePtyParser rewrites
            // it to 'on standby' on idle) into the registry role. No role here;
            // ensureAgent preserves the hired one.
            //
            // NO pre-spawn `archived` check here. `archived` is a LIVENESS flag,
            // not a retirement one: archiveOrphanedAgents (main/index.ts) flips
            // every PTY-less agent to archived:true at boot, and a restorable
            // agent is BY DEFINITION one whose terminal died with the last
            // session — so such a check rejects 100% of restores and the button
            // goes inert. Retirement is tracked where it is actually known: an
            // archive/fire drops the agent from `restorableAgents` (store's
            // archiveAgent), so a retired agent never reaches this loop.
            // An isolated agent's worktree SURVIVES an app restart on disk (it's only
            // torn down on per-tab close / mid-session exit, not on quit). So re-enter
            // that exact worktree as the cwd rather than re-isolating — `git worktree
            // add` would conflict with the existing path/branch, and re-isolating would
            // also lose the worktree's uncommitted work. cwd = the worktree means
            // resume + seedSessionTranscript land in the CORRECT checkout.
            // But the user may have manually pruned/deleted the worktree between runs —
            // gitIsRepo (git rev-parse) returns false for a missing/invalid dir, so
            // fall back to the base repo cwd rather than spawning into a dead path.
            let cwd = a.cwd;
            let worktreeGone = false;
            if (a.worktreePath) {
              if (await window.cth.gitIsRepo(a.worktreePath)) {
                cwd = a.worktreePath;
              } else {
                worktreeGone = true;
                console.warn(
                  `[restore] worktree gone for ${a.id} (${a.worktreePath}); falling back to base repo ${a.cwd}`,
                );
              }
            }
            const res = await window.cth.spawnPty({
              id: ptyId,
              cwd,
              command: exe,
              provider,
              args,
              cols: 100,
              rows: 30,
              // Worktree (if any) already exists on disk — cd into it, don't create a
              // new one (re-isolating would conflict on the existing path/branch and
              // lose its uncommitted work).
              isolate: false,
              // Continue the worker's prior CLI session if one was recorded — the
              // main process picks the provider's resume flag (Claude --resume,
              // agy --conversation) and for Claude reattaches the transcript. The
              // agent id is preserved across restart, so its registry entry,
              // memory.md and inbox reattach by id. No-op without a recorded session.
              resume: true,
              // The agent's OWN hire-time choice rides every respawn (card
              // permission-mode-config-20260816); a legacy pre-selector agent has
              // none and spawnAgentCore defaults it to Claude Auto.
              permissionMode: a.permissionMode,
              hive: { id: a.id, name: a.name, provider, cwd, spawnLabel: a.spawnLabel },
            });
            if (res.ok) {
              // The card must reflect the REGISTRY (source of truth), not just the
              // PTY spawn result: spawnAgentCore has ok-without-registration paths
              // (the missing-CLI installer short-circuit; hive provisioning is
              // best-effort and never blocks a spawn), so an ARCHIVED agent can
              // "restore" green while the registry still lists it archived — a
              // phantom floor card with no backing agent (observed live:
              // intern-chip-test after the 13:26 restart; its later fire-request
              // answered "already archived; nothing to tear down"). Only enforced
              // when the registry is actually populated — with the hive disabled
              // there is nothing to verify against and restores behave as before.
              const reg = await window.cth.hiveRegistry().catch(() => null);
              const entry = reg?.agents?.[a.id];
              if (reg && Object.keys(reg.agents).length > 0 && (!entry || entry.archived)) {
                failures.push(
                  `${a.name}: ${entry?.archived ? 'registry still has them archived' : 'spawn did not register them'} — not restored`,
                );
                console.error('[restore] spawn reported ok but the registry disagrees for', a.id);
                return null;
              }
              restored++;
              // Office identity (agent-icon-persistence-20260817): the
              // registry-saved pick wins over the roster row's — same ladder
              // as the recall broadcast (spawnIdentity validates the strings).
              const identity = spawnIdentity(
                a.id,
                a.name,
                { character: a.character, accent: a.accent },
                { character: entry?.officeCharacter, accent: entry?.officeAccent },
              );
              return {
                ...a,
                character: identity.character,
                accent: identity.accent,
                provider,
                ptyId,
                archived: false,
                status: 'idle',
                // Surface the worktree fallback on the floor card; otherwise normal.
                action: worktreeGone ? 'worktree gone — using base repo' : 'starting up',
                // The worktree is no longer on disk — drop it so this agent is treated
                // as a plain base-cwd agent going forward (a future restore won't keep
                // re-probing a dead path).
                worktreePath: worktreeGone ? undefined : a.worktreePath,
                // Crush spawns bare (no positional protocol) and hands the seed back
                // here; useHive types it after boot. Re-seeding a resumed worker is
                // idempotent (it just re-reads its inbox per protocol). (ondev-b)
                seedPrompt: res.seedPrompt,
                carrying: undefined,
                currentStation: 'desk',
                recentTextTs: Date.now(),
              };
            } else if ((res.error ?? '').includes('already exists')) {
              // A live PTY with this id is already running (e.g. respawned at boot or
              // by another path) — the agent isn't actually missing, so retire it from
              // the restorable list rather than reporting a phantom failure.
              alreadyLive++;
              useStore.getState().removeRestorableAgent(a.id);
            } else {
              // Leave it restorable so the user can retry — but record WHY so the
              // outcome is shown on the floor, not buried in the devtools console.
              failures.push(`${a.name}: ${res.error ?? 'spawn failed'}`);
              console.error('[restore] spawn failed for', a.id, res.error);
            }
          } catch (e) {
            failures.push(`${a.name}: ${e instanceof Error ? e.message : String(e)}`);
            console.error('[restore] error for', a.id, e);
          }
          return null;
        }),
      );
      // Add in the ORIGINAL roster order, not completion order.
      for (const restoredAgent of restoredInOrder) {
        if (restoredAgent) useStore.getState().addAgent(restoredAgent);
      }
    } finally {
      // addAgent auto-selects each spawn; put the user back where they were.
      const sel = useStore.getState();
      if (prevSel && sel.agents.some((x) => x.id === prevSel)) sel.select(prevSel);
      restoring = false;
      // ALWAYS surface a result so the button can never look inert.
      const parts: string[] = [];
      if (restored) parts.push(`restored ${restored}`);
      if (alreadyLive) parts.push(`${alreadyLive} already live`);
      if (heldByCap)
        parts.push(
          `held ${heldByCap} — floor cap ${floorCap} reached (floorMaxAgents, Settings → Autonomy & Budgets); they stay restorable`,
        );
      if (failures.length) parts.push(`${failures.length} failed — ${failures.join('; ')}`);
      note = parts.length ? parts.join(' · ') : 'nothing to restore';
      emit();
    }
  };

  // Restore the previous session's team on open, without waiting for a click.
  //
  // Deliberately driven by a store SUBSCRIPTION rather than a plain timer: the
  // restorable list is empty on the first render and only fills once App.tsx's
  // PTY reconcile resolves, so a timer started at mount would look at an empty
  // list, decide there was nothing to do, and never look again.
  //
  // Only ever fires for agents already on the restorable list — i.e. ones that
  // had a terminal open when the app last quit. Archived agents (closed tabs)
  // are never touched.
  // biome-ignore lint/correctness/useExhaustiveDependencies: store-subscription-driven one-shot auto-restore; restoreTeam/restoring are read fresh at call time
  useEffect(() => {
    if (autoStarted || !config?.onboardingComplete) return;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const check = (): void => {
      if (autoStarted || restoring || timer) return;
      if (!useStore.getState().restorableAgents.length) return;
      timer = setTimeout(() => {
        timer = null;
        if (autoStarted || restoring) return;
        if (!useStore.getState().restorableAgents.length) return;
        // Latch BEFORE the await so the other mount point's timer, which may
        // fire in this same tick, sees it.
        autoStarted = true;
        autoRestoring = true;
        emit();
        void restoreTeam().finally(() => {
          autoRestoring = false;
          emit();
        });
      }, AUTO_RESTORE_DELAY_MS);
    };

    check();
    const unsub = useStore.subscribe(check);
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
    // restoreTeam is rebuilt every render but only ever called from inside the
    // timer, so it is read fresh at call time and does not belong in the deps.
  }, [config?.onboardingComplete]);

  return { restoring: isRestoring, autoRestoring: isAutoRestoring, restoreNote, restoreTeam };
}
