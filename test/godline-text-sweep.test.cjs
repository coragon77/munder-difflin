'use strict';

/**
 * godLine + spawn-footer text sweep (card agent-harness-intern-spawn-foo-
 * 2026-08-17). Three stale/contradictory texts:
 *  - INTERN/WORKER spawn footers hardcode "Do NOT push … god is the sole
 *    integrator", contradicting integrationMode 'workers'/'lean' where the
 *    DISPATCH contract explicitly orders self-merge+push (bit Glenn, Hank and
 *    Nate on 2026-08-17). RULING: the dispatch contract wins — the footer must
 *    DEFER to integrationMode/the dispatch, never assert a blanket push ban.
 *  - godLine VACATION paragraph predates whenQuiet (card park-when-quiet,
 *    975126f): a park request with "whenQuiet": true is HELD while the agent
 *    is busy, not rejected. The briefing must say so.
 *  - "god is the sole scribe of board.md" is stale since f415122: the standup
 *    clerk appends ONE line per anomalous standup. Every sole-scribe text
 *    names that exception.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// TS `private` is compile-time only — erased by transpile, reachable at runtime.
const injectedPrompt = HiveManager.prototype['injectedPrompt'];
const GOD = { id: 'god', name: 'God', role: 'god', cwd: '/w', isGod: true };

test('spawn footers defer to integrationMode/dispatch — no blanket push ban', () => {
  const idx = read('src/main/index.ts');
  assert.ok(
    !idx.includes('Do NOT push to any remote; god is the sole integrator.'),
    'the blanket push ban is gone from BOTH footers (it contradicted lean dispatches)',
  );
  const defer = idx.match(/On pushing[^`]{0,400}/g) ?? [];
  assert.equal(defer.length, 2, 'both the INTERN and the WORKER footer carry the defer sentence');
  for (const d of defer) {
    assert.ok(/dispatch contract/.test(d), 'the dispatch contract is named as the winner');
    assert.ok(/integrationMode/.test(d), 'the house integrationMode is named');
    assert.ok(/'workers' or 'lean'/.test(d), "the self-merge modes 'workers'/'lean' are named");
    assert.ok(/god is the sole integrator/.test(d), "mode 'god' keeps god as integrator");
  }
});

test('godLine VACATION paragraph documents whenQuiet holding', () => {
  const p = injectedPrompt.call(null, GOD, '/agents/god', '/hive', false, false);
  // 2026-08-19 godLine sweep: the raw "whenQuiet" JSON-field spelling was
  // replaced by the primitive's flag — hive-park --when-quiet — because the
  // request JSON is CLI-owned and hand-drops are gate-refused.
  assert.ok(/--when-quiet/.test(p), 'the godLine names the when-quiet flag');
  assert.ok(
    /hive-park --when-quiet is HELD/i.test(p),
    'a when-quiet park is HELD (not rejected) while the agent is busy',
  );
});

test('godLine anti-pattern (3) names the SCOPE FOLD and the BUNDLE TEST (2026-08-21)', () => {
  // Adjudicated wording (Robert, card agent-godline-name-the-scope-f-2026-08-21):
  // card-lifecycle rules never catch the fold because no card is ever held —
  // the text must name the maneuver itself. Do not paraphrase: both adjudicated
  // cases hang on it (Alfred's R1+F2/F3/F4 bundle stays legitimate; folding an
  // orient-gate nit into Jessica's watcher card stays hoarding).
  const p = injectedPrompt.call(null, GOD, '/agents/god', '/hive', false, false);
  assert.ok(/SCOPE FOLD/.test(p), 'anti-pattern 3 names the SCOPE FOLD disguise');
  assert.ok(
    /run the BUNDLE TEST/.test(p),
    'the BUNDLE TEST fires the moment you write "add it to <agent>\'s card"',
  );
  assert.ok(
    /ONE diff — same file\(s\), same branch, one gate run, inseparable at merge/.test(p),
    'bundling is legitimate only for ONE diff (Alfred R1+F2/F3/F4 stays legitimate)',
  );
  assert.ok(
    /names the PERSON \(author, expert, "already in that area"\) or the SUBSYSTEM rather than the DIFF/.test(
      p,
    ),
    'person/subsystem justification is hoarding (the watcher-card fold stays hoarding)',
  );
  assert.ok(
    /FINDINGS BECOME CARDS BEFORE OWNERS ARE CHOSEN/.test(p),
    'findings become cards before owners are chosen',
  );
  assert.ok(
    /fits != authored/.test(p),
    'roster-first rider: authorship is never by itself a routing reason while the author is busy and seats are free',
  );
});

test('godLine contract spec: quoted findings with provenance, verify-then-act, done on the observable (2026-08-21)', () => {
  // Adjudicated wording (Robert, card agent-god-s-dispatch-contracts-2026-08-21):
  // the defect was grade-stripping re-narration — a worker's hedged flag came
  // back to a confirmed diagnosis. The three clauses are woven INTO the
  // 4-part-contract sentence: (1) appended to OBJECTIVE, (3) appended to
  // BOUNDARIES, (2) a new sentence after the contract spec. Do not paraphrase:
  // clause (1) quotes the incident as evidence, hedges and ellipsis intact.
  const p = injectedPrompt.call(null, GOD, '/agents/god', '/hive', false, false);
  const obj = p.indexOf('(1) OBJECTIVE — the concrete goal;');
  const out = p.indexOf('(2) OUTPUT');
  const bnd = p.indexOf('(4) BOUNDARIES — scope limits + the definition of done.');
  const refs = p.indexOf('Pass references (file paths, message ids, board sections)');
  assert.ok(
    obj >= 0 && out > obj && bnd > out && refs > bnd,
    'the 4-part contract landmarks are present and ordered',
  );
  // (1) OBJECTIVE clause, appended
  const c1 =
    "State the goal as the OBSERVABLE to change (ticket symptom, failing behavior). Every finding you pass through is QUOTED — its own words, its hedges intact — with its source message id, never re-narrated from memory: certainty grades and causal structure do not survive paraphrase (incident 2026-08-21: a worker's hedged pane flag 'probably a bug in its own right, probably its own ticket' came back to that same worker as 'the root cause … BY CONSTRUCTION', inverting his own mailed causal reading; the commissioned build would have broken storno on every Beleg carrying an Uebertrag and was stopped only by his reviewer). Any claim of your own is labeled 'unverified:' — dispatches owe workers the same evidence discipline their reports owe you.";
  const i1 = p.indexOf(c1);
  assert.ok(i1 > obj && i1 + c1.length < out, 'clause (1) sits inside the OBJECTIVE part');
  // (3) BOUNDARIES clause, appended — before the VERIFY-FIRST sentence
  const c3 =
    "Done is defined on the observable — the symptom demonstrably gone on real data — never as 'the diagnosis is implemented'; a diagnosis-shaped done-criterion turns a wrong premise into faithful execution and makes questioning the premise read as scope creep.";
  const i3 = p.indexOf(c3);
  assert.ok(i3 > bnd, 'clause (3) sits inside the BOUNDARIES part');
  // (2) VERIFY-FIRST sentence, new, after the contract spec
  const c2 =
    "A card whose premise is hedged, INFERRED, or your own unverified reading is a VERIFY-THEN-ACT contract: its first step is to confirm or refute the premise, and refuting it COMPLETES the card (report + re-scope). Never write 'fix X' when the truth of X rests on a claim nobody has labeled VERIFIED.";
  const i2 = p.indexOf(c2);
  assert.ok(
    i2 > i3 && i2 + c2.length < refs,
    'VERIFY-THEN-ACT is a new sentence after the contract spec, before Pass references',
  );
});

test('every sole-scribe text names the standup-clerk exception (f415122)', () => {
  // god prompt, both lean and god integration modes + the godLine guardrails
  for (const args of [
    [GOD, '/a', '/h', true, false],
    [GOD, '/a', '/h', false, false],
  ]) {
    const p = injectedPrompt.call(null, ...args);
    if (!/sole scribe of board\.md/.test(p)) continue;
    assert.match(p, /standup clerk/i, 'sole-scribe claims carry the standup-clerk exception');
  }
  const hive = read('src/main/hive.ts');
  const protocolMentions = hive.match(/sole scribe/g) ?? [];
  assert.ok(protocolMentions.length >= 3, 'sanity: the tested sole-scribe sites exist');
  // PROTOCOL.md text (the generated doc for every agent)
  const protocol = hive.match(/is the shared plan[\s\S]{0,300}/);
  assert.ok(protocol, 'PROTOCOL board.md line present');
  assert.match(
    String(protocol),
    /standup clerk/,
    'the PROTOCOL sole-scribe line names the standup-clerk exception',
  );
  const agents = read('AGENTS.md');
  assert.match(
    agents,
    /board\.md.{0,120}scribe.{0,200}standup clerk|standup clerk.{0,200}board\.md.{0,120}scribe/s,
    'repo AGENTS.md names the standup-clerk exception beside the scribe rule',
  );
});
