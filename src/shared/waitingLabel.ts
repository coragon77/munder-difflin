/**
 * The ONE builder of the agent waiting label (card agent-shorten-the-agent-
 * card-w-2026-08-18). It was hand-built in four places (renderer badge
 * derivation, renderer hook action, god roster injection, hooks notify) and
 * drifted — every surface routes through this now. Lives in shared/ because
 * two callers are main-process, two renderer. Wording is an operator call:
 * literally "wait (N)", bare number — do not re-add a labelled variant, and
 * keep it one word + count: it has to fit on ONE line in the agent pane
 * (the longer "waiting (N)" wrapped; card
 * agent-agent-pane-shorten-waiti-2026-08-19).
 */
export function waitingLabel(n: number): string {
  return `wait (${Math.floor(n)})`;
}
