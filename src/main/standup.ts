/**
 * Standup clerk (card agent-harness-standup-clerk-ch-2026-08-17).
 *
 * The hourly ops standup used to wake GOD for a full turn every hour — an
 * expensive orchestrator reading two JSON files. With `standupClerk` ON (the
 * shipped default) the scheduler routes the standup to a cheap haiku-class
 * one-shot instead, and god only hears about it when something is actually
 * wrong: stalled · blocked-unowned · breaker-armed · over-budget.
 *
 * The split of labour here is deliberate:
 *  - THIS module decides, deterministically, whether anything is wrong. That
 *    keeps the escalation conditions testable and means a healthy-but-busy
 *    floor spawns NOTHING at all (an LLM asked to say "all fine" is a bill for
 *    silence). It also guarantees a real escalation survives an LLM that times
 *    out — `summarizeAnomalies` is the fallback text.
 *  - The CLERK (a hidden one-shot, `runHiddenHelper`) writes the prose: it sees
 *    the same fleet.json / tasks.json and turns the findings into the board
 *    line and the mail body god actually reads.
 *
 * The quiet-floor skip (`skipWhenFloorQuiet`, 13c6f7d) is upstream of all of
 *  this and unchanged in MECHANISM: a quiet floor never reaches the clerk.
 *  What "quiet" MEANS changed (card agent-every-non-paused-todo-ke-2026-08-
 *  18): any NON-PAUSED todo keeps the floor non-quiet — the backlog IS what
 *  the standup watches. Reference-only cards opt out via the per-card paused
 *  flag, and the 'todo-unattended' anomaly below (age-gated, dep-skipping,
 *  deduped per card id by the caller) is what the standup reports for the
 *  todos that kept it alive.
 */

import { cardPaused, depWaiting } from './actionableCards';

/** Where a due ops-standup goes. */
export type StandupTarget = 'clerk' | 'god';

/** The escalation conditions. Anything else is the floor working. */
export type AnomalyKind =
  | 'stalled'
  | 'blocked-unowned'
  | 'breaker-armed'
  | 'over-budget'
  | 'todo-unattended';

export interface Anomaly {
  kind: AnomalyKind;
  /** Agent id or card id the finding is about (for the mail's first line). */
  subject: string;
  /** One human-readable sentence — also the deterministic fallback text. */
  detail: string;
}

/** The slice of `fleet.json` the clerk reasons about (see writeFleetSnapshot). */
export interface FleetAgent {
  id: string;
  name?: string;
  isGod?: boolean;
  breaker?: string;
  tokens?: number;
  /** null = no telemetry yet (fresh spawn) — never read as "idle forever". */
  lastActiveSecAgo?: number | null;
  pendingBackgroundWork?: number;
}

export interface StandupTask {
  id: string;
  title?: string;
  status?: string;
  assignee?: string;
  /** Deps that must be DONE before this card is actionable — a dep-waiting
   *  todo is correctly waiting, not unattended. */
  dependsOn?: string[];
  /** Age-gate input: only todos older than STALLED_SEC escalate as
   *  todo-unattended — younger ones are presumed mid-dispatch. Missing
   *  counts (cannot prove young; fail toward surfacing). */
  createdAt?: string;
  /** Operator hold (card agent-standup-must-not-nag-god-2026-08-19): a
   *  paused card is not stalled, not unowned-by-accident and not unattended —
   *  it is held on purpose, a decided state, never a finding. Absent = not
   *  paused. */
  paused?: boolean;
}

export interface StandupBudgets {
  costCapTokens?: number;
  agentTokenCaps?: Record<string, number>;
}

/** Idle time that turns "working" into "stalled" for an agent holding a doing
 *  card: half the hourly standup interval, so a stall is caught on the first
 *  standup after it starts rather than the second. Also the age gate for
 *  todo-unattended — same "presumed mid-dispatch" horizon. */
export const STALLED_SEC = 1800;

/** The quiet-floor LEDGER half (card agent-every-non-paused-todo-ke-2026-08-
 *  18): a ledger with any card in 'doing'/'blocked' OR any NON-PAUSED 'todo'
 *  is NOT quiet — every todo counts, assigned or not (an assigned todo nobody
 *  works is the dispatch-that-never-happened case). Paused (on-hold,
 *  reference-only) todos opt out. Unparseable input ⇒ NOT quiet: the caller
 *  fails toward firing, never silently skipping a due dispatch. */
export function ledgerDisqualifiesQuiet(tasks: unknown): boolean {
  const list = (tasks as { tasks?: unknown })?.tasks;
  if (!Array.isArray(list)) return true; // cannot prove quiet — fire
  return list.some((x) => {
    if (!x || typeof x !== 'object') return true; // unparseable card — fire
    const s = (x as { status?: unknown }).status;
    if (s === 'doing' || s === 'blocked') return true;
    if (s === 'todo') return (x as { paused?: unknown }).paused !== true;
    if (s === 'done') return false;
    return true; // unknown status — cannot prove quiet
  });
}

