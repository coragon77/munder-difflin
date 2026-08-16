'use strict';

/**
 * Session naming for hires (card session-naming-seed-20260816 + its amendment).
 *
 * CLIs name a session after the first user prompt. For a fresh hire that prompt
 * was always the generic "read your inbox" nudge (verified live: intern
 * transcripts' first user turn), so every session was titled that. The fix:
 * derive a short engagement label at spawn time (explicit spawn-request
 * `label`/`title` field, else the objective's first sentence) and LEAD the
 * first prompt with it — the typed wake nudge (claude), the positional/flag
 * initial prompt (codex/grok/agy), and the typed TUI seed (crush) all lead
 * with the same label via AgentMeta.spawnLabel.
 *
 * Also covers the amendment: the god briefing's dispatch contract must tell
 * god to set a skill-driven workflow's execution mode explicitly
 * (subagent-driven default, inline only for trivial plans).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { HiveManager, deriveSpawnLabel } = loadTs('src/main/hive.ts');

// ——— deriveSpawnLabel ————————————————————————————————————————————————

test('explicit label wins verbatim (trimmed)', () => {
  assert.equal(deriveSpawnLabel('  vacation-state implementation ', 'whatever the objective says'), 'vacation-state implementation');
});

test('no explicit label → first sentence of the objective, whitespace collapsed', () => {
  assert.equal(
    deriveSpawnLabel(undefined, 'Fix DIVA ticket 42. More contract detail follows. Even more.'),
    'Fix DIVA ticket 42'
  );
});

test('multi-line objective: only the first line is considered', () => {
  assert.equal(
    deriveSpawnLabel(undefined, 'Draft a CONTRIBUTING.md for the repo.\nSEQUENCE — do X then Y.'),
    'Draft a CONTRIBUTING.md for the repo'
  );
});

test('long objective is capped at 80 chars on a word boundary with an ellipsis', () => {
  const label = deriveSpawnLabel(undefined,
    'implement the approved vacation-state spec (munder-difflin main 89a2987, docs/superpowers/specs/2026-08-16-vacation-state-design.md) — parked agent pool for human-created agents, god-autonomous park/fetch, VACATION section above ARCHIVED, delete only after end-vacation');
  assert.ok(label.length <= 81, `label too long: ${label.length}`);
  assert.ok(label.endsWith('…'));
  assert.ok(!label.includes('\n'));
  // 'design.md' contains no sentence break (no whitespace after the period),
  // so the cap — not the sentence split — does the cutting here.
  assert.ok(label.startsWith('implement the approved vacation-state spec'));
});

test('short objective passes through unchanged', () => {
  assert.equal(deriveSpawnLabel(undefined, 'Read the repo and draft a CONTRIBUTING.md; report to god when done'), 'Read the repo and draft a CONTRIBUTING.md; report to god when done');
});

test('empty inputs → empty label (callers keep today’s generic first turn)', () => {
  assert.equal(deriveSpawnLabel(undefined, ''), '');
  assert.equal(deriveSpawnLabel('   ', '   '), '');
});

// ——— injectedPrompt leads with the label (positional-prompt + TUI-seed engines) ———

// TS `private` is compile-time only — erased by transpile, reachable at runtime.
const injectedPrompt = HiveManager.prototype['injectedPrompt'];
const META = { id: 'intern-x', name: 'X (Intern)', role: 'intern', cwd: '/w' };

test('labeled meta: the injected prompt OPENS with the label line', () => {
  const p = injectedPrompt.call(null, { ...META, spawnLabel: 'vacation-state implementation' }, '/agents/x', '/hive', false, false);
  const first = p.split('\n')[0];
  assert.ok(first.startsWith('vacation-state implementation'), `first line was: ${first}`);
  assert.ok(first.includes('full dispatch in your hive inbox'));
  // The protocol body is untouched below the label line.
  assert.ok(p.includes('HIVE PROTOCOL'));
  assert.ok(p.includes('You are "X (Intern)" (intern-x)'));
});

test('unlabeled meta: prompt is exactly today’s shape (no label line)', () => {
  const p = injectedPrompt.call(null, META, '/agents/x', '/hive', false, false);
  assert.ok(p.startsWith('You are "X (Intern)" (intern-x)'));
  assert.ok(p.includes('HIVE PROTOCOL'));
});

// ——— god-briefing amendment: skill-driven dispatches must set execution mode ———

test('godLine tells god to set the execution mode on skill-driven dispatches', () => {
  const p = injectedPrompt.call(null, { ...META, isGod: true }, '/agents/god', '/hive', false, false);
  assert.ok(/SKILL-DRIVEN WORK:/.test(p), 'god briefing must carry the SKILL-DRIVEN WORK rule');
  assert.ok(/execution mode explicitly/.test(p));
  assert.ok(/SUBAGENT-DRIVEN/.test(p) && /inline execution only for trivial plans/.test(p));
});
