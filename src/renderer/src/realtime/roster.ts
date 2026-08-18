/**
 * Vacation-aware roster wording for the voice read-layer (vacation-renderer
 * follow-up M1). Pure and import-free on purpose: these spoken strings are
 * pinned by test/realtime-roster-words.test.cjs through test/load-ts.cjs,
 * which cannot load tools.ts itself (it imports the realtime SDK).
 *
 * Registry semantics: `archived` is liveness (terminal closed), `vacation` is
 * the layer on top (parked, zero cost, recallable, not deletable). A vacationer
 * IS archived — but the voice must never say "archived" about one, or the human
 * will think the agent is gone for good when it is only resting.
 */

import { compareAgentOrder } from '@shared/agentOrder';

/** The slice of an AgentDirectoryEntry the roster wording actually speaks. */
export interface RosterRow {
  id: string;
  name: string;
  isGod?: boolean;
  provider: string;
  status?: string;
  cwd?: string | null;
  archived: boolean;
  vacation?: boolean | null;
  contextPct?: number | null;
}

/** `1 active agent` / `3 tokens` — voice-safe pluralization. */
export function plural(n: number, one: string, many = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The trailing folder name of a path — speech-friendly (the persona avoids
 *  reading full file paths aloud unless asked). e.g. /a/b/cth-voice-tools → cth-voice-tools. */
export function shortDir(p: string): string {
  const parts = (p || '').replace(/\/+$/, '').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

/** Split a directory into active / vacationing / plain-archived rows. A
 *  vacationer is archived by construction; it gets its own bucket so no caller
 *  can accidentally speak it as plain archived. Each group is sorted for
 *  display — god first, then alphabetical (card agent-monitor-lists-sort-
 *  agent-2026-08-18) — matching the written roster's order everywhere. */
export function splitRoster(rows: RosterRow[]): {
  active: RosterRow[];
  vacationing: RosterRow[];
  archived: RosterRow[];
} {
  return {
    active: rows.filter((r) => !r.archived).sort(compareAgentOrder),
    vacationing: rows.filter((r) => r.archived && !!r.vacation).sort(compareAgentOrder),
    archived: rows.filter((r) => r.archived && !r.vacation).sort(compareAgentOrder),
  };
}

/** The full spoken roster for list_agents (the directory fetch stays in the
 *  tool). Vacationers get their own sentence with recall guidance. */
export function rosterSpeech(rows: RosterRow[], includeArchived: boolean): string {
  const { active, vacationing, archived } = splitRoster(rows);
  const near = active
    .filter((e) => typeof e.contextPct === 'number' && (e.contextPct as number) >= 70)
    .map((e) => `${e.name} at ${e.contextPct} percent`);
  const describe = (e: RosterRow): string =>
    `${e.name} on ${e.provider}${e.cwd ? ` in ${shortDir(e.cwd)}` : ''}${
      typeof e.contextPct === 'number' ? `, context ${e.contextPct} percent` : ''
    }`;
  const parts: string[] = [];
  parts.push(
    `${plural(active.length, 'active agent')}${archived.length ? ` and ${plural(archived.length, 'archived agent')}` : ''}${vacationing.length ? `, plus ${plural(vacationing.length, 'agent')} on vacation` : ''}.`,
  );
  if (active.length) parts.push(`Active: ${active.slice(0, 12).map(describe).join('; ')}.`);
  if (vacationing.length)
    parts.push(
      `On vacation: ${vacationing
        .slice(0, 12)
        .map((e) => `${e.name}${e.cwd ? ` (last in ${shortDir(e.cwd)})` : ''}`)
        .join('; ')} — recall (respawn) to bring them back.`,
    );
  if (includeArchived && archived.length)
    parts.push(
      `Archived: ${archived
        .slice(0, 12)
        .map((e) => `${e.name}${e.cwd ? ` (last in ${shortDir(e.cwd)})` : ''}`)
        .join('; ')}.`,
    );
  if (near.length) parts.push(`Near their context limit: ${near.join(', ')}.`);
  return parts.join(' ');
}

/** The "where is it" phrase for get_agent_detail. */
export function agentWhere(e: RosterRow): string {
  if (e.archived && e.vacation)
    return 'on vacation — off the floor and resting at zero cost; recall it (respawn) to bring it back';
  if (e.archived)
    return 'archived — its terminal is closed, but its working directory and memory are still here';
  return `active and ${e.status || 'idle'}`;
}

/** One orientation line about parked agents for realtimeSessionSummary, or ''
 *  when nobody is on vacation. Takes a loose row shape — the summary reads the
 *  directory defensively (untyped obj() rows), so only what is spoken is
 *  required. */
export function vacationSummaryLine(
  rows: Array<Pick<RosterRow, 'name'> & Partial<Pick<RosterRow, 'archived' | 'vacation'>>>,
): string {
  const vacationing = rows.filter((r) => r.archived && !!r.vacation).sort(compareAgentOrder);
  if (!vacationing.length) return '';
  return `On vacation: ${vacationing
    .slice(0, 8)
    .map((e) => e.name)
    .join(', ')} — recall (respawn) to bring them back.`;
}
