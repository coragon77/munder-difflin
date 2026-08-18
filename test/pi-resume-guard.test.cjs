'use strict';

/**
 * pi resume guard (deputy card god-pi-switch-2026-08-18, fix 1 of 2).
 *
 * The non-claude spawn branch attached `--resume <sid>` BLIND: the claude
 * branch validates via seedSessionTranscript, codex via findCodexHomeForSession
 * — pi got neither. After a provider switch (save-only button, manual config
 * edit, patcher), the registry still holds a CLAUDE-era sessionId, and the
 * next boot ran `pi --resume <claude-uuid>` → exit 1 (live incident
 * 2026-08-18: god's pane died instantly after the pi flip).
 *
 * Guard: for pi, the resume flag is attached only when the sid matches a
 * session file in the agent's OWN .pi-agent/sessions tree; on miss → drop the
 * flag, start fresh, warn. All callers (app-start boot, power-resume,
 * restart&continue) route through this one branch.
 *
 * ponytail: pi-only — other rf-resuming CLIs (agy) need their own store
 * dialect; add a branch here when one actually resumes cross-engine.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const loadTs = require('./load-ts.cjs');

const { piSessionExists } = loadTs('src/main/resumeGuard.ts');
const read = (...p) => readFileSync(join(__dirname, '..', ...p), 'utf8');

// ——— piSessionExists: the agent's own sessions tree is the truth ——————————

test('matches a session file named <ts>_<sid>.jsonl anywhere in .pi-agent/sessions', () => {
  const dir = join('/tmp', 'pi-resume-guard-test-1', 'agents', 'god');
  rmSync(join('/tmp', 'pi-resume-guard-test-1'), { recursive: true, force: true });
  const sess = join(dir, '.pi-agent', 'sessions', '--home-hive--');
  mkdirSync(sess, { recursive: true });
  const sid = '01a015bf-bd65-7aca-afa1-740299979658';
  writeFileSync(join(sess, `2026-08-18T16-41-22-533Z_${sid}.jsonl`), '{}');
  assert.equal(piSessionExists(dir, sid), true, 'sid file present → resumable');
  assert.equal(
    piSessionExists(dir, '5e288e27-4894-4914-85c9-7756dcdde6fb'),
    false,
    'claude-era sid → NOT resumable in pi (the incident)',
  );
});

test('missing sessions tree entirely → false (fresh agent, fresh boot)', () => {
  assert.equal(piSessionExists('/tmp/pi-resume-guard-test-empty-agent', 'whatever'), false);
});

// ——— wiring: the non-claude resume branch guards pi before attaching ——————

test('spawnAgentCore checks piSessionExists before attaching --resume', () => {
  const src = read('src/main/index.ts');
  assert.match(src, /piSessionExists\(/, 'the guard is wired into the spawn path');
  // The NON-claude branch is where rf-resume attaches — anchor there (the
  // claude branch has its own typedSid).
  const branch = src.slice(src.indexOf('if (opts.hive && !claudeProvider)'));
  const guard = branch.indexOf('piSessionExists(');
  const attach = branch.indexOf('args.push(rf, sid)');
  assert.ok(guard > 0 && attach > guard, 'guard runs BEFORE the flag attach');
  assert.match(
    branch,
    /resumeNotFound = true/,
    'a TYPED sid that is missing still flags resumeNotFound (dialog truth)',
  );
});
