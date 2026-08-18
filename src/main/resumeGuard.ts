/**
 * Resume guard for non-claude CLIs (deputy card god-pi-switch-2026-08-18).
 *
 * `sessionId` is provider-DIALECT state: after an engine switch the registry
 * still holds the previous CLI's session id, and attaching it to the new CLI's
 * resume flag kills the spawn (`pi --resume <claude-uuid>` → exit 1, live
 * incident 2026-08-18). The claude branch validates via seedSessionTranscript,
 * codex via findCodexHomeForSession — pi gets the same treatment HERE: the
 * resume flag may only attach when the sid matches a session file in the
 * agent's OWN .pi-agent/sessions tree.
 *
 * ponytail: pi-only — other rf-resuming CLIs (agy --conversation) need their
 * own store dialect; add a branch when one actually resumes cross-engine.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** True when `<agentDir>/.pi-agent/sessions/**` contains a session file for
 *  `sid` (pi names them `<timestamp>_<session-id>.jsonl`). */
export function piSessionExists(agentDir: string, sid: string): boolean {
  if (!sid.trim()) return false;
  const sessionsRoot = join(agentDir, '.pi-agent', 'sessions');
  if (!existsSync(sessionsRoot)) return false;
  const wanted = sid.trim();
  const walk = (dir: string): boolean => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (walk(full)) return true;
      } else if (entry.name.endsWith(`_${wanted}.jsonl`) || entry.name === `${wanted}.jsonl`) {
        return true;
      }
    }
    return false;
  };
  try {
    return walk(sessionsRoot);
  } catch {
    return false;
  }
}
