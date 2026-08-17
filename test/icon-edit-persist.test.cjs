'use strict';

/**
 * ICON EDIT PERSISTENCE (harness-icon-edit-persist-20260817).
 *
 * Stefan's repro: edited Ada's icon via the agent-edit dialog → changed on the
 * CARD but not on the FLOOR sprite; after park+recall the icon reverted to
 * Jim's (name-derived collision). Control: a permissionMode edit survived.
 *
 * Verified root cause (evidence, not hypothesis):
 *  1. The dialog's edit branch persists character/accent ONLY to the renderer
 *     store (updateAgent) — hiveSetAgentMeta carries name/role, so the
 *     registry's officeCharacter/officeAccent are NEVER written by an edit.
 *  2. The floor binds sprite frames once at addCharacter; applyState tracks
 *     status/action/carrying/prompt — never identity — so a store edit never
 *     repaints the live sprite.
 *  3. The recall broadcast carries the registry-saved identity (rung 1 of
 *     spawnIdentity), which still holds the FIRST-WRITE-WINS backfill from
 *     first carding (Ada → no cast match → default jim). Hence the revert.
 *
 * Fix: EXPLICIT dialog edits get overwrite semantics on the registry
 * (setAgentMeta grows officeCharacter/officeAccent); backfill
 * (saveOfficeIdentity) stays first-write-wins — boundary from the dispatch.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

const repoRoot = path.join(__dirname, '..');
const read = (p) => readFileSync(path.join(repoRoot, p), 'utf8');

function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-iconedit-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, hive: new HiveManager(() => home) };
}

// ─── registry: explicit edits overwrite, backfill stays first-write-wins ────

test('the Ada repro: an explicit office-identity edit overwrites a backfilled one', async (t) => {
  const { home, hive } = floor(t);
  await hive.ensureAgent({ id: 'ada-1', name: 'Ada', provider: 'claude', cwd: '/tmp' });
  // First carding backfills the NAME-DERIVED pick (no cast match → default).
  assert.equal(hive.saveOfficeIdentity('ada-1', 'jim', 'sky'), true, 'backfill fills the slot');

  // The explicit dialog edit (Stefan picks Angela).
  assert.equal(
    hive.setAgentMeta('ada-1', { officeCharacter: 'angela', officeAccent: 'coral' }),
    true,
    'an explicit edit reports success',
  );

  // What a recall broadcast reads — a fresh manager is what a restart sees.
  const entry = new HiveManager(() => home).registry().agents['ada-1'];
  assert.equal(entry.officeCharacter, 'angela', 'the edited icon survives (acceptance 2)');
  assert.equal(entry.officeAccent, 'coral', 'the edited accent survives');
});

test('backfill STILL refuses to change a saved identity after an explicit edit', async (t) => {
  const { hive } = floor(t);
  await hive.ensureAgent({ id: 'ada-1', name: 'Ada', provider: 'claude', cwd: '/tmp' });
  hive.setAgentMeta('ada-1', { officeCharacter: 'angela', officeAccent: 'coral' });

  assert.equal(
    hive.saveOfficeIdentity('ada-1', 'jim', 'sky'),
    false,
    'first-write-wins holds for backfill even after an explicit edit (acceptance 3)',
  );
  assert.equal(hive.registry().agents['ada-1'].officeCharacter, 'angela');
});

test('untouched agents keep name-derived backfill untouched (no write-back creep)', async (t) => {
  const { hive } = floor(t);
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: '/tmp' });
  // Another agent's edit must not touch this one's identity path.
  await hive.ensureAgent({ id: 'ada-1', name: 'Ada', provider: 'claude', cwd: '/tmp' });
  hive.setAgentMeta('ada-1', { officeCharacter: 'angela', officeAccent: 'coral' });

  const jim = hive.registry().agents['jim-1'];
  assert.equal(jim.officeCharacter, undefined, 'no identity was backfilled for jim');
  assert.equal(hive.saveOfficeIdentity('jim-1', 'jim', 'mint'), true, 'his first backfill wins');
  assert.equal(hive.registry().agents['jim-1'].officeCharacter, 'jim');
});

test('setAgentMeta ignores empty office strings and preserves siblings', async (t) => {
  const { hive } = floor(t);
  await hive.ensureAgent({ id: 'ada-1', name: 'Ada', provider: 'claude', cwd: '/tmp' });
  hive.saveOfficeIdentity('ada-1', 'jim', 'sky');
  hive.setPinned('ada-1', true);
  hive.recordSession('ada-1', 'sess-1');

  hive.setAgentMeta('ada-1', { name: 'Ada L.', officeCharacter: '  ', officeAccent: '' });

  const entry = hive.registry().agents['ada-1'];
  assert.equal(entry.name, 'Ada L.', 'the rename landed');
  assert.equal(entry.officeCharacter, 'jim', 'blank office fields are ignored, not written');
  assert.equal(entry.pinned, true, 'the pin survives');
  assert.equal(entry.sessionId, 'sess-1', 'the session stamp survives');
});

// ─── wiring pins ────────────────────────────────────────────────────────────

test('the dialog edit persists office identity through every layer', () => {
  const main = read('src/main/index.ts');
  assert.ok(
    main.includes('officeCharacter') && main.includes('hive:setAgentMeta'),
    'the setAgentMeta IPC passes office identity through',
  );
  const preload = read('src/preload/index.ts');
  assert.ok(
    preload.includes('officeCharacter'),
    'the preload bridge signature carries office identity',
  );
  const modal = read('src/renderer/src/components/AddAgentModal.tsx');
  const call = modal.slice(modal.indexOf('hiveSetAgentMeta'));
  assert.ok(
    call.slice(0, 450).includes('officeCharacter'),
    'the edit branch sends the picked character to the registry',
  );
});

test('the floor sprite rebinds live on an identity edit', () => {
  const scene = read('src/renderer/src/scene/office/OfficeFloor.tsx');
  assert.ok(scene.includes('prevCharacter'), 'applyState tracks identity changes on live runtimes');
  assert.ok(scene.includes('setFrames'), 'a detected change swaps the sprite frames in place');
  const sprite = read('src/renderer/src/scene/office/CharacterSprite.ts');
  assert.ok(
    sprite.includes('setFrames(frames: Texture[][])'),
    'CharacterSprite exposes the frame swap',
  );
});
