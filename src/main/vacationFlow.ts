/**
 * The park/recall/request guard chains (card vacation-mainproc-coverage-20260816).
 * Extracted verbatim from index.ts so they are testable — the Electron main
 * entry cannot be loaded from the .cjs test harness (vacationBusy precedent).
 *
 * Characterization contract: the logic here is the EXACT inline code that lived
 * in parkAgent/recallAgent/processVacationRequest at main @ 0170dfa, with every
 * side effect replaced by a dep. vacation-flow.test.cjs pins it; if a test
 * fails, behavior changed — make sure that was intentional.
 */

import {
  commandCarriesModel,
  inferAgentProvider,
  type AgentProvider,
  type HirePermissionMode,
} from '../shared/agentProvider';
import type { Registry } from './hive';

/** The spawn recipe index.ts resolves from the renderer's roster mirror
 *  (rosterRecipe) — every field optional, falls back to defaults. */
export interface VacationRecipe {
  command?: string;
  model?: string;
  cwd?: string;
  permissionMode?: HirePermissionMode;
}

/** The exact spawn shape recallAgent builds (structurally compatible with
 *  index.ts's AgentSpawnOptions — the adapter passes it straight through). */
export interface RecallSpawnSpec {
  id: string;
  cwd: string;
  command: string;
  cols?: number;
  rows?: number;
  args?: string[];
  hive?: { id: string; name: string; provider?: AgentProvider; role?: string; cwd: string };
  isolate?: boolean;
  /** Route through spawnAgentCore's adopt-recent-session machinery — the
   *  recalled pane continues the agent's LAST conversation instead of booting
   *  fresh (no-op when no session was ever recorded). */
  resume?: boolean;
  provider?: AgentProvider;
  permissionMode?: HirePermissionMode;
}

/** Everything parkAgent touches outside its own decision-making. Each dep maps
 *  1:1 onto a live singleton in index.ts — the adapter there is pure wiring. */
export interface ParkDeps {
  hiveEnabled(): boolean;
  registry(): Registry;
  ptyForAgent(agentId: string): string | undefined;
  /** vacationBusy(telemetryAgeMs, ptyIdleMs) — consulted only when a PTY exists. */
  busy(ptyId: string, agentId: string): boolean;
  /** Drop the worktree tracking entries BEFORE teardown — teardown's
   *  force-remove must never see a parked agent's worktree. */
  dropWorktree(ptyId: string): void;
  killPty(ptyId: string): void;
  teardownPty(ptyId: string): void;
  setVacation(id: string, vacation: boolean): boolean;
  appendLog(event: Record<string, unknown>): void;
  /** liveWebContents()?.send('hive:agentVacationed', …) — may throw (window
   *  gone); swallowed by the core, so the adapter needs no try/catch. */
  notifyVacationed(event: { id: string; vacationSince: number }): void;
  log(message: string): void;
  error(message: string): void;
}

/** Everything recallAgent touches outside its own decision-making. */
export interface RecallDeps {
  hiveEnabled(): boolean;
  registry(): Registry;
  isOnVacation(id: string): boolean;
  ptyForAgent(agentId: string): string | undefined;
  recipe: VacationRecipe;
  /** readConfig().defaultCommand */
  defaultCommand?: string;
  /** ptyManager.isCommandAvailable */
  commandAvailable(bin: string): boolean;
  /** existsSync */
  pathExists(p: string): boolean;
  spawn(opts: RecallSpawnSpec): Promise<{ ok: boolean; error?: string; worktreePath?: string }>;
  setVacation(id: string, vacation: boolean): boolean;
  setArchived(id: string, archived: boolean): void;
  appendLog(event: Record<string, unknown>): void;
  /** liveWebContents()?.send('hive:agentSpawned', …) — may throw; swallowed. */
  notifySpawned(event: Record<string, unknown>): void;
  log(message: string): void;
}

/** Who is asking for the park — the operator's button or god's automated
 *  vacation-request. The ONLY rung that differs is the busy gate (operator
 *  decision, card vacation-busy-fresh-boot-20260817): the human pressed the
 *  button and can see the agent's PTY, so idleness is their call, not ours. */
export type ParkOrigin = 'operator' | 'request';

/** The refusal ladder + teardown/persist flow of parkAgent, verbatim.
 *  Returns { ok: true } only when the vacation flag verifiably landed. */
