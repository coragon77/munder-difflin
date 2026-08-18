/**
 * The ONE display order for grouped agent lists (card agent-monitor-lists-
 * sort-agent-2026-08-18): god pinned first (operator's call — "you stay on
 * top"), everyone else alphabetical by name, id as fallback/tiebreak. Groups
 * (active / vacation / archived) sort independently — each caller sorts its own
 * group; membership and store/fleet write order are untouched. Loose shape on
 * purpose: fleet.json rows, renderer Agent, and voice-directory rows all fit.
 */
export interface OrderableAgent {
  id?: string;
  name?: string;
  isGod?: boolean;
}

export function compareAgentOrder(a: OrderableAgent, b: OrderableAgent): number {
  if (!!a.isGod !== !!b.isGod) return a.isGod ? -1 : 1;
  return (a.name || a.id || '').localeCompare(b.name || b.id || '');
}
