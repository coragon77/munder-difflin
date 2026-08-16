// ─── god-triggered pane session control (card session-requests-dropdir-20260816) ──
// god drops a request JSON into HIVE_ROOT/session-requests/ to steer an agent's
// LIVE pane into a fresh (`/clear`) or resumed (`/resume <sessionId>`)
// conversation. MAIN only VALIDATES and BROADCASTS: the slash command rides the
// existing `realtime:enqueue` IPC channel, where the renderer's effect (useHive
// 5c) enqueues it into the agent's message queue and the queue-drain effect
// types it in — never a direct PTY write from MAIN. Delivery therefore inherits
// every existing gate (idle-only, boot grace, user-draft/picker safety,
// auto-delivery pause).
//
// Dependency-injected like realtimeActions.ts so node:test can drive the whole
// flow with a fake hive (tmp root, in-memory registry, spy emit) — index.ts
// wires the real implementations at bootstrap.

import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { contextCommandsForProvider } from '../shared/providerAutomation';
import type { AgentProvider } from '../shared/agentProvider';

/** A session request god drops into HIVE_ROOT/session-requests/<id>.json. */
export interface SessionRequest {
  agentId?: string;
  verb?: string;          // 'clear' | 'resume'
  sessionId?: string;     // resume only
}

/** Everything the watcher needs from the host process (see index.ts wiring). */
export interface SessionRequestDeps {
  /** Hive root, or null when the hive is disabled. */
  root(): string | null;
  /** Live registry snapshot (structural subset of hive.Registry). */
  registry(): { agents: Record<string, { provider?: AgentProvider; archived?: boolean; retired?: boolean }> };
  /** PTY id of the agent's live pane, or undefined when none is open. */
  ptyForAgent(agentId: string): string | undefined;
  /** Broadcast the command to the renderer's queue gate. false = no listener
   *  (window down) → the request fails rather than silently archiving .done. */
  emit(agentId: string, text: string): boolean;
  /** Surface a rejection in god's inbox (same contract as the spawn watcher). */
  informGod(subject: string, body: string): void;
}

/** The queue dir god drops requests into (mirrors spawn-requests/fire-requests). */
export function sessionRequestsDir(root: string): string {
  return join(root, 'session-requests');
}

/** Validate the request shape and compose the slash command to queue.
 *  Pure — no fs, no deps — so it is directly unit-testable. `clear` uses the
 *  shared provider table (grok's clear is `/new`, not `/clear`); `resume` is
 *  claude TUI semantics (`/resume <sessionId>`, exact-UUID acceptance is a
 *  verify-after-integrate item on the card). */
export function composeSessionCommand(
  raw: SessionRequest,
  provider: AgentProvider | undefined
): { ok: true; command: string } | { ok: false; reason: string } {
  const verb = typeof raw.verb === 'string' ? raw.verb.trim().toLowerCase() : '';
  if (verb !== 'clear' && verb !== 'resume') {
    return { ok: false, reason: `"verb" must be 'clear' or 'resume' (got ${JSON.stringify(raw.verb ?? '')})` };
  }
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId.trim() : '';
  if (verb === 'resume' && !sessionId) return { ok: false, reason: '"resume" requires a "sessionId"' };
  if (verb === 'clear' && sessionId) return { ok: false, reason: '"clear" takes no "sessionId" (resume-only field)' };
  if (verb === 'resume') return { ok: true, command: `/resume ${sessionId}` };
  // Undefined provider = the app's default engine (claude), matching
  // readConfig().defaultCommand's fallback.
  const cmd = contextCommandsForProvider(provider ?? 'claude').clear;
  return cmd ? { ok: true, command: cmd } : { ok: false, reason: `provider "${provider ?? 'claude'}" has no clear command` };
}

/** Move a processed request out of the queue so it's never reprocessed
 *  (same archive contract as spawn-requests: atomic rename, unlink as the
 *  poison-file last resort). */
