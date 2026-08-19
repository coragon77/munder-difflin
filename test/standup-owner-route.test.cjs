'use strict';

/**
 * Owner-first stall escalation (card agent-route-stalled-doing-card-2026-08-19).
 *
 * The standup's `stalled` detector used to escalate to GOD: a card sits in
 * `doing` while its owner is idle, and god has to decide and poke. Now the
 * harness ASKS THE OWNER first — resume the card, or flip it blocked with a
 * reason — and escalates to god only on silence past the grace window (a
 * presumed dead session, repair = `hive-dispatch --resume`). The distinction
 * "stalled vs waiting by instruction" is impossible harness-side and trivial
 * agent-side, so the design never infers — it asks.
 *
 * Pinned here:
 *  - routeStalled: fresh stall → owner mail, NOT god; silence past the grace
 *    window → god, naming --resume; inside the grace window → no nag; an
 *    owner not on the floor keeps god's path; notices are kept for still-
 *    stalled cards and dropped when a card stops qualifying.
 *  - ownerStallMail: both legitimate outcomes, the blocked-is-free convention,
 *    and the silence deadline.
 *  - detectAnomalies: a BLOCKED card never fires the stall detector (doing
 *    only), whatever the owner's idle time.
 *  - wiring (index.ts source pins): the owner mail rides hive.send, god only
 *    hears the routed-to-god set, and the notices persist on the mission.
 *  - the convention prose (hive.ts HIVE_CARD_MD): blocked-while-waiting is the
 *    documented move, zero-cost, with --resume as the return path.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const loadTs = require('./load-ts.cjs');

const { detectAnomalies, ownerStallMail, routeStalled, STALLED_SEC, STALLED_OWNER_GRACE_SEC } =
  loadTs('src/main/standup.ts');

const read = (...p) => readFileSync(join(__dirname, '..', ...p), 'utf8');

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

/** The canonical fresh stall: Pam idle past the bar on a doing card. */
const freshStall = () =>
  detect(
    [agent({ lastActiveSecAgo: STALLED_SEC + 60 })],
    [{ id: 'c-1', title: 'ship it', status: 'doing', assignee: 'pam' }],
  );

// ── routing: owner first, god only on silence ───────────────────────────────

test('a fresh stall mails the OWNER, not god, and records the notice', () => {
  const [a] = freshStall();
  const r = routeStalled([a], {});
  assert.equal(r.toOwners.length, 1, 'the owner gets the first word');
  assert.equal(r.toGod.length, 0, 'god stays out of the common loop');
  assert.ok(r.nextNotices['c-1'], 'the notice is recorded for the grace window');
  assert.equal(r.toOwners[0].owner, 'pam', 'the mail target is the card owner');
});

test('silence past the grace window escalates to god and names --resume', () => {
  const [a] = freshStall();
  const noticed = Date.now() - (STALLED_OWNER_GRACE_SEC + 60) * 1000;
  const r = routeStalled([a], { 'c-1': new Date(noticed).toISOString() });
  assert.equal(r.toOwners.length, 0, 'no second owner mail');
  assert.equal(r.toGod.length, 1, 'the silence deadline reaches god');
  assert.match(r.toGod[0].detail, /hive-dispatch --card c-1 --assignee pam --resume/);
  assert.match(r.toGod[0].detail, /dead session/i);
  assert.ok(r.nextNotices['c-1'], 'the notice persists so the owner is not re-mailed hourly');
});

test('inside the grace window: no owner nag, no god mail', () => {
  const [a] = freshStall();
  const r = routeStalled([a], { 'c-1': new Date().toISOString() });
  assert.equal(r.toOwners.length, 0);
  assert.equal(r.toGod.length, 0, 'the owner was asked — wait for the answer');
});

test('an owner NOT on the floor cannot answer mail — god keeps its path', () => {
  const [a] = detect([agent({ id: 'jim' })], [{ id: 'c-1', status: 'doing', assignee: 'pam' }]);
  const r = routeStalled([a], {});
  assert.equal(r.toOwners.length, 0);
  assert.equal(r.toGod.length, 1);
  assert.equal(Object.keys(r.nextNotices).length, 0, 'nothing to notice — nobody to mail');
});

test('a card that stopped qualifying leaves the notice map (later stall = fresh notice)', () => {
  const r = routeStalled([], { 'c-1': new Date().toISOString() });
  assert.deepEqual(r.nextNotices, {});
});

test('non-stalled findings pass through to god untouched', () => {
  const [a] = detect([agent({ breaker: 'steering' })], []);
  const r = routeStalled([a], {});
  assert.deepEqual(r.toGod, [a]);
  assert.equal(r.toOwners.length, 0);
});

// ── the owner mail is a contract, not prose ─────────────────────────────────

test('ownerStallMail offers BOTH outcomes and the blocked-is-free convention', () => {
  const [a] = freshStall();
  const mail = ownerStallMail(a);
  assert.match(mail, /c-1/, 'names the card');
  assert.match(mail, /RESUME/i, 'outcome 1: resume the card');
  assert.match(mail, /hive-card status c-1 blocked/, 'outcome 2: flip to blocked, exact command');
  assert.match(mail, /NOTHING/, 'blocked costs nothing (busy-check counts only doing)');
  assert.match(mail, /hive-dispatch --card c-1 --resume/, 'the return path is named');
  assert.match(mail, /next standup/i, 'the silence deadline is stated');
});

// ── the detector only ever fires on 'doing' ─────────────────────────────────

test('a BLOCKED card never fires the stall detector, however idle the owner', () => {
  const idleOwner = [agent({ lastActiveSecAgo: STALLED_SEC * 10 })];
  const blocked = { id: 'c-1', title: 'waiting', status: 'blocked', assignee: 'pam' };
  assert.deepEqual(detect(idleOwner, [blocked]), []);
});

test('a PAUSED doing card never fires the stall detector (operator hold)', () => {
  const idleOwner = [agent({ lastActiveSecAgo: STALLED_SEC * 10 })];
  const held = { id: 'c-1', status: 'doing', assignee: 'pam', paused: true };
  assert.deepEqual(detect(idleOwner, [held]), []);
});

// ── wiring (index.ts source pins) ───────────────────────────────────────────

test('wiring: owner notices ride hive.send to the owner, god gets the routed set', () => {
  const src = read('src/main/index.ts');
  const body = src.slice(
    src.indexOf('async function runStandupClerk'),
    src.indexOf('function syncMissions'),
  );
  assert.ok(body.length > 0, 'runStandupClerk found');
  assert.match(body, /routeStalled\(/, 'the routing decision is the shared pure function');
  assert.match(body, /to: a\.owner/, 'the stall mail goes to the card OWNER');
  assert.match(body, /ownerStallMail\(/, 'the mail body is the deterministic contract');
  assert.match(body, /const anomalies = routing\.toGod/, 'god hears only what survived routing');
  assert.match(body, /stalledNotices: routing\.nextNotices/, 'notices persist on the mission');
});

// ── the convention is documented where agents read it ───────────────────────

test('HIVE_CARD_MD documents blocked-while-waiting as the deliberate move', () => {
  const src = read('src/main/hive.ts');
  const md = src.slice(src.indexOf('const HIVE_CARD_MD'), src.indexOf('**Enrich an existing card'));
  assert.match(md, /DELIBERATE WAITING IS BLOCKED, NOT DOING/);
  assert.match(md, /busy-check counts only/, 'the zero-cost claim is stated');
  assert.match(md, /--resume/, 'the return path is named');
  assert.match(md, /asks YOU first/, 'the owner-first escalation is discoverable');
});