export function parkAgentCore(
  deps: ParkDeps,
  agentId: string,
  reason?: string,
  origin: ParkOrigin = 'request',
): { ok: boolean; error?: string } {
  if (!deps.hiveEnabled()) return { ok: false, error: 'hive disabled' };
  const reg = deps.registry();
  const entry = reg.agents[agentId];
  if (!entry) return { ok: false, error: `no agent "${agentId}" in the registry` };
  if (entry.isGod || reg.godId === agentId)
    return { ok: false, error: 'god does not go on vacation' };
  if (entry.role === 'intern')
    return { ok: false, error: `"${agentId}" is an intern — interns are fired, never parked` };
  if (entry.retired)
    return {
      ok: false,
      error: `"${agentId}" was fired — retired and vacation are mutually exclusive`,
    };
  if (entry.vacation) return { ok: false, error: `"${agentId}" is already on vacation` };
  const ptyId = deps.ptyForAgent(agentId);
  if (ptyId) {
    // Busy = REAL work inside the window (rule + rationale in vacationBusy.ts):
    // telemetry liveness (hook/OTLP lastActive) is primary; PTY output is only
    // the fallback for agents with no telemetry row. An idle claude TUI
    // repaints its chrome continuously, so lastOutputAt alone read every idle
    // pane as "actively working" (card vacation-busy-check-tui-repaint).
    // Operator origin skips ONLY this rung — their button, their judgment.
    if (origin !== 'operator' && deps.busy(ptyId, agentId)) {
      return { ok: false, error: `"${agentId}" is actively working — park it when it goes quiet` };
    }
    // A park is not a firing: the worktree IS the agent's state, and the recall
    // re-enters it (the registry cwd is that path for an isolated agent). Drop the
    // tracking entries so teardownPty's force-remove — correct for a closed
    // terminal, catastrophic for a parked one — never sees them. This is exactly
    // how a post-restart respawn already behaves (isolate:false, empty map), so
    // park now matches the path that was always correct.
    deps.dropWorktree(ptyId);
    try {
      deps.killPty(ptyId);
    } catch {
      /* already gone — teardown is idempotent */
    }
    deps.teardownPty(ptyId); // sets archived (liveness); vacation is the layer on top
  }
  // setVacation REPORTS persistence (vacation-review M3): the terminal is
  // already gone and the agent sits plain-archived, so a failed flag write
  // must fail the park — otherwise the request answers "protected, zero cost,
  // not deletable" while the registry holds none of that.
  if (!deps.setVacation(agentId, true)) {
    deps.appendLog({ kind: 'vacation_park_failed', agentId });
    deps.error(`[vacation] park ${agentId} failed: could not persist the vacation flag`);
    return {
      ok: false,
      error: `could not persist the vacation flag — ${agentId} is archived but NOT protected; retry, or unarchive to restore it`,
    };
  }
  const vacationSince = deps.registry().agents[agentId]?.vacationSince ?? Date.now();
  try {
    deps.notifyVacationed({ id: agentId, vacationSince });
  } catch {
    /* window gone */
  }
  deps.appendLog({ kind: 'vacation_park', agentId, reason: reason ?? null });
  deps.log(`[vacation] parked ${agentId}${reason ? ` — ${reason}` : ''}`);
  return { ok: true };
}

/** The refusal ladder, availability guards, spawn recipe and flag-repair block
 *  of recallAgent, verbatim. The spawn IS the recall; the repair block exists
 *  because a green spawn does NOT prove the vacation flag cleared. */
