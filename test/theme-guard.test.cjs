'use strict';

/**
 * Custom office theme — switch guard + preserve predicate (card
 * agent-harness-custom-office-th-2026-08-17).
 *
 * The non-destructive switch (office<->custom keeps the live roster) is gated
 * by two pure predicates in themeGuard.ts (asset-free, loadTs-loadable — same
 * extraction pattern as worktreeAdopt): switchPreservesAgents (flag + cast
 * resolves every live character + seats fit) and missingAnchors (a map the
 * operator broke in Tiled must REFUSE the switch, never break the floor).
 * The guard runs against the REAL maps on disk (office.tmj, custom.tmj —
 * byte-copy at birth) and a sabotaged map. The picker wiring (preserve branch
 * returns before any killPty teardown; preservesAgents targets skip the
 * confirm modal) is source-pinned — OfficeThemePicker is a React component,
 * not loadable in this harness.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const loadTs = require('./load-ts.cjs');

const { mapObjectNames, missingAnchors, requiredAnchors, switchPreservesAgents } = loadTs(
  'src/renderer/src/scene/office/themeGuard.ts',
);

const read = (...p) => readFileSync(join(__dirname, '..', ...p), 'utf8');

// Mirrors OFFICE_THEME's layout-bound names (the registry imports ?raw/?url
// assets and can't load here) — seats + café + entrance + zones.
const OFFICE_REQUIRED = [
  'entrance',
  'boardroom',
  'cafeteria',
  'desk-ceo',
  'pc-1',
  'pc-2',
  'pc-3',
  'pc-4',
  'pc-5',
  'pc-6',
  'desk-chief-architect',
  'desk-product-manager',
  'desk-team-lead',
  'desk-backend-engineer',
  'desk-ui-ux-expert',
  'desk-data-engineer',
  'desk-project-manager',
  'desk-market-researcher',
  'desk-agent-organizer',
  'cafe-seat-1',
  'cafe-seat-2',
  'cafe-seat-3',
  'cafe-seat-4',
  'cafe-stand-coffee',
  'cafe-stand-vending',
];

test('requiredAnchors covers seats, café, entrance and zones', () => {
  const req = requiredAnchors({
    primarySeatNames: ['desk-ceo', 'pc-1'],
    cafeSeatNames: ['cafe-seat-1'],
    cafeStands: [['cafe-stand-coffee', 'coffee']],
  });
  assert.deepEqual(req, [
    'entrance',
    'boardroom',
    'cafeteria',
    'desk-ceo',
    'pc-1',
    'cafe-seat-1',
    'cafe-stand-coffee',
  ]);
});

test('both real maps carry every required anchor; a sabotaged map is refused', () => {
  for (const map of [
    'src/renderer/src/assets/maps/office.tmj',
    'src/renderer/src/assets/maps/custom.tmj',
  ]) {
    const raw = read(map);
    assert.deepEqual(missingAnchors(raw, OFFICE_REQUIRED), [], `${map} passes the guard`);
    // every name the guard wants is a real object in the map
    const names = new Set(mapObjectNames(raw));
    for (const n of OFFICE_REQUIRED) assert.ok(names.has(n), `${map} carries ${n}`);
  }

  // Operator deletes the god desk in Tiled → the guard names it and refuses.
  const m = JSON.parse(read('src/renderer/src/assets/maps/custom.tmj'));
  const sp = m.layers.find((l) => l.type === 'objectgroup' && l.name === 'spawn-points');
  sp.objects = sp.objects.filter((o) => o.name !== 'desk-ceo');
  const missing = missingAnchors(JSON.stringify(m), OFFICE_REQUIRED);
  assert.deepEqual(missing, ['desk-ceo'], 'broken map is refused with the missing name');

  // Unparseable map → everything missing (refuse), never an unguarded switch.
  assert.equal(missingAnchors('not json', OFFICE_REQUIRED).length, OFFICE_REQUIRED.length);
});

test('switchPreservesAgents: flag + cast + seats all gate the preserve path', () => {
  const cast = { jim: {}, pam: {} };
  const base = {
    preservesAgents: true,
    liveCharacters: ['jim', 'pam'],
    castByName: cast,
    liveWorkers: 2,
    workerSeats: 15,
  };
  assert.equal(switchPreservesAgents(base), true, 'flag + cast + seats ⇒ preserve');
  assert.equal(
    switchPreservesAgents({ ...base, preservesAgents: false }),
    false,
    'show themes stay destructive',
  );
  assert.equal(
    switchPreservesAgents({ ...base, liveCharacters: ['jim', 'michael'] }),
    false,
    'unresolvable character ⇒ destructive',
  );
  assert.equal(
    switchPreservesAgents({ ...base, liveWorkers: 16 }),
    false,
    'more workers than seats ⇒ destructive',
  );
  assert.equal(
    switchPreservesAgents({ ...base, liveWorkers: 0 }),
    true,
    'god-only floor preserves trivially',
  );
});

test('registry + picker wiring pins (custom theme, preserve-before-teardown, no modal)', () => {
  const reg = read('src/renderer/src/scene/office/themeRegistry.ts');
  assert.match(
    reg,
    /id: 'custom',\s*mapRaw: customMapRaw,\s*preservesAgents: true,/,
    'custom theme opts into the preserve switch',
  );
  assert.match(reg, /firstgid: 2449/, 'revamped office atlas appended after the office gids');
  assert.match(reg, /firstgid: 3297/, 'room builder atlas appended after the revamped gids');
  assert.match(reg, /custom: CUSTOM_THEME,/, 'custom is registered');

  const picker = read('src/renderer/src/components/OfficeThemePicker.tsx');
  // preservesAgents targets skip the destructive confirm modal entirely.
  assert.match(
    picker,
    /if \(getTheme\(id\)\.preservesAgents\) \{\s*void applyTheme\(id\);\s*return;\s*\}/,
    'non-destructive target applies without the confirm modal',
  );
  // The preserve branch guards the map, then persists + rebuilds — and lives
  // BEFORE any killPty teardown in applyTheme.
  const preserve = picker.indexOf('switchPreservesAgents({');
  const guard = picker.indexOf('missingAnchors(theme.mapRaw, requiredAnchors(theme))');
  const persist = picker.indexOf(
    'setOfficeTheme(id); // → OfficeFloor rebuilds and re-seats the live roster',
  );
  const teardown = picker.indexOf('window.cth.killPty');
  assert.ok(
    preserve !== -1 && guard !== -1 && persist !== -1 && teardown !== -1,
    'all anchors present',
  );
  assert.ok(
    preserve < guard && guard < persist && persist < teardown,
    'guard → persist runs before the destructive teardown',
  );
});
