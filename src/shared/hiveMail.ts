/**
 * Shared mail classification — the ONE system-sender list.
 *
 * Born from index.ts (god's actionable-inbox count + hasOpenWork) where it gated
 * which mail counts as real work. Two more consumers needed the same distinction
 * (the renderer's inbox-wake nudge, FYI classification), so it moved here rather
 * than growing a second copy. Keep it narrow on purpose: everything NOT in this
 * set is real mail by default, so a future sender can never be silenced by
 * omission.
 *
 * Shared between main and renderer; keep it dependency-free.
 */

/** Senders whose mail is the system talking to itself (scheduler beats, breaker
 *  steers, ephemeral-worker lifecycle notices, generic 'system') — never a reason
 *  to wake an agent on its own. */
export const SYSTEM_SENDERS = new Set(['heartbeat', 'scheduler', 'breaker', 'system', 'ephemeral-worker']);

/** Is this message mail from a system sender (not a real agent/human)? */
export function isSystemMail(from: string | undefined): boolean {
  return SYSTEM_SENDERS.has((from ?? '').trim().toLowerCase()) || !(from ?? '').trim();
}

/** FYI mail — pure notification. It must NEVER wake anyone: no typed nudge, no
 *  monitor event. It waits for the agent's next natural inbox drain. Concretely:
 *  act 'inform' from a system sender. A REQUEST from a system sender is still a
 *  wake (scheduler standups ask god to act; breaker steers must interrupt a
 *  looping agent) — only the FYI half is muted. */
export function isFyiMail(m: { from?: string; act?: string }): boolean {
  return isSystemMail(m.from) && (m.act ?? 'inform') === 'inform';
}
