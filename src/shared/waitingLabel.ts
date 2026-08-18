/**
 * The ONE builder of the agent waiting label (card agent-shorten-the-agent-
 * card-w-2026-08-18). It was hand-built in four places (renderer badge
 * derivation, renderer hook action, god roster injection, hooks notify) and
 * drifted — every surface routes through this now. Lives in shared/ because
 * two callers are main-process, two renderer. Wording is an operator call:
 * literally "waiting (N)", bare number — do not re-add a labelled variant.
 */
export function waitingLabel(n: number): string {
  return `waiting (${Math.floor(n)})`;
}
