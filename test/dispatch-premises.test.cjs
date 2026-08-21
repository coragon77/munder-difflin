'use strict';

/**
 * Dispatch premises are unverified pass-through (card
 * agent-worker-contract-dispatch-2026-08-21).
 *
 * Robert's adjudication (card agent-god-s-dispatch-contracts-2026-08-21):
 * reportContractLine imposed VERIFIED/INFERRED labels on the worker->god
 * direction only — the god->worker direction had no label discipline at all.
 * Incident: a worker received his own hedged pane flag back as a confirmed
 * premise carrying his own name, implemented it faithfully, and only a
 * fresh-context reviewer caught that it would have broken storno on every
 * Beleg carrying an Uebertrag. Self-attributed claims get LESS scrutiny, not
 * more. The sentence below is adjudicated verbatim — do not reword it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

// TS `private` is compile-time only — erased by transpile, reachable at runtime.
const injectedPrompt = HiveManager.prototype['injectedPrompt'];
const GOD = { id: 'michael', name: 'Michael', isGod: true, cwd: '/w' };
const WORKER = { id: 'pam', name: 'Pam', role: 'worker', cwd: '/w' };

// Adjudicated text (god's dispatch, quoting Robert verbatim). Any change here
// must go back through adjudication — the wording IS the spec.
const SENTENCE =
  'DISPATCH PREMISES: technical claims in a dispatch carry the same labels your reports owe god; an unlabeled diagnosis — even one attributed to you — is unverified pass-through. Verify the premise before building on it: confirming the cited lines exist is not confirming the diagnosis is true — trace the flow the diagnosis implies. A disproved premise is the card SUCCEEDING by hold-and-report, not failing.';

test('worker briefing carries the dispatch-premises sentence VERBATIM in every mode', () => {
  for (const mode of ['god', 'workers', 'lean']) {
    const p = injectedPrompt.call(null, WORKER, '/agents/pam', '/hive', false, false, true, mode);
    assert.ok(p.includes(SENTENCE), `mode ${mode}: adjudicated sentence present verbatim`);
  }
});

test('the sentence sits in the worker briefing beside the evidence-label contract', () => {
  const p = injectedPrompt.call(null, WORKER, '/agents/pam', '/hive', false, false, true, 'lean');
  assert.ok(/DONE-REPORT EVIDENCE LABELS:/.test(p), 'sibling contract present');
  assert.ok(
    p.indexOf('DISPATCH PREMISES:') < p.indexOf('INTEGRATION — WORKER-SIDE'),
    'before the integration line',
  );
});

test('the dispatch-premises duty stays worker-side — god never receives it', () => {
  for (const mode of ['god', 'workers', 'lean']) {
    const p = injectedPrompt.call(null, GOD, '/agents/god', '/hive', false, false, true, mode);
    assert.ok(!p.includes('DISPATCH PREMISES:'), `mode ${mode}: not in god briefing`);
  }
});