function archiveRequest(root: string, filePath: string, sub: '.done' | '.failed'): void {
  try {
    const dir = join(sessionRequestsDir(root), sub);
    mkdirSync(dir, { recursive: true });
    renameSync(filePath, join(dir, basename(filePath)));
  } catch (e) {
    try { unlinkSync(filePath); } catch { /* noop */ }
    console.error('[session] archiving request failed (deleted):', filePath, e);
  }
}

/** Validate one request file, broadcast the composed command, archive it.
 *  Every rejection informs god and archives .failed; only an emitted command
 *  archives .done. */
export function processSessionRequest(filePath: string, deps: SessionRequestDeps): void {
  const root = deps.root();
  const name = basename(filePath);
  if (!root) {
    deps.informGod('[session rejected] hive disabled', `Session-request ${name} arrived with no hive root.`);
    try { unlinkSync(filePath); } catch { /* already gone */ }
    return;
  }
  let raw: SessionRequest;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8')) as SessionRequest;
  } catch (e) {
    console.error('[session] unparseable request:', filePath, e);
    deps.informGod('[session rejected] unparseable request', `Could not parse session-request ${name} — ${String(e)}`);
    archiveRequest(root, filePath, '.failed');
    return;
  }
  const fail = (reason: string): void => {
    deps.informGod(`[session rejected] ${reason}`, `Session-request ${name} rejected: ${reason}.`);
    archiveRequest(root, filePath, '.failed');
  };

  const agentId = typeof raw.agentId === 'string' ? raw.agentId.trim() : '';
  if (!agentId) { fail('missing "agentId"'); return; }

  const entry = deps.registry().agents[agentId];
  if (!entry) { fail(`no agent "${agentId}" in the registry`); return; }
  if (entry.archived) { fail(`"${agentId}" is archived — unarchive (or restore) it before steering its pane`); return; }
  if (entry.retired) { fail(`"${agentId}" is retired`); return; }
  if (!deps.ptyForAgent(agentId)) { fail(`"${agentId}" has no live pane — open (or restore) its terminal first`); return; }

  const cmd = composeSessionCommand(raw, entry.provider);
  if (!cmd.ok) { fail(cmd.reason); return; }

  if (!deps.emit(agentId, cmd.command)) {
    fail('no live floor window to receive the command — retry once the app window is up');
    return;
  }
  console.log(`[session] queued "${cmd.command}" for ${agentId}`);
  archiveRequest(root, filePath, '.done');
}

/** One poll tick: process every *.json sitting in the queue dir, oldest name
 *  first (sorted, matching the spawn watcher). */
export function sessionRequestTick(deps: SessionRequestDeps): void {
  const root = deps.root();
  if (!root) return;
  const dir = sessionRequestsDir(root);
  if (!existsSync(dir)) return;
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { /* dir vanished */ }
  for (const f of files) processSessionRequest(join(dir, f), deps);
}

/** Polling cadence — matches the hive router / spawn watcher. */
const SESSION_TICK_MS = 1500;
let sessionWatchTimer: ReturnType<typeof setInterval> | null = null;

/** Start the watcher: mkdir the queue dir, poll it. Idempotent. The tick reads
 *  deps.root() fresh each pass, so a changeHome re-bootstrap re-points it at
 *  the new hive without a stop/start cycle (a stray tick is a no-op readdir). */
export function startSessionRequestWatcher(deps: SessionRequestDeps): void {
  if (sessionWatchTimer || !deps.root()) return;
  try { mkdirSync(sessionRequestsDir(deps.root()!), { recursive: true }); } catch { /* noop */ }
  sessionWatchTimer = setInterval(() => { sessionRequestTick(deps); }, SESSION_TICK_MS);
}

export function stopSessionRequestWatcher(): void {
  if (sessionWatchTimer) { clearInterval(sessionWatchTimer); sessionWatchTimer = null; }
}
