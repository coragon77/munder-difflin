'use strict';

/**
 * Router-side auto-CC of god on peer mail (card
 * agent-paused-auto-cc-god-on-wo-2026-08-18, Robert's design review + god's
 * Option-B ruling 2026-08-19).
 *
 * Every worker→worker routed message drops a COMPACT AUDIT COPY into god's
 * inbox — god audits everything but must never be WOKEN by it. Option B:
 * the copy is shaped so the EXISTING classification seams skip it on every
 * wake rail — from 'system', act 'inform' is FYI by definition:
 *   rail 1: the monitor's flt() skips act 'inform' from system senders;
 *   rail 2: the renderer typed nudge filters isFyiMail (useHive.ts);
 *   rail 3: heartbeat godActionableInboxCount filters SYSTEM_SENDERS +
 *           isFyiMail (index.ts).
 * The copy keeps the ORIGINAL message id (it points at the archived body in
 * the sender's outbox/.sent and the recipient's inbox/.done), is delivered
 * directly (no new outbox message, no hops increment, no loop risk), and
 * there is deliberately NO '[cc ' arm in the wake filters — the shaping does
 * the work; dead-looking load-bearing code is worse than none (god's ruling).
 *
 * Exempt from the CC: god/human-directed mail (god already has it), mail
 * from god, broadcast fan-out, and anything from a non-registered sender
 * (system senders, webhooks) — the CC covers REGISTERED workers only.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager, PROTOCOL_MD } = loadTs('src/main/hive.ts');
const { SYSTEM_SENDERS, isFyiMail } = loadTs('src/shared/hiveMail.ts');

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-router-cc-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  hive.ensureHive();
  const root = path.join(home, 'hive');
  const ensure = (meta) => hive.ensureAgent({ provider: 'claude', cwd: root, ...meta });
  return { hive, root, ensure };
}

const inboxOf = (root, id) => {
  const dir = path.join(root, 'agents', id, 'inbox');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
};

async function seedFloor(t) {
  const s = setup(t);
  await s.ensure({ id: 'god', name: 'God', isGod: true });
  await s.ensure({ id: 'w1', name: 'One' });
  await s.ensure({ id: 'w2', name: 'Two' });
  return s;
}

const drop = (root, fromId, msg) => {
  const dir = path.join(root, 'agents', fromId, 'outbox');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${msg.id}.json`), JSON.stringify(msg));
};

test('worker→worker mail: peer gets the original, god gets a compact FYI-shaped CC copy', async (t) => {
  const s = await seedFloor(t);
  drop(s.root, 'w1', {
    id: 'orig-1',
    to: 'w2',
    act: 'request',
    subject: 'peer question',
    body: 'the full body lives in the archive',
  });
  s.hive.routeOnce();

  const peer = inboxOf(s.root, 'w2');
  assert.equal(peer.length, 1, 'peer receives the original');
  assert.equal(peer[0].id, 'orig-1');
  assert.equal(peer[0].from, 'w1');

  const god = inboxOf(s.root, 'god');
  const cc = god.find((m) => m.subject.startsWith('[cc '));
  assert.ok(cc, 'god receives a CC copy');
  assert.equal(cc.from, 'system', 'CC copy is system-sent (FYI classification)');
  assert.equal(cc.act, 'inform', 'CC copy is act inform (FYI classification)');
  assert.equal(cc.requires_reply, false, 'CC copy never expects a reply');
  assert.equal(cc.needs_human, false);
  assert.equal(cc.id, 'orig-1', 'CC copy keeps the ORIGINAL id — it points at the archived body');
  assert.equal(cc.subject, '[cc w1->w2] peer question');
  assert.ok(!cc.body.includes('\n'), 'CC body is one line');
  assert.ok(cc.body.includes('orig-1'), 'CC body points at the archived message id');
  assert.equal(cc.hops, 0, 'direct deliver(): no hops increment');
});

test('CC exemptions: god/human-directed, god-sent, broadcast, non-registered senders', async (t) => {
  const s = await seedFloor(t);
  drop(s.root, 'w1', { id: 'to-god', to: 'god', act: 'done', subject: 'report', body: 'x' });
  drop(s.root, 'w1', { id: 'to-human', to: 'human', act: 'query', subject: 'q', body: 'x' });
  drop(s.root, 'w1', { id: 'bc-1', to: 'broadcast', act: 'inform', subject: 'fyi all', body: 'x' });
  drop(s.root, 'god', { id: 'from-god', to: 'w2', act: 'request', subject: 'do it', body: 'x' });
  s.hive.routeOnce();
  s.hive.send({ to: 'w2', act: 'inform', subject: 'sys notice', body: 'x' }, 'heartbeat');

  const god = inboxOf(s.root, 'god');
  assert.ok(
    god.some((m) => m.id === 'to-god'),
    'god receives his own mail',
  );
  assert.ok(
    god.some((m) => m.id === 'to-human'),
    'human-directed mail resolves to god',
  );
  assert.equal(
    god.filter((m) => m.subject.startsWith('[cc ')).length,
    0,
    'no CC on any exempt path',
  );

  assert.ok(
    inboxOf(s.root, 'w2').some((m) => m.id === 'bc-1'),
    'broadcast still fans out',
  );
  assert.equal(inboxOf(s.root, 'w2').filter((m) => m.subject.startsWith('[cc ')).length, 0);
});

test('the CC copy never wakes god: FYI on every rail, and no new outbox file anywhere', async (t) => {
  const s = await seedFloor(t);
  drop(s.root, 'w1', { id: 'orig-2', to: 'w2', act: 'request', subject: 's', body: 'b' });
  s.hive.routeOnce();

  // Rail 2 (renderer nudge) + rail 3 (heartbeat godActionableInboxCount) both
  // filter on the shared seam — assert the copy fails BOTH halves of the
  // exact filter expression those rails use.
  const cc = inboxOf(s.root, 'god').find((m) => m.id === 'orig-2');
  assert.ok(cc, 'CC copy landed');
  assert.ok(SYSTEM_SENDERS.has(cc.from), 'excluded by the SYSTEM_SENDERS half of rail 3');
  assert.ok(isFyiMail(cc), 'excluded by the isFyiMail half of rails 2 and 3');
  const actionable = inboxOf(s.root, 'god').filter(
    (m) => !SYSTEM_SENDERS.has(m.from) && !isFyiMail(m),
  );
  assert.equal(actionable.length, 0, 'godActionableInboxCount sees zero actionable mail');

  // No new outbox message was created for the CC (direct deliver, no hops).
  const outboxLeft = fs
    .readdirSync(path.join(s.root, 'agents', 'w1', 'outbox'))
    .filter((f) => f.endsWith('.json'));
  assert.equal(outboxLeft.length, 0, 'sender outbox fully drained');
  const godSent = fs.existsSync(path.join(s.root, 'agents', 'god', 'outbox'))
    ? fs
        .readdirSync(path.join(s.root, 'agents', 'god', 'outbox'))
        .filter((f) => f.endsWith('.json'))
    : [];
  assert.equal(godSent.length, 0, 'the CC is never a god outbox message');
});

test('worker briefing + PROTOCOL.md carry the peer-mail norm', async () => {
  // TS `private` is compile-time only — reachable at runtime (godline-rules pattern).
  const prompt = HiveManager.prototype['injectedPrompt'].call(
    null,
    { id: 'w1', name: 'One', cwd: '/w', provider: 'claude' },
    '/agents/w1',
    '/hive',
    false,
    false,
  );
  assert.ok(/audit copy/.test(prompt), 'rule 4 tells workers god sees an audit copy of peer mail');
  assert.ok(
    /propose to god BEFORE acting/.test(prompt),
    'rule 4 carries the propose-before-acting half of the norm',
  );
  assert.ok(
    /Peer mail/.test(PROTOCOL_MD),
    'PROTOCOL.md documents peer mail + the automatic audit copy',
  );
  assert.ok(/audit copy/.test(PROTOCOL_MD));
});