/** Cheap by design — the whole point of the card. The clerk's ENGINE (and
 *  model) is resolved at call time by src/main/hiddenHelpers.ts: Settings'
 *  helperDefaults > godProvider > claude-with-haiku. */

/** Routing decision. Unset ⇒ clerk (default ON per operator); only an explicit
 *  `false` restores the old wake-god-every-hour dispatch. */
export function standupTarget(cfg: { standupClerk?: boolean }): StandupTarget {
  return cfg.standupClerk === false ? 'god' : 'clerk';
}

const asArray = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const mins = (sec: number): string => `${Math.round(sec / 60)}m`;

/**
 * The escalation conditions, evaluated against the same two files god reads.
 * Everything is best-effort: a missing/corrupt snapshot yields no anomalies
 * rather than throwing (the opposite bias to `floorQuietSince`, which fails
 * toward firing — here a false alarm would wake god, which is what the card
 * exists to stop).
 */
export function detectAnomalies(
  fleet: unknown,
  tasks: unknown,
  budgets: StandupBudgets,
  stalledSec = STALLED_SEC,
  /** Card ids escalated as todo-unattended at the PREVIOUS standup (amendment
   *  A: once-per-card dedup, so an old backlog escalates ONE mail not hourly
   *  ones). Restricted to todo-unattended — stalled/blocked-unowned/breaker/
   *  over-budget stay hourly by design (repetition is a feature for rare
   *  urgent states). Persisted by the caller on the mission config. */
  escalatedBefore: string[] = [],
): Anomaly[] {
  const agents = asArray<FleetAgent>((fleet as { agents?: unknown })?.agents).filter(
    (a) => a && typeof a.id === 'string',
  );
  const cards = asArray<StandupTask>((tasks as { tasks?: unknown })?.tasks).filter(
    (t) => t && typeof t.id === 'string',
  );
  const byId = new Map(agents.map((a) => [a.id, a]));
  const out: Anomaly[] = [];

  // (1) stalled — a card is in 'doing' but its owner isn't moving. An owner
  // with pending background work is WAITING, not idle (card
  // agent-harness-busy-signal-coun-2026-08-17), and one with no telemetry yet
  // has simply not reported a first tool call. A PAUSED doing card is an
  // operator hold — the hold explains the stillness, never a stall.
  for (const c of cards) {
    if (c.status !== 'doing' || cardPaused(c)) continue;
    const owner = c.assignee?.trim();
    if (!owner) continue;
    const a = byId.get(owner);
    if (!a) {
      out.push({
        kind: 'stalled',
        subject: c.id,
        detail: `card ${c.id} is 'doing' but its owner "${owner}" is not on the floor`,
      });
      continue;
    }
    const idle = a.lastActiveSecAgo;
    if (typeof idle !== 'number' || idle <= stalledSec) continue;
    if ((a.pendingBackgroundWork ?? 0) > 0) continue;
    out.push({
      kind: 'stalled',
      subject: a.id,
      detail: `${a.name ?? a.id} has been idle ${mins(idle)} while holding card ${c.id}`,
    });
  }

  // (2) blocked-unowned — a blocker nobody owns is a blocker nobody is clearing.
  // A PAUSED blocker is the operator's hold (the incident: six paused HPT
  // cards still nagged god to assign+resume) — held is a decided state, not
  // a finding. Same predicate as (1)/(2b): cardPaused, the paused half of
  // cardHeld (cardHeld itself can't serve here — every blocked card is
  // cardHeld by definition, it would suppress the whole detector).
  for (const c of cards) {
    if (c.status === 'blocked' && !c.assignee?.trim() && !cardPaused(c)) {
      out.push({
        kind: 'blocked-unowned',
        subject: c.id,
        detail: `card ${c.id}${c.title ? ` ("${c.title}")` : ''} is blocked with no assignee`,
      });
    }
  }

  // (2b) todo-unattended (card agent-every-non-paused-todo-ke-2026-08-18): a
  // non-paused todo that keeps the floor alive — the backlog the standup now
  // watches. ONE kind for BOTH shapes: unassigned AND assigned-but-idle (the
  // assignee's last activity is older than the gate, same ingredients as the
  // stalled block). Skips: paused cards (reference-only opt-out), todos with
  // unmet dependsOn (dep-waiting is correct waiting; the dependency card
  // itself counts upstream), todos younger than the gate (presumed
  // mid-dispatch), and — via escalatedBefore — cards already escalated at the
  // previous standup (once-per-card, no hourly nag).
  const statusById = new Map(cards.map((c) => [c.id, c.status ?? 'todo']));
  const escalated = new Set(escalatedBefore);
  for (const c of cards) {
    if (c.status !== 'todo' || cardPaused(c)) continue;
    if (escalated.has(c.id)) continue;
    // Unmet dependency: any dep that is not done keeps this card correctly
    // waiting. The interpretation lives in ONE place now — depWaiting in
    // actionableCards.ts (card agent-actionablecards-fold-dep-2026-08-18) —
    // the same function the ACTIONABLE roster line filters with, so the
    // standup and god's injection can never disagree on what is waiting.
    if (depWaiting(c, statusById)) continue;
    // Age gate: younger than the stall horizon = presumed mid-dispatch.
    const created = typeof c.createdAt === 'string' ? Date.parse(c.createdAt) : NaN;
    if (!Number.isNaN(created) && Date.now() - created < stalledSec * 1000) continue;
    const owner = c.assignee?.trim();
    if (owner) {
      const a = byId.get(owner);
      if (a) {
        const idle = a.lastActiveSecAgo;
        // Owner active (or no telemetry yet / waiting on background work) →
        // dispatch is plausibly happening; not unattended.
        if (typeof idle !== 'number' || idle <= stalledSec) continue;
        if ((a.pendingBackgroundWork ?? 0) > 0) continue;
        out.push({
          kind: 'todo-unattended',
          subject: c.id,
          detail: `todo ${c.id}${c.title ? ` ("${c.title}")` : ''} assigned to ${a.name ?? a.id} but idle ${mins(idle)} — dispatch never started`,
        });
        continue;
      }
    }
    out.push({
      kind: 'todo-unattended',
      subject: c.id,
      detail: `todo ${c.id}${c.title ? ` ("${c.title}")` : ''} has no active owner`,
    });
  }

  // (3) breaker-armed — anything above 'healthy' means the breaker already acted.
  for (const a of agents) {
    if (a.breaker && a.breaker !== 'healthy') {
      out.push({
        kind: 'breaker-armed',
        subject: a.id,
        detail: `${a.name ?? a.id} is breaker-armed (${a.breaker})`,
      });
    }
  }

  // (4) over-budget — per-agent caps first, then the floor total. An unset or 0
  // cap is "unlimited" everywhere else in the harness; it is here too.
  const caps = budgets.agentTokenCaps ?? {};
  for (const a of agents) {
    const cap = caps[a.id];
    const tokens = a.tokens ?? 0;
    if (typeof cap === 'number' && cap > 0 && tokens > cap) {
      out.push({
        kind: 'over-budget',
        subject: a.id,
        detail: `${a.name ?? a.id} is over its token cap (${tokens} / ${cap})`,
      });
    }
  }
  const floorCap = budgets.costCapTokens;
  if (typeof floorCap === 'number' && floorCap > 0) {
    const total = agents.reduce((n, a) => n + (a.tokens ?? 0), 0);
    if (total > floorCap) {
      out.push({
        kind: 'over-budget',
        subject: 'floor',
        detail: `the floor is over the token budget (${total} / ${floorCap})`,
      });
    }
  }
  return out;
}

