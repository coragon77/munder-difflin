'use strict';

/**
 * CAPABILITIES AFTER HIRE (card agent-no-primitive-can-set-an--2026-08-20).
 *
 * Before this card, nothing could change an agent's capabilities post-hire:
 * hive-hire stamps them at spawn, no primitive writes them, and the renderer
 * edit dialog must not be used because it wipes role as collateral (Robert's
 * 2026-08-19 diagnosis). The card's ENTIRE point is field preservation — so
 * the tests pin it byte-identical:
 *
 *  • setCapabilities changes ONLY the capabilities array — every other stored
 *    field of the target agent (and every other agent, byte for byte) is
 *    untouched. lastSeen does not move; key order does not change.
 *  • a respawn whose meta omits capabilities does not erase them (Meredith's
 *    751818d upsert rule — pinned here together with the write so the combo
 *    can never regress unnoticed); an explicit capabilities in spawn meta
 *    still overwrites (hire-time stamping).
 *  • validation mirrors the spawn-request rules in shared/hire.ts (≤12 items,
 *    trim, 40-char cap, non-strings dropped) — one rule source.
 *  • the request-file path (what hive-roster set-capabilities drops into
 *    capability-requests/) parses through the same validation.
 *
 * FIXTURES ONLY — never the live floor (house rule).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-caps-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, hive: new (loadTs('src/main/hive.ts').HiveManager)(() => home) };
}

const regPath = (home) => path.join(home, 'hive', 'registry.json');
const readReg = (home) => JSON.parse(fs.readFileSync(regPath(home), 'utf8'));

/** Register angela with a rich entry (every field class the registry holds)
 *  plus a second agent, then hand-enrich angela with fields ensureAgent does
 *  not stamp — the preservation net must catch those too. */
async function seededFloor(t) {
  const f = floor(t);
  await f.hive.ensureAgent({
    id: 'angela-1',
    name: 'Angela',
    provider: 'pi',
    role: 'accounting',
    cwd: '/work/scranton',
    capabilities: ['email'],
  });
  await f.hive.ensureAgent({ id: 'kevin-1', name: 'Kevin', provider: 'claude', cwd: '/tmp' });
  const reg = readReg(f.home);
  Object.assign(reg.agents['angela-1'], {
    pinned: true,
    officeCharacter: 'angela',
    officeAccent: 'teal',
    spawnLabel: 'Watch the tickets',
    lastSeen: 1234567,
  });
  fs.writeFileSync(regPath(f.home), JSON.stringify(reg, null, 2));
  return f;
}

// ─── the preservation property (THE card) ──────────────────────────────────

test('setCapabilities changes ONLY capabilities — every other byte identical', async (t) => {
  const f = await seededFloor(t);
  const beforeText = fs.readFileSync(regPath(f.home), 'utf8');
  const before = JSON.parse(beforeText);

  const res = f.hive.setCapabilities('angela-1', ['email', 'tickets']);
  assert.equal(res.ok, true, res.error ?? 'setCapabilities reports ok');

  const afterText = fs.readFileSync(regPath(f.home), 'utf8');
  const after = JSON.parse(afterText);

  // Byte-identical pin: the file equals the before-object re-serialized with
  // ONLY the capabilities value swapped. Anything else moving (lastSeen, key
  // order, a sibling agent) fails this.
  const expected = JSON.parse(beforeText);
  expected.agents['angela-1'].capabilities = ['email', 'tickets'];
  assert.equal(afterText, JSON.stringify(expected, null, 2));

  // And explicitly: the sibling agent is untouched, angela's key ORDER is
  // unchanged (no re-serialization reordering beyond the swapped value).
  assert.deepEqual(after.agents['kevin-1'], before.agents['kevin-1']);
  assert.deepEqual(Object.keys(after.agents['angela-1']), Object.keys(before.agents['angela-1']));
  assert.equal(after.agents['angela-1'].lastSeen, 1234567, 'lastSeen must not move');
  assert.equal(after.agents['angela-1'].role, 'accounting', 'role survives');
});

