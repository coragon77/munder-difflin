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