export async function recallAgentCore(
  deps: RecallDeps,
  agentId: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!deps.hiveEnabled()) return { ok: false, error: 'hive disabled' };
  const entry = deps.registry().agents[agentId];
  if (!entry) return { ok: false, error: `no agent "${agentId}" in the registry` };
  if (entry.retired) return { ok: false, error: `"${agentId}" was fired — reinstate them first` };
  // Only ever true for a non-god, non-intern, non-retired agent (parkAgent's own
  // guards) — so this one check transitively covers everything parkAgent defends
  // against, without repeating each rule here.
  if (!deps.isOnVacation(agentId))
    return { ok: false, error: `"${agentId}" is not on vacation — nothing to recall` };
  if (deps.ptyForAgent(agentId))
    return { ok: false, error: `"${agentId}" is already on the floor` };
  const recipe = deps.recipe;
  const command = recipe.command ?? deps.defaultCommand ?? 'claude';
  const provider = entry.provider ?? inferAgentProvider(command);
  const bin = command.split(/\s+/)[0] || command;
  if (!deps.commandAvailable(bin))
    return { ok: false, error: `engine CLI "${bin}" is not installed` };
  const cwd = recipe.cwd ?? entry.cwd;
  if (!cwd || !deps.pathExists(cwd))
    return { ok: false, error: `cwd missing or not found (${cwd || 'unset'})` };
  let res: { ok: boolean; error?: string; worktreePath?: string };
  try {
    res = await deps.spawn({
      id: agentId,
      cwd,
      command,
      cols: 120,
      rows: 32,
      // A '--model' typed into the saved command's tail reaches argv via
      // spawnAgentCore's tail tokenization — never double it with the recipe's
      // model field.
      args: recipe.model && !commandCarriesModel(command) ? ['--model', recipe.model] : [],
      hive: { id: agentId, name: entry.name, provider, role: entry.role, cwd },
      isolate: false,
      // The pane must come back to the agent's LAST conversation, not a fresh
      // boot (card recall-resume-conversation-20260817) — the same
      // adopt-recent-session path restore-team uses. spawnAgentCore resolves
      // hive.lastSession(id) into the provider's resume flag (Claude --resume
      // with transcript seeding, codex resume, …) and attaches NOTHING when no
      // session was ever recorded, so a first-ever boot stays a plain fresh
      // spawn. Resume is argv-only — a /clear typed into the pane right after
      // recall still wins, it is just input to the resumed conversation.
      resume: true,
      provider,
      // The vacationer's OWN hire-time choice (roster mirror) — the central
      // injection appends its flag; a flag typed into the saved command wins.
      permissionMode: recipe.permissionMode,
    });
  } catch (e) {
    res = { ok: false, error: String(e) };
  }
  if (!res.ok) return { ok: false, error: res.error ?? 'spawn failed' };
  // ensureAgent clears `vacation`, but the spawn swallows its failures by
  // design ("never block a spawn on it") — so a green spawn does NOT prove the
  // flag cleared. An agent left flagged is invisible to every roster read while
  // its PTY burns tokens, so repair it here rather than trusting the spawn.
  if (deps.isOnVacation(agentId)) {
    if (!deps.setVacation(agentId, false)) {
      // The repair itself failed (vacation-review M3): say so instead of
      // reporting a healthy recall — god must know the agent is live but
      // invisible to the rosters, not discover it from a dead route.
      deps.appendLog({ kind: 'vacation_recall_repair_failed', agentId });
      return {
        ok: false,
        error: `${agentId} is spawned but the vacation flag is stuck — it is invisible to the rosters; check registry.json`,
      };
    }
    deps.setArchived(agentId, false);
    deps.appendLog({ kind: 'vacation_recall_repair', agentId });
  }
  try {
    deps.notifySpawned({
      id: agentId,
      name: entry.name,
      provider,
      cwd: res.worktreePath ?? cwd,
      command,
      role: entry.role,
      worktreePath: res.worktreePath,
    });
  } catch {
    /* window torn down */
  }
  deps.appendLog({ kind: 'vacation_recall', agentId });
  deps.log(`[vacation] recalled ${agentId}`);
  return { ok: true };
}

/** The parse/verb/id resolution of processVacationRequest. `id` accepted
 *  beside `agentId` — both spellings ship in the docs' sibling request
 *  formats, and a typo here would otherwise read as a silent no-op. */
export type VacationRequestPlan =
  | { ok: true; agentId: string; recall: boolean; reason?: string }
  | { ok: false; error: string };

export function vacationRequestTarget(raw: unknown): VacationRequestPlan {
  // JSON.parse('null') (or a bare primitive) parses fine but has no fields to
  // resolve — dereferencing it below threw past every guard in
  // processVacationRequest, so the file was retried forever. Reject instead;
  // the caller's fail() path archives it to .failed like unparseable JSON.
  if (typeof raw !== 'object' || raw === null)
    return { ok: false, error: 'request body is not a JSON object' };
  const r = raw as { agentId?: unknown; id?: unknown; action?: unknown; reason?: string };
  const agentId = (
    typeof r.agentId === 'string' ? r.agentId : typeof r.id === 'string' ? r.id : ''
  ).trim();
  if (!agentId) return { ok: false, error: 'missing "agentId"' };
  const recall = String(r.action ?? 'park').toLowerCase() === 'recall';
  return { ok: true, agentId, recall, reason: r.reason };
}
