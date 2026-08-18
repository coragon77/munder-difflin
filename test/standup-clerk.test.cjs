'use strict';

/**
 * Standup clerk (card agent-harness-standup-clerk-ch-2026-08-17).
 *
 * The hourly ops standup used to wake GOD for a full (expensive) turn. With
 * `standupClerk` ON (the shipped default) the scheduler routes it to a cheap
 * haiku-class one-shot instead, and god only hears from it when something is
 * actually wrong.
 *
 * Pinned here:
 *  - the ROUTING decision (standupTarget): unset/true ⇒ clerk, false ⇒ god
 *  - the ESCALATION conditions (detectAnomalies): stalled · blocked-unowned ·
 *    breaker-armed · over-budget — and, just as importantly, everything that is
 *    NOT one of them (a busy-but-healthy floor escalates nothing, so god stays
 *    silent and the clerk never spawns)
 *  - the deterministic fallback + board line, so an LLM that times out can
 *    never swallow a real escalation
 *  - the WIRING in index.ts (source pins — not loadable outside Electron; same
 *    convention as worker-intern-switches / worktree-isolation-refusal):
 *    quiet-skip still happens BEFORE any clerk spawn (13c6f7d interplay), the
 *    clerk path is ops-standup only, and standupClerk:false keeps today's
 *    hive.send-to-god byte-identical.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const loadTs = require('./load-ts.cjs');

const {
  standupTarget,
  detectAnomalies,
  summarizeAnomalies,
  clerkPrompt,
  boardLine,
  STANDUP_CLERK_MODEL,
  STALLED_SEC,
} = loadTs('src/main/standup.ts');

const read = (...p) => readFileSync(join(__dirname, '..', ...p), 'utf8');

// ── routing decision ────────────────────────────────────────────────────────

test('routing: unset ⇒ clerk (default ON per operator)', () => {
  assert.equal(standupTarget({}), 'clerk');
  assert.equal(standupTarget({ standupClerk: undefined }), 'clerk');
});

test('routing: explicit true ⇒ clerk, explicit false ⇒ god (today’s behaviour)', () => {
  assert.equal(standupTarget({ standupClerk: true }), 'clerk');
  assert.equal(standupTarget({ standupClerk: false }), 'god');
});

test('config: DEFAULTS + the interface carry standupClerk ON', () => {
  const src = read('src/main/config.ts');
  const iface = src.slice(
    src.indexOf('export interface HarnessConfig'),
    src.indexOf('const DEFAULTS'),
  );
  assert.ok(/standupClerk\?: boolean/.test(iface), 'HarnessConfig declares standupClerk');
  const defaults = src.slice(src.indexOf('const DEFAULTS'));
  assert.ok(/standupClerk: true/.test(defaults), 'DEFAULTS ships it ON');
});

// ── escalation conditions ───────────────────────────────────────────────────

const agent = (over) => ({
  id: 'pam',
  name: 'Pam',
  isGod: false,
  breaker: 'healthy',
  tokens: 1000,
  lastActiveSecAgo: 10,
  pendingBackgroundWork: 0,
  ...over,
});
const detect = (fleet, tasks, budgets) =>
  detectAnomalies({ agents: fleet }, { tasks }, budgets ?? {});
const kinds = (as) => as.map((a) => a.kind).sort();

test('a busy but healthy floor escalates nothing (god stays silent)', () => {
  const found = detect(
    [agent(), agent({ id: 'jim', name: 'Jim', lastActiveSecAgo: 120 })],
    [
      { id: 'c-1', title: 'ship it', status: 'doing', assignee: 'pam' },
      // A todo on a HEALTHY busy floor is mid-dispatch — young (age-gated);
      // an old/un-dated one escalates as todo-unattended (every non-paused
      // todo keeps the standup alive, card agent-every-non-paused-todo-ke-
      // 2026-08-18).
      { id: 'c-2', title: 'later', status: 'todo', createdAt: new Date().toISOString() },
      { id: 'c-3', title: 'shipped', status: 'done', assignee: 'jim' },
    ],
  );
  assert.deepEqual(found, []);
});

test('stalled: a doing card whose owner has been idle past the bar', () => {
  const found = detect(
    [agent({ lastActiveSecAgo: STALLED_SEC + 60 })],
    [{ id: 'c-1', title: 'ship it', status: 'doing', assignee: 'pam' }],
  );
  assert.deepEqual(kinds(found), ['stalled']);
  assert.match(found[0].detail, /c-1/);
});

test('stalled: waiting ≠ idle — pending background work is not a stall', () => {
  const found = detect(
    [agent({ lastActiveSecAgo: STALLED_SEC + 600, pendingBackgroundWork: 2 })],
    [{ id: 'c-1', title: 'ship it', status: 'doing', assignee: 'pam' }],
  );
  assert.deepEqual(found, []);
});

test('stalled: a doing card whose owner is not on the floor at all', () => {
  const found = detect([agent({ id: 'jim' })], [{ id: 'c-1', status: 'doing', assignee: 'pam' }]);
  assert.deepEqual(kinds(found), ['stalled']);
  assert.match(found[0].detail, /floor/i);
});

test('stalled: an owner with no telemetry yet (fresh spawn) is not a stall', () => {
  const found = detect(
    [agent({ lastActiveSecAgo: null })],
    [{ id: 'c-1', status: 'doing', assignee: 'pam' }],
  );
  assert.deepEqual(found, []);
});

test('blocked-unowned: a blocked card with no assignee escalates, an owned one does not', () => {
  assert.deepEqual(kinds(detect([agent()], [{ id: 'c-9', status: 'blocked' }])), [
    'blocked-unowned',
  ]);
  assert.deepEqual(
    detect([agent()], [{ id: 'c-9', status: 'blocked', assignee: 'pam' }]),
    [],
    'an owned blocker is the owner’s problem, not a standup escalation',
  );
  assert.deepEqual(
    kinds(detect([agent()], [{ id: 'c-9', status: 'blocked', assignee: '  ' }])),
    ['blocked-unowned'],
    'whitespace is not an owner',
  );
});

test('breaker-armed: anything above healthy escalates', () => {
  for (const level of ['steering', 'constrained', 'stopped']) {
    const found = detect([agent({ breaker: level })], []);
    assert.deepEqual(kinds(found), ['breaker-armed'], level);
    assert.match(found[0].detail, new RegExp(level));
  }
  assert.deepEqual(detect([agent({ breaker: 'healthy' })], []), []);
  assert.deepEqual(detect([agent({ breaker: undefined })], []), []);
});

test('over-budget: per-agent cap and the floor cap both escalate', () => {
  assert.deepEqual(
    kinds(detect([agent({ tokens: 900_000 })], [], { agentTokenCaps: { pam: 500_000 } })),
    ['over-budget'],
  );
  assert.deepEqual(
    detect([agent({ tokens: 400_000 })], [], { agentTokenCaps: { pam: 500_000 } }),
    [],
    'under its cap is not an escalation',
  );
  assert.deepEqual(
    kinds(
      detect([agent({ tokens: 600_000 }), agent({ id: 'jim', tokens: 600_000 })], [], {
        costCapTokens: 1_000_000,
      }),
    ),
    ['over-budget'],
    'the FLOOR total is one escalation, not one per agent',
  );
  assert.deepEqual(
    detect([agent({ tokens: 9_000_000 })], [], { costCapTokens: 0, agentTokenCaps: { pam: 0 } }),
    [],
    'unset/0 caps mean unlimited — never an escalation',
  );
});

test('a corrupt or empty snapshot escalates nothing rather than throwing', () => {
  assert.deepEqual(detectAnomalies(null, null, {}), []);
  assert.deepEqual(detectAnomalies({}, {}, {}), []);
  assert.deepEqual(detectAnomalies({ agents: 'nope' }, { tasks: 42 }, {}), []);
});

// ── the report the clerk writes up (and its deterministic fallback) ─────────

test('summarizeAnomalies names every escalation (the fallback keeps facts)', () => {
  const found = detect(
    [agent({ breaker: 'steering' })],
    [{ id: 'c-9', status: 'blocked', title: 'db migration' }],
  );
  const text = summarizeAnomalies(found);
  assert.match(text, /breaker/i);
  assert.match(text, /c-9/);
  assert.equal(summarizeAnomalies([]), '');
});

test('boardLine is exactly one line, stamped, and never empty', () => {
  const line = boardLine('2026-08-17 21:30', 'Pam stalled 41m on c-1\nsecond line dropped');
  assert.ok(!line.includes('\n'), 'one line only — board.md is append-only prose');
  assert.match(line, /2026-08-17 21:30/);
  assert.match(line, /standup/i);
  assert.match(line, /Pam stalled 41m/);
});

test('clerkPrompt carries the facts and forbids side effects', () => {
  const p = clerkPrompt('/hive', detect([agent({ breaker: 'stopped' })], []));
  assert.match(p, /fleet\.json/);
  assert.match(p, /tasks\.json/);
  assert.match(p, /\/hive/);
  assert.match(p, /breaker/i);
});

test('the clerk model is haiku-class', () => {
  assert.match(STANDUP_CLERK_MODEL, /haiku/);
});

// ── wiring (index.ts source pins) ───────────────────────────────────────────

test('scheduler: quiet-skip is evaluated BEFORE the clerk can spawn', () => {
  const src = read('src/main/index.ts');
  const quiet = src.indexOf('const quietSkip =');
  const clerk = src.indexOf('void runStandupClerk()'); // the CALL SITE, not the declaration
  assert.ok(quiet > 0 && clerk > quiet, 'a quiet floor costs zero — no spawn behind it');
  const fireBody = src.slice(quiet, quiet + 1600);
  assert.match(
    fireBody,
    /!quietSkip\)\s*\{[\s\S]{0,600}standupTarget\(/,
    'the clerk lives inside the !quietSkip branch',
  );
});

test('scheduler: the clerk path is ops-standup only, and OFF keeps the god send', () => {
  const src = read('src/main/index.ts');
  const fireBody = src.slice(
    src.indexOf('const quietSkip ='),
    src.indexOf('const quietSkip =') + 1600,
  );
  assert.match(fireBody, /OPS_STANDUP_MISSION\.id/, 'only the built-in standup routes to a clerk');
  assert.match(
    fireBody,
    /hive\.send\(\{ to: m\.to, act: 'request', subject: m\.label, body: m\.body \}, 'scheduler'\)/,
    'the god dispatch is untouched on the OFF path',
  );
});

test('the clerk reuses the existing one-shot machinery (no new spawn path)', () => {
  const src = read('src/main/index.ts');
  assert.match(src, /runHiddenClaude/, 'reuses hiddenClaude.ts');
  const fn = src.slice(src.indexOf('async function runStandupClerk'));
  assert.ok(fn.length > 0, 'the clerk runner exists');
  // The window must reach past hive.send (near the function's end) — it grew
  // with the amendment-A dedup block; keep it just past the current function
  // end (~3.7k) so the asserts stay INSIDE runStandupClerk.
  const body = fn.slice(0, 4096);
  assert.match(body, /detectAnomalies\(/, 'escalation is decided deterministically');
  assert.match(body, /STANDUP_CLERK_MODEL/, 'haiku-class model override');
  assert.match(body, /summarizeAnomalies\(/, 'LLM failure falls back to the deterministic report');
  assert.match(body, /hive\.send\(/, 'god is mailed only from the escalation path');
});
