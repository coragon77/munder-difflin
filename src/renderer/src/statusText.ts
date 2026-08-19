/**
 * STATUS TEXT SANITISER (card agent-restore-parked-agents-de-2026-08-19).
 *
 * The live status shown on rows is SCRAPED from raw pane output, and pane
 * output carries ANSI control sequences — not just the SGR colour codes the
 * pty parser used to strip, but cursor-position (`\x1b[26G`), erase-line
 * (`\x1b[K`) and friends. Dwight's monitor row rendered them as visible junk
 * ('no completion record w:[26Gs found…') because the scrape captured them
 * verbatim. One helper, applied at the WRITE point (usePtyParser) and at the
 * persisted-row hydrate points (store loaders), keeps every consumer clean —
 * no display patches.
 */

// CSI sequences (colours, cursor moves, erases): ESC [ <params> <letter>,
// plus OSC (ESC ] … BEL/ST), other two-byte ESC escapes, and C0 controls
// (everything below space except \n/\t, plus DEL). \n survives to be
// collapsed as whitespace below.
const CONTROL_RE =
  /\x1b\[[0-9:;<=>?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** Row-length cap for scraped status text: fits the widest row that renders
 *  it (Command Center / agent cards); longer text ends in a visible ellipsis. */
const MAX_STATUS_LEN = 120;

/** Strip ANSI/control sequences, collapse all whitespace runs to single
 *  spaces, trim, and cap the length with a visible ellipsis. Pure. */
export function sanitizeStatusText(text: string, maxLen: number = MAX_STATUS_LEN): string {
  const flat = text.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  if (flat.length <= maxLen) return flat;
  return `${flat.slice(0, maxLen - 1).trimEnd()}…`;
}