/** Deterministic write-up of the findings. Used verbatim when the clerk fails
 *  or times out, and appended to whatever the clerk writes so no fact is lost
 *  to paraphrase. Empty findings ⇒ empty string (nothing to say). */
export function summarizeAnomalies(anomalies: Anomaly[]): string {
  if (!anomalies.length) return '';
  const head = `${anomalies.length} standup finding${anomalies.length === 1 ? '' : 's'}:`;
  return [head, ...anomalies.map((a) => `- [${a.kind}] ${a.detail}`)].join('\n');
}

/** One appended board line — board.md is narrative prose, so a multi-line
 *  report collapses to its first line. */
export function boardLine(stamp: string, text: string): string {
  const first = text.split('\n').find((l) => l.trim()) ?? 'anomalies found';
  return `- ${stamp} standup (clerk): ${first.trim()}`;
}

/** The clerk's whole job in one prompt: it re-reads the two files itself (so it
 *  can add the context a rule can't see) but is handed the findings so it can
 *  never miss one. Read-only — the harness does the writing. */
export function clerkPrompt(root: string, anomalies: Anomaly[]): string {
  return [
    'You are the hive standup clerk. This is a one-shot: no follow-up turn.',
    `Read ${root}/fleet.json (live per-agent status) and ${root}/tasks.json (the kanban).`,
    '',
    'A deterministic pass already found these escalations:',
    summarizeAnomalies(anomalies),
    '',
    'Write the standup report for the orchestrator ("god"):',
    '- FIRST LINE: one sentence, under 140 characters, naming the worst problem.',
    '- Then at most 4 short lines: what is wrong, who owns it, the next action.',
    'Name agents and card ids. No preamble, no markdown headings, no questions.',
    'Cards with paused:true are the operator’s holds: they are not problems. Do',
    'not recommend resuming, assigning or working them; mention them (if at',
    'all) only as held.',
    'Do not use any tool other than reading files. Do not write, edit, or run anything.',
  ].join('\n');
}
