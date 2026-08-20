/**
 * The /ticket-overview contract file (~/.cache/ticket-overview/tickets.json)
 * — the merged view the skill's `cmd_finish` writes next to its markdown
 * rendering (spec docs/superpowers/specs/2026-08-20-tickets-view.md §3).
 *
 * Deliberately NOT inside <harnessHome>/hive/: refreshable display data, not
 * coordination state — losing it costs one skill re-run (no git churn, no
 * single-writer problem). Version-gated: unknown FIELDS are ignored, an
 * unknown VERSION is a different contract and reads as "no data".
 */

/** One row of the digest. `recap` is null for inactive tickets and for active
 *  tickets whose recap is missing/stale (the skill resolves that). `roles` is
 *  the skill's compact string (A=assigned, R=reported, W=watching). */
export interface TicketRow {
  id: number;
  subject: string;
  priority: string;
  /** Redmine priority enum value — carried for completeness; the string above
   *  is what renders. Optional here because nothing in the harness reads it. */
  priority_id?: number;
  status: string;
  project: string;
  /** ISO-Z from Redmine (unlike generated_at — this one round-trips). */
  updated_on: string;
  roles: string;
  active: boolean;
  /** 1–2 lines; `**Next:**` is the only markdown marker to render bold. */
  recap: string | null;
}

export interface TicketsState {
  version: 1;
  /** LOCAL "YYYY-MM-DD HH:MM" — the skill's now_iso(); no zone, no seconds. */
  generated_at: string;
  redmine_base: string;
  /** Pre-sorted by the script (priority desc, then updated desc) — the
   *  renderer preserves order; no sorting logic duplicated in TS. */
  tickets: TicketRow[];
}

/** Angela's morning cadence + slack (spec §7) — keep it a named constant. */
export const TICKETS_STALE_MS = 26 * 60 * 60 * 1000;

/** Parse generated_at as LOCAL time. The string has no zone and no seconds —
 *  NOT ISO-Z — so it is constructed field-by-field; a lenient Date.parse
 *  would let each engine guess a timezone and show a WRONG staleness badge
 *  instead of failing loudly. Anything off-format parses to null (render the
 *  absolute string only, never a guessed badge). */
export function parseGeneratedAt(generatedAt: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(generatedAt);
  if (!m) return null;
  const [y, mo, d, h, mi] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
  const dt = new Date(y, mo - 1, d, h, mi);
  // Round-trip: the local constructor ROLLS OVER impossible fields
  // (2026-02-30 → March 2) instead of rejecting them — verify the fields
  // landed where they were put.
  if (
    dt.getFullYear() !== y ||
    dt.getMonth() !== mo - 1 ||
    dt.getDate() !== d ||
    dt.getHours() !== h ||
    dt.getMinutes() !== mi
  )
    return null;
  return dt.getTime();
}

const str = (v: unknown): v is string => typeof v === 'string';

function parseRow(v: unknown): TicketRow | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.id !== 'number') return null;
  if (!str(r.subject) || !str(r.priority) || !str(r.status) || !str(r.project)) return null;
  if (!str(r.updated_on) || !str(r.roles)) return null;
  if (typeof r.active !== 'boolean') return null;
  if (r.recap !== null && !str(r.recap)) return null;
  return {
    id: r.id,
    subject: r.subject,
    priority: r.priority,
    priority_id: typeof r.priority_id === 'number' ? r.priority_id : undefined,
    status: r.status,
    project: r.project,
    updated_on: r.updated_on,
    roles: r.roles,
    active: r.active,
    recap: r.recap ?? null,
  };
}

/** Validate an unknown parsed-JSON value as a TicketsState. Null on anything
 *  malformed — including a whole-file rejection on one bad row: the empty
 *  state (with its run command) is the visible signal, not 94 rows hiding a
 *  broken 95th. Unknown extra fields are ignored (version-gated contract). */
export function parseTicketsState(value: unknown): TicketsState | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return null;
  if (!str(v.generated_at) || !str(v.redmine_base) || !Array.isArray(v.tickets)) return null;
  // generated_at must satisfy the exact local-time contract — an off-format
  // value means the writer changed shape; the empty state is the signal.
  if (parseGeneratedAt(v.generated_at) === null) return null;
  // redmine_base becomes row hrefs opened in the external browser — it is
  // data from a local file another tool writes, so gate the scheme at the
  // trust boundary rather than trusting the writer.
  let base: URL;
  try {
    base = new URL(v.redmine_base);
  } catch {
    return null;
  }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') return null;
  const tickets: TicketRow[] = [];
  for (const t of v.tickets) {
    const row = parseRow(t);
    if (!row) return null;
    tickets.push(row);
  }
  return { version: 1, generated_at: v.generated_at, redmine_base: v.redmine_base, tickets };
}
