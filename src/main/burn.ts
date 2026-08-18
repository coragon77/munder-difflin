/**
 * Rolling-window token burn per agent, derived from the append-only cost
 * ledger (card agent-rolling-window-token-bur-2026-08-18).
 *
 * WHY THE LEDGER: every other burn surface (fleet usd, the renderer fleet
 * grid's samples/rate) reads the in-memory TelemetryCollector, which starts
 * empty on every app restart — exactly the lens that read 0.00 while tokens
 * climbed (2026-08-18 incident). cost-ledger.jsonl is append-only, covers
 * every provider (hook-plane CostSamples and Claude's OTLP samples are both
 * appended to it), and survives restarts unchanged.
 *
 * UNKNOWN IS NEVER ZERO: an agent with no ledger rows inside the window is
 * reported as ABSENT from `agents` (rendered as "—" / null). An empty or
 * partial window must read as unknown — the operator tunes dispatch on this
 * number, and a false zero is worse than a blank.
 */
import { openSync, readSync, closeSync, statSync } from 'node:fs';

export interface BurnWindows {
  /** Trailing window length in ms (5h — the operator's usage-budget window). */
  windowMs: number;
  /** agentId → tokens burned inside the trailing window. Absent = unknown. */
  agents: Record<string, number>;
  /** Sum over agents that have in-window rows; null when NOBODY does. */
  total: number | null;
  /** In-window rows retained (diagnostics only). */
  rowsKept: number;
}

interface KeptRow {
  ts: number;
  agentId: string;
  tokens: number;
}

interface Cursor {
  offset: number;
  /** Bytes after the last complete newline — a half-written JSONL row. */
  pending: string;
  rows: KeptRow[];
}

const cursors = new Map<string, Cursor>();

/**
 * Sliding-window burn sums for one ledger file. Incremental: only the bytes
 * appended since the previous call are read (the ledger grows continuously and
 * is written under the 8s fleet-snapshot tick); a file that shrank (rotation,
 * manual edit) resets the cursor and rescans. `now` is injectable for tests.
 */
export function burnWindows(
  ledgerPath: string,
  windowMs: number,
  now: number = Date.now(),
): BurnWindows {
  const out: BurnWindows = { windowMs, agents: {}, total: null, rowsKept: 0 };
  let cur = cursors.get(ledgerPath);
  try {
    const size = statSync(ledgerPath).size;
    if (!cur) {
      cur = { offset: 0, pending: '', rows: [] };
      cursors.set(ledgerPath, cur);
    } else if (size < cur.offset) {
      cur = { offset: 0, pending: '', rows: [] };
      cursors.set(ledgerPath, cur);
    }
    if (size > cur.offset) {
      const fd = openSync(ledgerPath, 'r');
      try {
        const chunk = Buffer.alloc(size - cur.offset);
        readSync(fd, chunk, 0, chunk.length, cur.offset);
        const text = cur.pending + chunk.toString('utf8');
        const lastNl = text.lastIndexOf('\n');
        if (lastNl === -1) {
          cur.pending = text;
        } else {
          for (const line of text.slice(0, lastNl).split('\n')) {
            const row = parseRow(line);
            if (row) cur.rows.push(row);
          }
          cur.pending = text.slice(lastNl + 1);
        }
        cur.offset = size;
      } finally {
        closeSync(fd);
      }
    }
  } catch {
    /* missing/unreadable ledger — no data is unknown, not zero */
    return out;
  }
  // Age out rows outside the window (filter, not front-trim: ledger rows are
  // appended at event time so they are ~chronological, but a late-written row
  // with an old ts must not survive just because it sits at the back).
  const cutoff = now - windowMs;
  cur.rows = cur.rows.filter((r) => r.ts >= cutoff);
  for (const r of cur.rows) {
    out.agents[r.agentId] = (out.agents[r.agentId] ?? 0) + r.tokens;
    out.rowsKept++;
  }
  out.total = out.rowsKept > 0 ? Object.values(out.agents).reduce((a, b) => a + b, 0) : null;
  return out;
}

/** One ledger row → kept row; unparseable lines are skipped, never thrown. */
function parseRow(line: string): KeptRow | null {
  const s = line.trim();
  if (!s) return null;
  try {
    const r = JSON.parse(s) as {
      agent_id?: string;
      ts?: number;
      input?: number;
      output?: number;
      cache_read?: number;
      cache_creation?: number;
    };
    if (!r.agent_id || typeof r.ts !== 'number') return null;
    const tokens = (r.input ?? 0) + (r.output ?? 0) + (r.cache_read ?? 0) + (r.cache_creation ?? 0);
    if (tokens <= 0) return null;
    return { ts: r.ts, agentId: r.agent_id, tokens };
  } catch {
    return null;
  }
}

/** Test seam: forget a file's cursor (tests reuse tmp paths). */
export function resetBurnCursor(ledgerPath?: string): void {
  if (ledgerPath === undefined) cursors.clear();
  else cursors.delete(ledgerPath);
}
