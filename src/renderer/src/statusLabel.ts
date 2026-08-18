import type { StatusKind } from './components/PixelBadge';
import { waitingLabel } from '../../shared/waitingLabel';

/**
 * waiting ≠ idle — DISPLAY derivation (card agent-waiting-vs-idle-display--
 * 2026-08-17). A settled agent with pending finite background work (CI monitor,
 * background shell, in-flight subagent) reads as WAITING on every badge, not
 * idle. Derived at render from the volatile `Agent.pending` census — like
 * `typing` (hasTerminalDraft), never the store's status authority: hook events
 * keep flowing, and a count that TTL-decays in main self-heals here on the
 * next poll. An actively working/typing agent keeps its stronger state; the
 * census only upgrades idle (and labels an already-waiting one with its count).
 */
export function waitingBadge(
  status: StatusKind,
  pending?: number,
): { status: StatusKind; label?: string } {
  const n = typeof pending === 'number' && pending > 0 ? Math.floor(pending) : 0;
  if (!n || (status !== 'idle' && status !== 'waiting')) return { status };
  return { status: 'waiting', label: waitingLabel(n) };
}
