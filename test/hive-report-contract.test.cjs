'use strict';

/**
 * Done-report evidence labels (card agent-harness-verified-vs-infe-2026-08-17).
 *
 * Root incident #3216 (retracted 2026-08-17): an UNVERIFIED INFERENCE shipped
 * as a finding in a done-report ("crossed current/ symlinks, 3837 of 4061
 * duplicate groups"); god, running lean (records evidence without re-running
 * it), relayed the scale/infra claim to the operator — on challenge, no
 * symlinks were crossed. Fix = labeling discipline on BOTH ends:
 *  - WORKER side: every done-report claim labeled VERIFIED (check named) or
 *    INFERRED; quantitative headline numbers carry a one-line how-counted.
 *    Lives in the worker briefing (injectedPrompt — refreshed every spawn)
 *    and PROTOCOL.md (the worker rules doc, new hives).
 *  - GOD side (lean only): VERIFIED claims transfer without scrutiny, but an
 *    INFERRED or unlabeled scale/infra claim is NEVER relayed to the operator
 *    unflagged. Lives in the godLine lean branch and the LEAN_GOD_MD section
 *    of the hive-root AGENTS.md (prose kept in lockstep per house doctrine).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { HiveManager, hiveRootAgentsMd, PROTOCOL_MD } = loadTs('src/main/hive.ts');

// TS `private` is compile-time only — erased by transpile, reachable at runtime.
const injectedPrompt = HiveManager.prototype['injectedPrompt'];
const GOD = { id: 'michael', name: 'Michael', isGod: true, cwd: '/w' };
const WORKER = { id: 'pam', name: 'Pam', role: 'worker', cwd: '/w' };

test('worker briefing carries the evidence-label contract in EVERY mode', () => {
  for (const mode of ['god', 'workers', 'lean']) {
    const p = injectedPrompt.call(null, WORKER, '/agents/pam', '/hive', false, false, true, mode);
    assert.ok(/DONE-REPORT EVIDENCE LABELS:/.test(p), `mode ${mode}: rule present`);
    assert.ok(/VERIFIED \(name the check you ran/.test(p), 'VERIFIED names the check');
    assert.ok(/INFERRED/.test(p), 'INFERRED label defined');
    assert.ok(/how-counted/.test(p), 'quantitative numbers need a how-counted');
    assert.ok(/Never present an inference as a finding/.test(p));
  }
});

test('the worker duty stays worker-side — god gets the lean relay rule instead', () => {
  for (const mode of ['god', 'workers', 'lean']) {
    const p = injectedPrompt.call(null, GOD, '/agents/god', '/hive', false, false, true, mode);
    assert.ok(!p.includes('DONE-REPORT EVIDENCE LABELS'), `mode ${mode}: not in god briefing`);
  }
});

test('godLine lean branch: VERIFIED transfers, INFERRED never relayed unflagged', () => {
  const p = injectedPrompt.call(null, GOD, '/agents/god', '/hive', false, false, true, 'lean');
  assert.ok(/VERIFIED-CLAIM RELAY/.test(p), 'lean rule present');
  assert.ok(/transfer VERIFIED claims to the operator without scrutiny/.test(p));
  assert.ok(/NEVER relay an INFERRED or unlabeled scale\/infra claim/.test(p));
  assert.ok(/without flagging it unverified/.test(p));
  // lean-only: classic god mode runs no lean relay rule
  const classic = injectedPrompt.call(null, GOD, '/agents/god', '/hive', false, false, true, 'god');
  assert.ok(!classic.includes('VERIFIED-CLAIM RELAY'), 'classic god mode: no lean relay rule');
});

test('lean AGENTS.md section carries the relay discipline', () => {
  const md = hiveRootAgentsMd(true, 'lean');
  assert.ok(/Relay discipline/.test(md), 'lean section carries the rule');
  assert.ok(/without scrutiny/.test(md), 'VERIFIED transfers without scrutiny');
  assert.ok(/flagging it as unverified/.test(md), 'INFERRED must be flagged');
  assert.ok(!hiveRootAgentsMd(true, 'workers').includes('Relay discipline'), 'workers: n/a');
  assert.ok(!hiveRootAgentsMd(true, 'god').includes('Relay discipline'), 'god/classic: n/a');
});

test('PROTOCOL.md documents the VERIFIED/INFERRED contract for workers', () => {
  assert.ok(/## Done-reports: label your evidence/.test(PROTOCOL_MD), 'section exists');
  assert.ok(/\*\*VERIFIED\*\* — you ran the check/.test(PROTOCOL_MD), 'VERIFIED defined');
  assert.ok(/\*\*INFERRED\*\* — you concluded it without a direct check/.test(PROTOCOL_MD));
  assert.ok(/how counted/.test(PROTOCOL_MD), 'quantitative numbers need a how-counted');
});