test('setCapabilities on an unknown agent refuses and writes nothing', async (t) => {
  const f = await seededFloor(t);
  const beforeText = fs.readFileSync(regPath(f.home), 'utf8');
  const res = f.hive.setCapabilities('nobody-1', ['tickets']);
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /nobody-1|registry/);
  assert.equal(fs.readFileSync(regPath(f.home), 'utf8'), beforeText, 'registry untouched');
});

// ─── respawn survival (pinned WITH the write, per the card) ────────────────

test('a respawn whose meta omits capabilities does not erase them', async (t) => {
  const f = await seededFloor(t);
  f.hive.setCapabilities('angela-1', ['email', 'tickets']);
  await f.hive.ensureAgent({
    id: 'angela-1',
    name: 'Angela',
    provider: 'pi',
    cwd: '/work/scranton',
    // no capabilities key — the respawn-meta-omits-field wipe shape
  });
  assert.deepEqual(
    readReg(f.home).agents['angela-1'].capabilities,
    ['email', 'tickets'],
    'capabilities survive a capabilities-less respawn',
  );
});

test('an EXPLICIT capabilities in spawn meta still overwrites (hire-time stamping)', async (t) => {
  const f = await seededFloor(t);
  f.hive.setCapabilities('angela-1', ['email', 'tickets']);
  await f.hive.ensureAgent({
    id: 'angela-1',
    name: 'Angela',
    provider: 'pi',
    cwd: '/work/scranton',
    capabilities: ['reception'],
  });
  assert.deepEqual(readReg(f.home).agents['angela-1'].capabilities, ['reception']);
});

// ─── one rule source: the spawn-request capability rules ───────────────────

test('setCapabilities applies the shared hire rules: trim, 40-char cap, non-strings dropped', async (t) => {
  const f = await seededFloor(t);
  const res = f.hive.setCapabilities('angela-1', ['  tickets  ', 'x'.repeat(99), 42, null, '']);
  assert.equal(res.ok, true, res.error ?? 'ok');
  assert.deepEqual(readReg(f.home).agents['angela-1'].capabilities, ['tickets', 'x'.repeat(40)]);
});

test('setCapabilities refuses more than 12 capabilities and an all-empty list', async (t) => {
  const f = await seededFloor(t);
  const beforeText = fs.readFileSync(regPath(f.home), 'utf8');
  const tooMany = f.hive.setCapabilities(
    'angela-1',
    Array.from({ length: 13 }, (_, i) => 'c' + i),
  );
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.error ?? '', /12/);
  const allEmpty = f.hive.setCapabilities('angela-1', ['  ', '']);
  assert.equal(allEmpty.ok, false);
  assert.equal(fs.readFileSync(regPath(f.home), 'utf8'), beforeText, 'no write on refusal');
});

// ─── the request file hive-roster drops (capability-requests/) ─────────────

test('parseCapabilityRequest validates the drop-dir request shape', () => {
  const { parseCapabilityRequest } = loadTs('src/shared/hire.ts');
  const ok = parseCapabilityRequest({ agentId: 'angela-1', capabilities: ['tickets'] });
  assert.equal(ok.ok, true);
  assert.equal(ok.agentId, 'angela-1');
  assert.deepEqual(ok.capabilities, ['tickets']);

  const noId = parseCapabilityRequest({ capabilities: ['tickets'] });
  assert.equal(noId.ok, false);

  const badCaps = parseCapabilityRequest({ agentId: 'a', capabilities: 'tickets' });
  assert.equal(badCaps.ok, false);
  assert.match(badCaps.error ?? '', /capabilit/i);

  const tooMany = parseCapabilityRequest({
    agentId: 'a',
    capabilities: Array.from({ length: 13 }, (_, i) => 'c' + i),
  });
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.error ?? '', /12/);
});

test('validateHireManifest still normalizes capabilities the same way (no drift)', () => {
  const { validateHireManifest, HIRE_SPEC_V1 } = loadTs('src/shared/hire.ts');
  const res = validateHireManifest({
    spec: HIRE_SPEC_V1,
    name: 'X',
    capabilities: ['  a  ', 'b'.repeat(99), '', 7],
  });
  assert.equal(res.ok, true, JSON.stringify(res.errors ?? []));
  assert.deepEqual(res.manifest.capabilities, ['a', 'b'.repeat(40)]);
});
