/**
 * parkAgent's busy gate (card vacation-busy-check-tui-repaint-20260816).
 * Extracted from index.ts so the rule is testable — the Electron main entry
 * cannot be loaded from the .cjs test harness (parkedAgentIds precedent).
 */

/** An agent counts as BUSY when it did REAL WORK inside this window: a tool
 *  call or inference, as seen by TelemetryCollector (hook/OTLP lastActive).
 *
 *  Why 60s: those signals fire per tool call / token batch, so inter-event
 *  gaps in an active session routinely exceed the old 10s (one 30s bash tool,
 *  a long inference turn) but essentially never exceed 60s while work
 *  continues. 60s keeps genuine activity busy AND lets "it went quiet" be
 *  noticed within a minute of pressing park.
 *
 *  Why not PTY output: an idle claude TUI repaints its chrome continuously —
 *  "printed recently" was permanently true and the gate refused idle agents
 *  (the bug this module fixes). PTY output survives only as the FALLBACK for
 *  providers with NO telemetry plane (no hooks, no OTLP, no proxy — nothing
 *  else to ask); for those the repaint false-positive remains, knowingly,
 *  until every provider reports through one of the telemetry planes.
 *
 *  Absence is ambiguous and the third input disambiguates it (card
 *  vacation-busy-fresh-boot-20260817): a telemetry-CAPABLE agent with no row
 *  is one that has been silent since boot — silence IS idleness, so it is
 *  parkable, NOT thrown into the PTY fallback where the TUI repaint would
 *  refuse it forever. A no-plane provider with no row keeps the fallback,
 *  its documented residual. */
export const VACATION_BUSY_MS = 60_000;

/** Busy = real work inside the window. Telemetry is strictly primary — if a
 *  row exists it decides even when the PTY disagrees (stale row + chatty pane
 *  → parkable; fresh row + quiet pane → busy). With NO row:
 *  providerReportsTelemetry decides what the absence means — true (claude
 *  hooks/OTLP, or a hook/proxy bridge) means silent-since-boot → not busy;
 *  false/omitted falls back to PTY output, the no-plane residual.
 *  undefined = signal absent. */
export function vacationBusy(
  telemetryAgeMs: number | undefined,
  ptyIdleMs: number | undefined,
  providerReportsTelemetry = false,
): boolean {
  if (telemetryAgeMs !== undefined) return telemetryAgeMs < VACATION_BUSY_MS;
  if (providerReportsTelemetry) return false;
  if (ptyIdleMs !== undefined) return ptyIdleMs < VACATION_BUSY_MS;
  return false;
}
