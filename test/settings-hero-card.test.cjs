'use strict';

/**
 * Settings hero card (card agent-settings-hero-card-port--2026-08-18): the
 * SHAPE ported from upstream 1b821b3 by intent — prominent card at the top of
 * Settings → General — with the remote-fetch delivery mechanism deliberately
 * DROPPED (no fetchText, no hero.json over the wire, no payload validator:
 * one operator, one box, no publisher). The card is a reusable slot that
 * takes its fields as props; contents are a PLACEHOLDER (god engine, helper
 * engine, floor occupancy, live checkout sha) until the operator decides.
 *
 * This file pins the LOGIC the card carries:
 *  - shared/settingsHero.ts: row building, engine resolution (mirroring
 *    SettingsModal's chains), floor occupancy (mirroring main's floorCensus
 *    + normalizeFloorMaxAgents — equality-tested against the REAL functions,
 *    not just re-asserted), sha shortening, missing-data fallbacks;
 *  - the wiring: preload exposes headSha, SettingsModal renders the card at
 *    the top of General, the card is props-driven and fetch-free.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const repoRoot = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(repoRoot, p), 'utf8');

const { heroRows, shortSha } = loadTs('src/shared/settingsHero.ts');
const { floorCensus } = loadTs('src/main/hive.ts');
const { normalizeFloorMaxAgents } = loadTs('src/main/config.ts');

const CONFIG = (over = {}) => ({
  godProvider: 'claude',
  godModel: 'opus-4',
  floorMaxAgents: 16,
  ...over,
});
const REGISTRY = (agents, godId = 'god') => ({ godId, agents });

// ── shortSha ─────────────────────────────────────────────────────────────

test('shortSha: 7 chars, tolerant of null/junk input', () => {
  assert.equal(shortSha('1c27401111111111111111111111111111111111'), '1c27401');
  assert.equal(shortSha(null), null);
  assert.equal(shortSha(''), null);
  assert.equal(shortSha('nothex!'), null);
});

// ── engine rows ──────────────────────────────────────────────────────────

test('god + helper engine rows resolve the documented chains', () => {
  const rows = heroRows({
    config: CONFIG(),
    registry: REGISTRY({ god: { id: 'god', isGod: true } }),
    version: '0.4.3',
    headSha: '1c27401111111111111111111111111111111111',
  });
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));

  assert.match(byLabel['god engine'], /claude/i);
  assert.match(byLabel['god engine'], /opus-4/, 'model rides the row');

  // helper chain: helperDefaults.provider > godProvider > 'claude'
  assert.match(byLabel['helper engine'], /claude/i, 'no helperDefaults → god engine');
  const rows2 = heroRows({
    config: CONFIG({ helperDefaults: { provider: 'pi', model: 'gpt-5.6-sol' } }),
    registry: REGISTRY({ god: { id: 'god', isGod: true } }),
    version: '0.4.3',
    headSha: null,
  });
  const byLabel2 = Object.fromEntries(rows2.map((r) => [r.label, r.value]));
  assert.match(byLabel2['helper engine'], /pi/i);
  assert.match(byLabel2['helper engine'], /gpt-5\.6-sol/);
});

// ── floor occupancy: equality with MAIN's own functions ─────────────────

test('floor occupancy row agrees with main floorCensus + normalizeFloorMaxAgents across shapes', () => {
  const shapes = [
    { god: { id: 'god', isGod: true } },
    { god: { id: 'god', isGod: true }, w1: { id: 'w1' }, w2: { id: 'w2' } },
    { god: { id: 'god', isGod: true }, parked: { id: 'parked', vacation: true } },
    { god: { id: 'god', isGod: true }, gone: { id: 'gone', archived: true } },
    { god: { id: 'god', isGod: true }, fired: { id: 'fired', retired: true } },
    { god: { id: 'god', isGod: true }, a: {}, b: {}, c: {}, d: {} },
  ];
  for (const caps of [undefined, 4, 16, 1]) {
    for (const shape of shapes) {
      const reg = REGISTRY(shape);
      const rows = heroRows({
        config: CONFIG(caps === undefined ? {} : { floorMaxAgents: caps }),
        registry: reg,
        version: '0.4.3',
        headSha: null,
      });
      const row = rows.find((r) => r.label === 'floor').value;
      const want = `${floorCensus(reg)}/${normalizeFloorMaxAgents(caps)} seats`;
      assert.equal(row, want, `cap=${caps} shape=${Object.keys(shape).join('+')}`);
    }
  }
});

test('floor row says FULL at zero free seats, free count otherwise', () => {
  const full = heroRows({
    config: CONFIG({ floorMaxAgents: 2 }),
    registry: REGISTRY({ god: { id: 'god', isGod: true }, a: {}, b: {} }),
    version: '0.4.3',
    headSha: null,
  }).find((r) => r.label === 'floor');
  assert.match(full.value, /2\/2 seats/);
  assert.match(full.hint ?? '', /full/i);

  const free = heroRows({
    config: CONFIG({ floorMaxAgents: 16 }),
    registry: REGISTRY({ god: { id: 'god', isGod: true }, a: {} }),
    version: '0.4.3',
    headSha: null,
  }).find((r) => r.label === 'floor');
  assert.match(free.hint ?? '', /15 free/);
});

// ── identity + fallbacks ─────────────────────────────────────────────────

test('version and sha rows; every unknown value renders a dash, never crashes', () => {
  const rows = heroRows({ config: CONFIG(), registry: REGISTRY({}), version: null, headSha: null });
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
  assert.equal(byLabel['version'], '—');
  assert.equal(byLabel['live checkout'], '—');

  const ok = heroRows({
    config: CONFIG(),
    registry: REGISTRY({ god: { id: 'god', isGod: true } }),
    version: '0.4.3',
    headSha: 'ba7b4d9111111111111111111111111111111111',
  });
  const byLabel3 = Object.fromEntries(ok.map((r) => [r.label, r.value]));
  assert.equal(byLabel3['version'], '0.4.3');
  assert.equal(byLabel3['live checkout'], 'ba7b4d9');
});

test('junk config/registry shapes degrade to dashes instead of throwing', () => {
  for (const bad of [null, undefined, {}, { agents: null }, { agents: 'x' }]) {
    const rows = heroRows({ config: CONFIG(), registry: bad, version: '1', headSha: null });
    assert.ok(Array.isArray(rows) && rows.length > 0);
    assert.equal(rows.find((r) => r.label === 'floor').value, '—');
  }
});

// ── the wiring (fetch-free card, props-driven) ───────────────────────────

test('the card component is props-driven and fetch-free; no hero.json/fetchText anywhere', () => {
  const card = read('src/renderer/src/components/SettingsHeroCard.tsx');
  assert.match(card, /interface SettingsHeroCardProps/, 'takes fields as props');
  for (const banned of ['fetch(', 'heroPayload', 'hero.json', 'fetchText', 'useEffect']) {
    assert.ok(
      !card.includes(banned),
      `card must not contain ${banned} — no remote fetch, no self-fetching`,
    );
  }
  assert.ok(!fs.existsSync(path.join(repoRoot, 'src/main/fetchText.ts')), 'fetchText not ported');
  assert.ok(
    !fs.existsSync(path.join(repoRoot, 'src/shared/heroPayload.ts')),
    'heroPayload not ported',
  );
  assert.ok(!fs.existsSync(path.join(repoRoot, 'src/main/hero.ts')), 'hero main module not ported');
});

test('SettingsModal renders the card at the TOP of General, above UpdatesSection', () => {
  const modal = read('src/renderer/src/components/SettingsModal.tsx');
  const generalAt = modal.indexOf("activeSection === 'General'");
  const cardAt = modal.indexOf('<SettingsHeroCard');
  const updatesAt = modal.indexOf('<UpdatesSection');
  assert.ok(generalAt > 0, 'General section exists');
  assert.ok(cardAt > generalAt, 'card inside General');
  assert.ok(updatesAt > cardAt, 'card ABOVE UpdatesSection (the ported slot)');
});

test('preload + main expose headSha read-only; card data has no other new IPC', () => {
  assert.match(read('src/preload/index.ts'), /headSha/, 'preload exposes headSha');
  const idx = read('src/main/index.ts');
  assert.match(idx, /'app:headSha'/, 'main handles app:headSha');
  assert.match(idx, /getHead\(app\.getAppPath\(\)\)/, 'the sha is the LIVE checkout head');
});
