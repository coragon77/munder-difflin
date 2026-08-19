/**
 * ROLE IS IDENTITY — the registry field god routes work on. When it is absent
 * it must render as unmistakably unknown, NEVER as a placeholder that reads
 * like a real role: a plausible-sounding default ('agent', 'on standby') is
 * how a wiped role caused the Ryan/merlin_oegb misroute (a recall that cleared
 * a customer agent's pane). One shared constant so every surface — the
 * renderer's agent directory + edit dialog (card
 * agent-separate-agent-identity--2026-08-19) and the main-side roster line god
 * reads (card agent-stop-the-registry-role-d-2026-08-19) — says the same thing.
 */
export const UNKNOWN_ROLE = 'role: UNKNOWN — ask before routing';
